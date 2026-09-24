const { Router } = require('express');
const crypto = require('crypto');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { encrypt, decrypt } = require('../utils/secretBox');
const { createNumbered, CASE_NUMBER } = require('../utils/numbering');
const { pickModelFields, columnsFrom } = require('../utils/modelFields');
const {
  ingestMessages, recordPoll,
  normalizeSubject, extractCaseRef, stripQuotedReply,
} = require('../services/inboundIngest');
const graphMailbox = require('../services/graphMailbox');
const { MAIL_SCOPES } = require('../services/microsoftGraph');

const router = Router();

/** Strip an account payload of its secret before returning it. */
function safeAccount(account) {
  const { password, oauthAccessToken, oauthRefreshToken, ...rest } = account;
  return {
    ...rest,
    passwordSet: !!password,
    oauthConnected: !!oauthRefreshToken,
  };
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
      prisma.emailPollLog.findMany({ where: { accountId: account.id }, orderBy: { startedAt: 'desc' }, take: 10 }),
    ]);
    res.json({ ...safeAccount(account), messageCount, recentPolls });
  } catch (err) { next(err); }
});

router.post('/accounts', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, provider, protocol, host, port, username, password, useTls, mailbox, pollIntervalMinutes,
      mailboxAddress, tenantId,
      autoCreateCase, autoCreateLead, defaultOwnerId, defaultCaseType, defaultPriority,
      allowedSenders, blockedSenders, markSeen, deleteAfterImport, maxMessagesPerPoll } = req.body;

    const kind = provider || 'imap';
    if (!['imap', 'pop3', 'microsoft'].includes(kind)) {
      return res.status(400).json({ error: 'provider must be imap, pop3 or microsoft' });
    }

    if (!name) return res.status(400).json({ error: 'name required' });

    // A Graph mailbox is identified by its address and authenticated through
    // the consent flow, so it has neither a host nor a stored password.
    if (kind === 'microsoft') {
      if (!mailboxAddress) return res.status(400).json({ error: 'mailboxAddress required for a microsoft account' });
    } else {
      if (!host) return res.status(400).json({ error: 'host required' });
      if (!username) return res.status(400).json({ error: 'username required' });
      if (!password) return res.status(400).json({ error: 'password required' });
      if (protocol && !['imap', 'pop3'].includes(protocol)) return res.status(400).json({ error: 'protocol must be imap or pop3' });
    }
    if (port && (port < 1 || port > 65535)) return res.status(400).json({ error: 'port must be between 1 and 65535' });
    if (pollIntervalMinutes != null && +pollIntervalMinutes < 1) return res.status(400).json({ error: 'pollIntervalMinutes must be at least 1' });

    const account = await prisma.inboundEmailAccount.create({
      data: {
        name, provider: kind, protocol: protocol || (kind === 'pop3' ? 'pop3' : 'imap'),
        host: kind === 'microsoft' ? null : host,
        port: port ? +port : (protocol === 'pop3' ? 995 : 993),
        username: username || mailboxAddress,
        password: kind === 'microsoft' ? null : encrypt(password),
        mailboxAddress: kind === 'microsoft' ? mailboxAddress : null,
        tenantId: kind === 'microsoft' ? (tenantId || null) : null,
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

router.put('/accounts/:id', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const data = columnsFrom('inboundEmailAccount', req.body);
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

    // A Microsoft mailbox can be tested for real rather than inspected.
    if (account.provider === 'microsoft') {
      try {
        const live = await graphMailbox.testConnection(prisma, account);
        await prisma.inboundEmailAccount.update({ where: { id: account.id }, data: { status: 'Idle', lastError: null } });
        return res.json({ configurationValid: true, live: true, ...live });
      } catch (e) {
        await prisma.inboundEmailAccount.update({
          where: { id: account.id },
          data: { status: 'Error', lastError: String(e.message).slice(0, 400) },
        });
        return res.status(e.status && e.status < 500 ? e.status : 502).json({
          configurationValid: false, live: true, connected: false, error: e.message,
        });
      }
    }

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
// The mail worker holds an admin API key. Anyone who can post here can open
// cases and leads as the mailbox, so a signed-in user is not enough.
router.post('/accounts/:id/poll', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const prisma = req.app.locals.prisma;
    const account = await prisma.inboundEmailAccount.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (!account.active) return res.status(400).json({ error: 'Account is inactive' });

    // A Microsoft mailbox fetches for itself; everything else is fed a batch
    // by an external worker, which is what this endpoint was built for.
    if (account.provider === 'microsoft' && !Array.isArray(req.body.messages)) {
      const result = await graphMailbox.pollAccount(prisma, account);
      await req.audit({ action: 'create', module: 'inboundEmail', recordId: account.id, details: `Graph poll: ${result.processed} processed, ${result.casesCreated} cases` });
      return res.json(result);
    }

    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    if (!messages.length) return res.status(400).json({ error: 'messages array required' });
    if (messages.length > account.maxMessagesPerPoll) {
      return res.status(400).json({ error: `Batch exceeds maxMessagesPerPoll (${account.maxMessagesPerPoll})` });
    }

    await prisma.inboundEmailAccount.update({ where: { id: account.id }, data: { status: 'Polling' } });
    const stats = await ingestMessages(prisma, account, messages);
    await recordPoll(prisma, account, stats, messages);

    await req.audit({ action: 'create', module: 'inboundEmail', recordId: account.id, details: `Poll: ${stats.processed} processed, ${stats.casesCreated} cases, ${stats.repliesLinked} replies linked` });
    res.json({ accountId: account.id, durationMs: Date.now() - startedAt, ...stats });
  } catch (err) { next(err); }
});

// ── MICROSOFT GRAPH ───────────────────────────────────────────────────

/** Where to send an administrator to grant this mailbox's consent. */
router.get('/accounts/:id/microsoft/authorize-url', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const account = await prisma.inboundEmailAccount.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (!process.env.MICROSOFT_CLIENT_ID) {
      return res.status(503).json({ error: 'Microsoft OAuth is not configured. Set MICROSOFT_CLIENT_ID.' });
    }

    const redirectUri = req.query.redirectUri || process.env.MICROSOFT_REDIRECT_URI;
    if (!redirectUri) return res.status(400).json({ error: 'redirectUri is required' });

    const tenant = account.tenantId || process.env.MICROSOFT_TENANT_ID || 'common';
    const params = new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: MAIL_SCOPES,
      state: account.id,
      prompt: 'consent',
    });
    res.json({ url: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params}`, scopes: MAIL_SCOPES });
  } catch (err) { next(err); }
});

/** Finish the consent flow: swap the code for tokens and store them encrypted. */
router.post('/accounts/:id/microsoft/connect', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const account = await prisma.inboundEmailAccount.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const { code, redirectUri } = req.body || {};
    if (!code || !redirectUri) return res.status(400).json({ error: 'code and redirectUri are required' });

    const updated = await graphMailbox.connect(prisma, account, { code, redirectUri });
    await req.audit({ action: 'update', module: 'inboundEmail', recordId: account.id, details: `Connected Microsoft mailbox ${updated.mailboxAddress || ''}`.trim() });
    res.json(safeAccount(updated));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** Forget the tokens without deleting the account. */
router.post('/accounts/:id/microsoft/disconnect', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const account = await prisma.inboundEmailAccount.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const updated = await prisma.inboundEmailAccount.update({
      where: { id: account.id },
      data: { oauthAccessToken: null, oauthRefreshToken: null, oauthExpiresAt: null, status: 'Disabled' },
    });
    await req.audit({ action: 'update', module: 'inboundEmail', recordId: account.id, details: 'Disconnected Microsoft mailbox' });
    res.json(safeAccount(updated));
  } catch (err) { next(err); }
});

/** Reply on the original thread, from the mailbox that received it. */
router.post('/messages/:id/reply', authenticate, requirePermission('cases', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const body = String(req.body?.body ?? req.body?.comment ?? '').trim();
    if (!body) return res.status(400).json({ error: 'body is required' });

    const message = await prisma.inboundEmailMessage.findUnique({ where: { id: req.params.id } });
    if (!message) return res.status(404).json({ error: 'Message not found' });

    const account = await prisma.inboundEmailAccount.findFirst({ where: { id: message.accountId, deletedAt: null } });
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.provider !== 'microsoft') {
      return res.status(501).json({ error: 'Replies are only implemented for Microsoft mailboxes.' });
    }

    await graphMailbox.reply(prisma, account, message, body);

    if (message.createdCaseId) {
      await prisma.caseComment.create({
        data: { caseId: message.createdCaseId, text: body, authorId: req.userId, isInternal: false },
      }).catch(() => {});
    }

    await req.audit({ action: 'create', module: 'inboundEmail', recordId: message.id, details: `Replied to ${message.fromEmail || 'sender'}` });
    res.json({ replied: true, messageId: message.id, to: message.fromEmail, caseId: message.createdCaseId || null });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Accounts whose poll interval has elapsed, with their decrypted passwords for
// the mail worker. Any signed-in user could read every mailbox password here,
// and then anyone with admin: edit, which the default Sales Rep role has. It
// takes admin: full, as does anything that sets a mailbox's credentials.
router.get('/accounts/due/poll', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
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
// Customer mail, answered from the support mailbox: reading it takes cases:
// read, and replying, converting or ignoring it cases: edit. All four took a
// session alone, so anyone could read every inbound message or send mail as
// the company.

router.get('/messages', authenticate, requirePermission('cases', 'read'), async (req, res, next) => {
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

router.post('/messages/:id/convert', authenticate, requirePermission('cases', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { target } = req.body;
    if (!['case', 'lead'].includes(target)) return res.status(400).json({ error: 'target must be case or lead' });

    const message = await prisma.inboundEmailMessage.findUnique({ where: { id: req.params.id } });
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (message.createdCaseId || message.createdLeadId) return res.status(409).json({ error: 'Message has already been converted' });

    if (target === 'case') {
      const contact = message.fromEmail ? await prisma.contact.findFirst({ where: { email: message.fromEmail, deletedAt: null } }) : null;
      const created = await createNumbered(prisma, 'case', CASE_NUMBER, {
        data: {
          subject: (message.subject || 'Email enquiry').slice(0, 250),
          description: (message.textBody || '').slice(0, 8000),
          status: 'New', priority: req.body.priority || 'Medium', origin: 'Email',
          ownerId: req.body.ownerId || req.user.id,
          contactId: contact?.id || null, accountId: contact?.accountId || null,
          contactEmail: message.fromEmail,
        },
      });
      await prisma.inboundEmailMessage.update({ where: { id: message.id }, data: { createdCaseId: created.id, status: 'Converted' } });
      await req.audit({ action: 'create', module: 'inboundEmail', recordId: created.id, details: 'Email converted to case' });
      return res.status(201).json({ target: 'case', record: created });
    }

    const [first, ...rest] = (message.fromName || (message.fromEmail || '').split('@')[0] || 'Unknown').split(' ');
    const lead = await prisma.lead.create({
      data: {
        firstName: first, lastName: rest.join(' ') || first,
        email: message.fromEmail, source: 'Email', status: 'New',
        company: (message.fromEmail || '').split('@')[1] || 'Unknown',
        description: (message.textBody || '').slice(0, 4000),
        ownerId: req.body.ownerId || req.user.id,
      },
    });
    await prisma.inboundEmailMessage.update({ where: { id: message.id }, data: { createdLeadId: lead.id, status: 'Converted' } });
    res.status(201).json({ target: 'lead', record: lead });
  } catch (err) { next(err); }
});

router.post('/messages/:id/ignore', authenticate, requirePermission('cases', 'edit'), async (req, res, next) => {
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
    const { name, accountId, conditions, assignToId, assignToUserId, setPriority, setType, setStatus, priority, active } = req.body;
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
      // assignToUserId is the name this endpoint has always taken; the column is assignToId.
      data: { name, accountId: accountId || null, conditions, assignToId: assignToId ?? assignToUserId, setPriority, setType, setStatus, priority: priority ?? 0, active: active !== false },
    });
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

router.put('/rules/:id', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { id, createdAt, updatedAt, assignToUserId, ...body } = req.body;
    const { data } = pickModelFields('inboundRoutingRule', { ...body, ...(assignToUserId !== undefined && body.assignToId === undefined && { assignToId: assignToUserId }) });
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
      prisma.emailPollLog.findMany({ where: { startedAt: { gte: since } }, take: 5000 }),
      prisma.inboundEmailMessage.findMany({ where: { createdAt: { gte: since } }, select: { status: true, isAutomated: true, createdCaseId: true, createdLeadId: true }, take: 10000 }),
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
      conversionRate: messages.length ? +((messages.filter(m => m.createdCaseId || m.createdLeadId).length / messages.length) * 100).toFixed(1) : 0,
      byStatus: messages.reduce((a, m) => { a[m.status] = (a[m.status] || 0) + 1; return a; }, {}),
    });
  } catch (err) { next(err); }
});

module.exports = router;
