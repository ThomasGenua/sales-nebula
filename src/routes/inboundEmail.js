const { Router } = require('express');
const crypto = require('crypto');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();

const ENC_KEY = crypto
  .createHash('sha256')
  .update(process.env.MAIL_SECRET || process.env.JWT_SECRET || 'sales-nebula-mail-key')
  .digest();

/** Encrypt a mailbox password at rest. Never store the plaintext. */
function encrypt(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(payload) {
  if (!payload || !payload.includes(':')) return null;
  try {
    const [iv, tag, data] = payload.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch { return null; }
}

/** Strip an account payload of its secret before returning it. */
function safeAccount(account) {
  const { password, ...rest } = account;
  return { ...rest, passwordSet: !!password };
}

/** Pull a plain address out of "Display Name <addr@host>". */
function parseAddress(raw) {
  if (!raw) return { name: null, email: null };
  const angled = String(raw).match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (angled) return { name: angled[1].trim() || null, email: angled[2].trim().toLowerCase() };
  const bare = String(raw).trim().toLowerCase();
  return { name: null, email: /^[^\s@]+@[^\s@]+$/.test(bare) ? bare : null };
}

/** Normalize a subject for threading: drop Re:, Fwd:, and ticket tags. */
function normalizeSubject(subject) {
  return String(subject || '')
    .replace(/^\s*((re|fw|fwd|aw|sv|vs|antwort)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .replace(/\[\s*(case|ticket|ref)[\s#:-]*([\w-]+)\s*\]/gi, '')
    .trim();
}

/** Extract a case number from a subject tag or body reference. */
function extractCaseRef(subject, body) {
  const fromSubject = String(subject || '').match(/\[\s*(?:case|ticket|ref)[\s#:-]*([\w-]+)\s*\]/i);
  if (fromSubject) return fromSubject[1];
  const fromBody = String(body || '').match(/(?:case|ticket)\s*#\s*([\w-]+)/i);
  return fromBody ? fromBody[1] : null;
}

/** Trim quoted history so a reply does not re-append the whole thread. */
function stripQuotedReply(body) {
  if (!body) return '';
  const markers = [
    /^\s*On .+ wrote:\s*$/m,
    /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/im,
    /^\s*_{10,}\s*$/m,
    /^\s*From:\s*.+$/m,
  ];
  let cut = String(body).length;
  for (const m of markers) {
    const match = String(body).match(m);
    if (match && match.index !== undefined && match.index < cut) cut = match.index;
  }
  return String(body).slice(0, cut).replace(/(\r?\n\s*>.*)+$/g, '').trim();
}

/** Decide whether a sender passes the account's allow and block lists. */
function senderAllowed(account, email) {
  if (!email) return false;
  const lower = email.toLowerCase();
  const listed = raw => String(raw || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  const blocked = listed(account.blockedSenders);
  if (blocked.some(b => (b.startsWith('@') ? lower.endsWith(b) : lower === b))) return false;

  const allowed = listed(account.allowedSenders);
  if (!allowed.length) return true;
  return allowed.some(a => (a.startsWith('@') ? lower.endsWith(a) : lower === a));
}

/** Auto-reply and bounce headers that must never create a ticket. */
function isAutomatedMessage(message) {
  const headers = message.headers || {};
  if (headers['auto-submitted'] && headers['auto-submitted'] !== 'no') return true;
  if (headers['x-autoreply'] || headers['x-autorespond'] || headers['precedence'] === 'bulk') return true;
  const from = String(message.fromEmail || '').toLowerCase();
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce)/.test(from.split('@')[0] || '')) return true;
  return /^(out of office|automatic reply|undeliverable|delivery status notification)/i.test(String(message.subject || ''));
}

// ── ACCOUNTS ──────────────────────────────────────────────────────────

router.get('/accounts', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const accounts = await prisma.inboundEmailAccount.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } });
    res.json(accounts.map(safeAccount));
  } catch (err) { next(err); }
});

router.get('/accounts/:id', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const account = await prisma.inboundEmailAccount.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const [messageCount, recentPolls] = await Promise.all([
      prisma.inboundEmailMessage.count({ where: { accountId: account.id } }),
      prisma.emailPollLog.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    res.json({ ...safeAccount(account), messageCount, recentPolls });
  } catch (err) { next(err); }
});

router.post('/accounts', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, protocol, host, port, username, password, useTls, mailbox, pollIntervalMinutes,
      autoCreateCase, autoCreateLead, defaultOwnerId, defaultCaseType, defaultPriority,
      allowedSenders, blockedSenders, markSeen, deleteAfterImport, maxMessagesPerPoll } = req.body;

    if (!name) return res.status(400).json({ error: 'name required' });
    if (!host) return res.status(400).json({ error: 'host required' });
    if (!username) return res.status(400).json({ error: 'username required' });
    if (!password) return res.status(400).json({ error: 'password required' });
    if (protocol && !['imap', 'pop3'].includes(protocol)) return res.status(400).json({ error: 'protocol must be imap or pop3' });
    if (port && (port < 1 || port > 65535)) return res.status(400).json({ error: 'port must be between 1 and 65535' });
    if (pollIntervalMinutes != null && +pollIntervalMinutes < 1) return res.status(400).json({ error: 'pollIntervalMinutes must be at least 1' });

    const account = await prisma.inboundEmailAccount.create({
      data: {
        name, protocol: protocol || 'imap', host,
        port: port ? +port : (protocol === 'pop3' ? 995 : 993),
        username, password: encrypt(password),
        useTls: useTls !== false, mailbox: mailbox || 'INBOX',
        pollIntervalMinutes: pollIntervalMinutes ? +pollIntervalMinutes : 5,
        autoCreateCase: autoCreateCase !== false, autoCreateLead: !!autoCreateLead,
        defaultOwnerId, defaultCaseType, defaultPriority: defaultPriority || 'Medium',
        allowedSenders, blockedSenders,
        markSeen: markSeen !== false, deleteAfterImport: !!deleteAfterImport,
        maxMessagesPerPoll: maxMessagesPerPoll ? +maxMessagesPerPoll : 50,
      },
    });

    await req.audit({ action: 'create', module: 'inboundEmail', recordId: account.id, details: `Inbound email account created: ${name}` });
    res.status(201).json(safeAccount(account));
  } catch (err) { next(err); }
});

router.put('/accounts/:id', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { id, createdAt, passwordSet, messageCount, recentPolls, ...data } = req.body;
    // Only re-encrypt when a new password was actually supplied
    if (data.password) data.password = encrypt(data.password);
    else delete data.password;
    if (data.protocol && !['imap', 'pop3'].includes(data.protocol)) return res.status(400).json({ error: 'protocol must be imap or pop3' });

    const account = await prisma.inboundEmailAccount.update({ where: { id: req.params.id }, data });
    await req.audit({ action: 'update', module: 'inboundEmail', recordId: account.id, details: `Account updated: ${account.name}` });
    res.json(safeAccount(account));
  } catch (err) { next(err); }
});

router.delete('/accounts/:id', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.inboundEmailAccount.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), active: false, status: 'Disabled' } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// Validate settings without storing a broken account
router.post('/accounts/:id/test', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const account = await prisma.inboundEmailAccount.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const checks = [];
    checks.push({ check: 'host', pass: !!account.host, detail: account.host });
    checks.push({ check: 'port', pass: account.port > 0 && account.port < 65536, detail: String(account.port) });
    checks.push({ check: 'credentials stored', pass: !!decrypt(account.password), detail: decrypt(account.password) ? 'password decrypts correctly' : 'password could not be decrypted' });
    checks.push({ check: 'tls', pass: account.useTls, detail: account.useTls ? 'enabled' : 'disabled, which sends credentials in the clear' });
    checks.push({ check: 'standard port for protocol', pass: (account.protocol === 'imap' && [143, 993].includes(account.port)) || (account.protocol === 'pop3' && [110, 995].includes(account.port)), detail: `${account.protocol} on port ${account.port}` });

    const passed = checks.filter(c => c.pass).length;
    await prisma.inboundEmailAccount.update({
      where: { id: account.id },
      data: { status: passed === checks.length ? 'Idle' : 'Error', lastError: passed === checks.length ? null : 'Configuration check failed' },
    });

    res.json({
      configurationValid: passed === checks.length,
      passed, total: checks.length, checks,
      note: 'This validates stored configuration. A live connection is attempted on the next poll.',
    });
  } catch (err) { next(err); }
});

// ── POLLING ───────────────────────────────────────────────────────────

/**
 * Ingest messages for an account. Messages are supplied in the request
 * body by the mail worker, so this endpoint owns routing and dedup
 * while the transport stays outside the API process.
 */
router.post('/accounts/:id/poll', authenticate, auditMiddleware, async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const prisma = req.app.locals.prisma;
    const account = await prisma.inboundEmailAccount.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (!account.active) return res.status(400).json({ error: 'Account is inactive' });

    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    if (!messages.length) return res.status(400).json({ error: 'messages array required' });
    if (messages.length > account.maxMessagesPerPoll) {
      return res.status(400).json({ error: `Batch exceeds maxMessagesPerPoll (${account.maxMessagesPerPoll})` });
    }

    await prisma.inboundEmailAccount.update({ where: { id: account.id }, data: { status: 'Polling' } });

    let fetched = 0, processed = 0, skipped = 0, casesCreated = 0, leadsCreated = 0, repliesLinked = 0, errors = 0;
    const results = [];

    for (const raw of messages) {
      fetched++;
      try {
        const from = parseAddress(raw.from || raw.fromEmail);
        const subject = raw.subject || '(no subject)';
        const bodyText = stripQuotedReply(raw.text || raw.body || '');

        // Dedup on Message-ID
        if (raw.messageId) {
          const dupe = await prisma.inboundEmailMessage.findFirst({ where: { accountId: account.id, messageId: raw.messageId } });
          if (dupe) { skipped++; results.push({ subject, action: 'skipped', reason: 'duplicate message id' }); continue; }
        }

        if (!senderAllowed(account, from.email)) {
          skipped++; results.push({ subject, action: 'skipped', reason: 'sender not permitted' }); continue;
        }

        const automated = isAutomatedMessage({ ...raw, fromEmail: from.email, subject });

        const stored = await prisma.inboundEmailMessage.create({
          data: {
            accountId: account.id, uid: raw.uid ? +raw.uid : null,
            messageId: raw.messageId || null, inReplyTo: raw.inReplyTo || null,
            references: Array.isArray(raw.references) ? raw.references.join(' ') : (raw.references || null),
            fromEmail: from.email, fromName: from.name,
            toEmail: raw.to || null, ccEmail: raw.cc || null,
            subject, normalizedSubject: normalizeSubject(subject),
            bodyText, bodyHtml: raw.html || null,
            receivedAt: raw.date ? new Date(raw.date) : new Date(),
            hasAttachments: !!(raw.attachments?.length),
            attachmentCount: raw.attachments?.length || 0,
            isAutomated: automated,
            status: 'Received',
          },
        }).catch(async () => {
          // Model shape may differ; store the minimum viable record
          return prisma.inboundEmailMessage.create({
            data: { accountId: account.id, messageId: raw.messageId || null, subject, status: 'Received' },
          });
        });

        if (automated) {
          await prisma.inboundEmailMessage.update({ where: { id: stored.id }, data: { status: 'Ignored' } }).catch(() => {});
          skipped++; results.push({ subject, action: 'ignored', reason: 'automated message' }); continue;
        }

        // Reply to an existing case, matched by ref tag then by thread
        const caseRef = extractCaseRef(subject, bodyText);
        let linkedCase = null;
        if (caseRef) {
          linkedCase = await prisma.case.findFirst({ where: { caseNumber: caseRef, deletedAt: null } });
        }
        if (!linkedCase && raw.inReplyTo) {
          const prior = await prisma.inboundEmailMessage.findFirst({ where: { messageId: raw.inReplyTo }, select: { caseId: true } }).catch(() => null);
          if (prior?.caseId) linkedCase = await prisma.case.findFirst({ where: { id: prior.caseId, deletedAt: null } });
        }
        if (!linkedCase && from.email) {
          const normalized = normalizeSubject(subject);
          if (normalized) {
            linkedCase = await prisma.case.findFirst({
              where: { deletedAt: null, contactEmail: from.email, subject: { contains: normalized.slice(0, 60), mode: 'insensitive' }, status: { notIn: ['Closed', 'Rejected'] } },
              orderBy: { createdAt: 'desc' },
            });
          }
        }

        if (linkedCase) {
          await prisma.case.update({
            where: { id: linkedCase.id },
            data: {
              emailCount: { increment: 1 }, lastEmailAt: new Date(),
              lastEmailMessageId: raw.messageId || null,
              ...(linkedCase.status === 'Closed' && { status: 'Reopened' }),
            },
          }).catch(() => {});
          await prisma.inboundEmailMessage.update({ where: { id: stored.id }, data: { caseId: linkedCase.id, status: 'Linked' } }).catch(() => {});
          repliesLinked++; processed++;
          results.push({ subject, action: 'linked', caseId: linkedCase.id, caseNumber: linkedCase.caseNumber });
          continue;
        }

        // Route by rule before falling back to the account default
        const rules = await prisma.inboundRoutingRule.findMany({ where: { accountId: account.id, active: true }, orderBy: { priority: 'asc' } }).catch(() => []);
        let routed = null;
        for (const rule of rules) {
          const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
          const haystack = { subject, from: from.email || '', body: bodyText, to: raw.to || '' };
          const matches = conditions.length && conditions.every(c => {
            const value = String(haystack[c.field] ?? '').toLowerCase();
            const target = String(c.value ?? '').toLowerCase();
            if (c.operator === 'contains') return value.includes(target);
            if (c.operator === 'equals') return value === target;
            if (c.operator === 'startsWith') return value.startsWith(target);
            if (c.operator === 'endsWith') return value.endsWith(target);
            if (c.operator === 'matches') { try { return new RegExp(c.value, 'i').test(value); } catch { return false; } }
            return false;
          });
          if (matches) { routed = rule; break; }
        }

        if (account.autoCreateCase) {
          const contact = from.email ? await prisma.contact.findFirst({ where: { email: from.email, deletedAt: null } }) : null;
          const newCase = await prisma.case.create({
            data: {
              subject: subject.slice(0, 250),
              description: bodyText.slice(0, 8000),
              status: 'New',
              priority: routed?.setPriority || account.defaultPriority || 'Medium',
              type: routed?.setType || account.defaultCaseType || null,
              origin: 'Email',
              ownerId: routed?.assignToUserId || account.defaultOwnerId || null,
              contactId: contact?.id || null,
              accountId: contact?.accountId || null,
              contactEmail: from.email,
              emailCount: 1, lastEmailAt: new Date(),
              lastEmailMessageId: raw.messageId || null,
            },
          });
          await prisma.inboundEmailMessage.update({ where: { id: stored.id }, data: { caseId: newCase.id, status: 'Converted' } }).catch(() => {});
          casesCreated++; processed++;
          results.push({ subject, action: 'case created', caseId: newCase.id, matchedRule: routed?.name || null });
          continue;
        }

        if (account.autoCreateLead && from.email) {
          const existingLead = await prisma.lead.findFirst({ where: { email: from.email, deletedAt: null } });
          if (!existingLead) {
            const [first, ...rest] = (from.name || from.email.split('@')[0]).split(' ');
            const lead = await prisma.lead.create({
              data: {
                firstName: first, lastName: rest.join(' ') || first,
                email: from.email, leadSource: 'Email',
                status: 'New', description: bodyText.slice(0, 4000),
                ownerId: account.defaultOwnerId || null,
              },
            });
            await prisma.inboundEmailMessage.update({ where: { id: stored.id }, data: { leadId: lead.id, status: 'Converted' } }).catch(() => {});
            leadsCreated++; processed++;
            results.push({ subject, action: 'lead created', leadId: lead.id });
            continue;
          }
        }

        await prisma.inboundEmailMessage.update({ where: { id: stored.id }, data: { status: 'Unprocessed' } }).catch(() => {});
        processed++;
        results.push({ subject, action: 'stored', reason: 'no routing target configured' });
      } catch (e) {
        errors++;
        results.push({ subject: raw.subject || '(unknown)', action: 'error', reason: String(e.message).slice(0, 160) });
      }
    }

    const highestUid = messages.reduce((m, x) => Math.max(m, +x.uid || 0), account.lastUid || 0);
    await prisma.inboundEmailAccount.update({
      where: { id: account.id },
      data: { status: errors ? 'Error' : 'Idle', lastPolledAt: new Date(), lastUid: highestUid, lastError: errors ? `${errors} messages failed` : null },
    });
    await prisma.emailPollLog.create({
      data: {
        accountId: account.id, messagesFetched: fetched, messagesProcessed: processed,
        casesCreated, leadsCreated, errorCount: errors,
        status: errors ? 'Completed with errors' : 'Completed',
      },
    }).catch(() => {});

    await req.audit({ action: 'create', module: 'inboundEmail', recordId: account.id, details: `Poll: ${processed} processed, ${casesCreated} cases, ${repliesLinked} replies linked` });

    res.json({ accountId: account.id, durationMs: Date.now() - startedAt, fetched, processed, skipped, casesCreated, leadsCreated, repliesLinked, errors, results });
  } catch (err) { next(err); }
});

// Accounts whose poll interval has elapsed
router.get('/accounts/due/poll', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const accounts = await prisma.inboundEmailAccount.findMany({ where: { deletedAt: null, active: true, status: { not: 'Disabled' } } });
    const now = Date.now();
    const due = accounts.filter(a => !a.lastPolledAt || (now - new Date(a.lastPolledAt).getTime()) >= a.pollIntervalMinutes * 60000);
    res.json({
      total: accounts.length, due: due.length,
      accounts: due.map(a => ({ id: a.id, name: a.name, protocol: a.protocol, host: a.host, port: a.port, username: a.username, mailbox: a.mailbox, useTls: a.useTls, lastUid: a.lastUid, maxMessagesPerPoll: a.maxMessagesPerPoll, secret: decrypt(a.password) })),
    });
  } catch (err) { next(err); }
});

// ── MESSAGES ──────────────────────────────────────────────────────────

router.get('/messages', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { accountId, status, search, page = 1, limit = 50 } = req.query;
    const where = {};
    if (accountId) where.accountId = accountId;
    if (status) where.status = status;
    if (search) where.OR = [{ subject: { contains: search, mode: 'insensitive' } }, { fromEmail: { contains: search, mode: 'insensitive' } }];

    const [data, total] = await Promise.all([
      prisma.inboundEmailMessage.findMany({ where, skip: (+page - 1) * +limit, take: +limit, orderBy: { receivedAt: 'desc' } }),
      prisma.inboundEmailMessage.count({ where }),
    ]);
    res.json({ data, total, page: +page, limit: +limit });
  } catch (err) { next(err); }
});

router.post('/messages/:id/convert', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { target } = req.body;
    if (!['case', 'lead'].includes(target)) return res.status(400).json({ error: 'target must be case or lead' });

    const message = await prisma.inboundEmailMessage.findUnique({ where: { id: req.params.id } });
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (message.caseId || message.leadId) return res.status(409).json({ error: 'Message has already been converted' });

    if (target === 'case') {
      const contact = message.fromEmail ? await prisma.contact.findFirst({ where: { email: message.fromEmail, deletedAt: null } }) : null;
      const created = await prisma.case.create({
        data: {
          subject: (message.subject || 'Email enquiry').slice(0, 250),
          description: (message.bodyText || '').slice(0, 8000),
          status: 'New', priority: req.body.priority || 'Medium', origin: 'Email',
          ownerId: req.body.ownerId || req.user.id,
          contactId: contact?.id || null, accountId: contact?.accountId || null,
          contactEmail: message.fromEmail,
        },
      });
      await prisma.inboundEmailMessage.update({ where: { id: message.id }, data: { caseId: created.id, status: 'Converted' } });
      await req.audit({ action: 'create', module: 'inboundEmail', recordId: created.id, details: 'Email converted to case' });
      return res.status(201).json({ target: 'case', record: created });
    }

    const [first, ...rest] = (message.fromName || (message.fromEmail || '').split('@')[0] || 'Unknown').split(' ');
    const lead = await prisma.lead.create({
      data: {
        firstName: first, lastName: rest.join(' ') || first,
        email: message.fromEmail, leadSource: 'Email', status: 'New',
        description: (message.bodyText || '').slice(0, 4000),
        ownerId: req.body.ownerId || req.user.id,
      },
    });
    await prisma.inboundEmailMessage.update({ where: { id: message.id }, data: { leadId: lead.id, status: 'Converted' } });
    res.status(201).json({ target: 'lead', record: lead });
  } catch (err) { next(err); }
});

router.post('/messages/:id/ignore', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const message = await prisma.inboundEmailMessage.update({ where: { id: req.params.id }, data: { status: 'Ignored' } });
    res.json(message);
  } catch (err) { next(err); }
});

// ── ROUTING RULES ─────────────────────────────────────────────────────

router.get('/rules', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const where = {};
    if (req.query.accountId) where.accountId = req.query.accountId;
    const rules = await prisma.inboundRoutingRule.findMany({ where, orderBy: { priority: 'asc' } });
    res.json(rules);
  } catch (err) { next(err); }
});

router.post('/rules', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, accountId, conditions, assignToUserId, setPriority, setType, setStatus, priority, active } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!Array.isArray(conditions) || !conditions.length) return res.status(400).json({ error: 'conditions array required' });

    const validFields = ['subject', 'from', 'to', 'body'];
    const validOps = ['contains', 'equals', 'startsWith', 'endsWith', 'matches'];
    for (const c of conditions) {
      if (!validFields.includes(c.field)) return res.status(400).json({ error: `condition field must be one of: ${validFields.join(', ')}` });
      if (!validOps.includes(c.operator)) return res.status(400).json({ error: `condition operator must be one of: ${validOps.join(', ')}` });
      if (c.operator === 'matches') { try { new RegExp(c.value); } catch { return res.status(400).json({ error: `Invalid regular expression: ${c.value}` }); } }
    }

    const rule = await prisma.inboundRoutingRule.create({
      data: { name, accountId: accountId || null, conditions, assignToUserId, setPriority, setType, setStatus, priority: priority ?? 0, active: active !== false },
    });
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

router.put('/rules/:id', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { id, createdAt, ...data } = req.body;
    res.json(await prisma.inboundRoutingRule.update({ where: { id: req.params.id }, data }));
  } catch (err) { next(err); }
});

router.delete('/rules/:id', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    await req.app.locals.prisma.inboundRoutingRule.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// Preview which rule a sample message would hit
router.post('/rules/test', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { subject = '', from = '', body = '', to = '', accountId } = req.body;
    const where = { active: true };
    if (accountId) where.accountId = accountId;
    const rules = await prisma.inboundRoutingRule.findMany({ where, orderBy: { priority: 'asc' } });

    const haystack = { subject: subject.toLowerCase(), from: from.toLowerCase(), body: body.toLowerCase(), to: to.toLowerCase() };
    const evaluated = rules.map(rule => {
      const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
      const matched = conditions.length > 0 && conditions.every(c => {
        const value = haystack[c.field] ?? '';
        const target = String(c.value ?? '').toLowerCase();
        if (c.operator === 'contains') return value.includes(target);
        if (c.operator === 'equals') return value === target;
        if (c.operator === 'startsWith') return value.startsWith(target);
        if (c.operator === 'endsWith') return value.endsWith(target);
        if (c.operator === 'matches') { try { return new RegExp(c.value, 'i').test(value); } catch { return false; } }
        return false;
      });
      return { ruleId: rule.id, name: rule.name, priority: rule.priority, matched };
    });

    const winner = evaluated.find(e => e.matched) || null;
    res.json({
      rulesEvaluated: rules.length, winner, evaluated,
      derived: { normalizedSubject: normalizeSubject(subject), caseRef: extractCaseRef(subject, body), strippedBody: stripQuotedReply(body).slice(0, 200) },
    });
  } catch (err) { next(err); }
});

// ── ANALYTICS ─────────────────────────────────────────────────────────

router.get('/analytics', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const days = parseInt(req.query.days, 10) || 30;
    const since = new Date(Date.now() - days * 86400000);

    const [accounts, logs, messages] = await Promise.all([
      prisma.inboundEmailAccount.findMany({ where: { deletedAt: null }, select: { id: true, name: true, status: true, lastPolledAt: true, lastError: true, active: true } }),
      prisma.emailPollLog.findMany({ where: { createdAt: { gte: since } }, take: 5000 }),
      prisma.inboundEmailMessage.findMany({ where: { createdAt: { gte: since } }, select: { status: true, isAutomated: true, caseId: true, leadId: true }, take: 10000 }),
    ]);

    res.json({
      periodDays: days,
      accounts: accounts.length,
      activeAccounts: accounts.filter(a => a.active).length,
      accountsInError: accounts.filter(a => a.status === 'Error').map(a => ({ id: a.id, name: a.name, lastError: a.lastError })),
      totalPolls: logs.length,
      messagesFetched: logs.reduce((s, l) => s + l.messagesFetched, 0),
      messagesProcessed: logs.reduce((s, l) => s + l.messagesProcessed, 0),
      casesCreated: logs.reduce((s, l) => s + l.casesCreated, 0),
      leadsCreated: logs.reduce((s, l) => s + l.leadsCreated, 0),
      pollErrors: logs.reduce((s, l) => s + l.errorCount, 0),
      automatedFiltered: messages.filter(m => m.isAutomated).length,
      conversionRate: messages.length ? +((messages.filter(m => m.caseId || m.leadId).length / messages.length) * 100).toFixed(1) : 0,
      byStatus: messages.reduce((a, m) => { a[m.status] = (a[m.status] || 0) + 1; return a; }, {}),
    });
  } catch (err) { next(err); }
});

module.exports = router;
