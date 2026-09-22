/**
 * Inbound mail ingestion.
 *
 * Lifted out of routes/inboundEmail.js unchanged in behaviour so that the
 * transport no longer dictates the pipeline: the HTTP poll endpoint (an
 * external IMAP worker posting a batch) and the Microsoft Graph scheduler job
 * both hand messages to the same code.
 *
 * A message is expected in the shape the poll endpoint already accepted:
 * { messageId, inReplyTo, references, from, to, cc, subject, text, html,
 *   date, uid, attachments, headers }.
 */

const { createNumbered, CASE_NUMBER } = require('../utils/numbering');

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

/** Route a message with the first matching rule, in priority order. */
function matchRule(rules, haystack) {
  for (const rule of rules) {
    const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
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
    if (matches) return rule;
  }
  return null;
}

/**
 * Store, thread and route one batch. Returns the tallies the poll endpoint
 * has always returned, plus the per-message outcome.
 */
async function ingestMessages(prisma, account, messages, { onAcknowledge } = {}) {
  let fetched = 0, processed = 0, skipped = 0;
  let casesCreated = 0, leadsCreated = 0, repliesLinked = 0, errors = 0;
  const results = [];

  for (const raw of messages) {
    fetched++;
    let subject = raw.subject || '(no subject)';
    try {
      const from = parseAddress(raw.from || raw.fromEmail);
      const bodyText = stripQuotedReply(raw.text || raw.body || '');

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
          externalId: raw.graphId || raw.externalId || null,
          messageId: raw.messageId || null, inReplyTo: raw.inReplyTo || null,
          references: Array.isArray(raw.references) ? raw.references.join(' ') : (raw.references || null),
          fromEmail: from.email, fromName: from.name,
          toEmails: raw.to || null, ccEmails: raw.cc || null,
          subject, threadKey: normalizeSubject(subject),
          textBody: bodyText, htmlBody: raw.html || null,
          receivedAt: raw.date ? new Date(raw.date) : new Date(),
          hasAttachments: !!(raw.attachments?.length),
          attachmentCount: raw.attachments?.length || 0,
          isAutomated: automated,
          status: 'Received',
        },
      });

      if (automated) {
        await prisma.inboundEmailMessage.update({ where: { id: stored.id }, data: { status: 'Ignored' } }).catch(() => {});
        skipped++; results.push({ subject, action: 'ignored', reason: 'automated message' }); continue;
      }

      // Reply to an existing case, matched by ref tag, then thread, then subject
      const caseRef = extractCaseRef(subject, bodyText);
      let linkedCase = null;
      if (caseRef) {
        linkedCase = await prisma.case.findFirst({ where: { caseNumber: caseRef, deletedAt: null } });
      }
      if (!linkedCase && raw.inReplyTo) {
        const prior = await prisma.inboundEmailMessage.findFirst({ where: { messageId: raw.inReplyTo }, select: { createdCaseId: true } }).catch(() => null);
        if (prior?.createdCaseId) linkedCase = await prisma.case.findFirst({ where: { id: prior.createdCaseId, deletedAt: null } });
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
        await prisma.inboundEmailMessage.update({ where: { id: stored.id }, data: { createdCaseId: linkedCase.id, status: 'Linked' } }).catch(() => {});
        repliesLinked++; processed++;
        results.push({ subject, action: 'linked', caseId: linkedCase.id, caseNumber: linkedCase.caseNumber });
        continue;
      }

      const rules = await prisma.inboundRoutingRule.findMany({ where: { accountId: account.id, active: true }, orderBy: { priority: 'asc' } }).catch(() => []);
      const routed = matchRule(rules, { subject, from: from.email || '', body: bodyText, to: raw.to || '' });

      if (account.autoCreateCase) {
        const contact = from.email ? await prisma.contact.findFirst({ where: { email: from.email, deletedAt: null } }) : null;
        // caseNumber is required and has no default, and type is not nullable,
        // so an email-opened case has to supply one and omit the other.
        const caseType = routed?.setType || account.defaultCaseType;
        const newCase = await createNumbered(prisma, 'case', CASE_NUMBER, {
          data: {
            subject: subject.slice(0, 250),
            description: bodyText.slice(0, 8000),
            status: routed?.setStatus || 'New',
            priority: routed?.setPriority || account.defaultPriority || 'Medium',
            ...(caseType ? { type: caseType } : {}),
            origin: 'Email',
            ownerId: routed?.assignToId || account.defaultOwnerId || null,
            contactId: contact?.id || null,
            accountId: contact?.accountId || null,
            contactEmail: from.email,
            emailCount: 1, lastEmailAt: new Date(),
            lastEmailMessageId: raw.messageId || null,
          },
        });
        await prisma.inboundEmailMessage.update({ where: { id: stored.id }, data: { createdCaseId: newCase.id, status: 'Converted' } }).catch(() => {});
        // Acknowledge, when the account asks for it. The sender is a real
        // person here: automated mail never reaches this branch. Sending is
        // the caller's job, so the pipeline does not depend on a transport.
        let acknowledged = false;
        if (account.autoReply && typeof onAcknowledge === 'function') {
          try {
            await onAcknowledge({ message: stored, newCase, from, subject });
            acknowledged = true;
          } catch (e) {
            results.push({ subject, action: 'auto-reply failed', reason: String(e.message).slice(0, 160) });
          }
        }

        casesCreated++; processed++;
        results.push({ subject, action: 'case created', caseId: newCase.id, matchedRule: routed?.name || null, acknowledged });
        continue;
      }

      if (account.autoCreateLead && from.email) {
        const existingLead = await prisma.lead.findFirst({ where: { email: from.email, deletedAt: null } });
        if (!existingLead) {
          const [first, ...rest] = (from.name || from.email.split('@')[0]).split(' ');
          const lead = await prisma.lead.create({
            data: {
              firstName: first, lastName: rest.join(' ') || first,
              // `company` is required and `source` is the column's name — this
              // create named `leadSource`, which only Contact has, and supplied
              // no company at all, so it threw on every inbound message.
              email: from.email, source: 'Email',
              company: from.email.split('@')[1] || 'Unknown',
              status: 'New', description: bodyText.slice(0, 4000),
              ownerId: account.defaultOwnerId || null,
            },
          });
          await prisma.inboundEmailMessage.update({ where: { id: stored.id }, data: { createdLeadId: lead.id, status: 'Converted' } }).catch(() => {});
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
      results.push({ subject, action: 'error', reason: String(e.message).slice(0, 160) });
    }
  }

  return { fetched, processed, skipped, casesCreated, leadsCreated, repliesLinked, errors, results };
}

/** Bookkeeping after a batch: account status, watermark, and the poll log. */
async function recordPoll(prisma, account, stats, messages = []) {
  const highestUid = messages.reduce((m, x) => Math.max(m, +x.uid || 0), account.lastUid || 0);
  const latestReceived = messages
    .map(m => (m.date ? new Date(m.date) : null))
    .filter(d => d && !Number.isNaN(d.getTime()))
    .sort((a, b) => b - a)[0];

  await prisma.inboundEmailAccount.update({
    where: { id: account.id },
    data: {
      status: stats.errors ? 'Error' : 'Idle',
      lastPolledAt: new Date(),
      lastUid: highestUid,
      ...(latestReceived ? { lastSyncAt: latestReceived } : {}),
      lastError: stats.errors ? `${stats.errors} messages failed` : null,
    },
  });

  await prisma.emailPollLog.create({
    data: {
      accountId: account.id,
      messagesFetched: stats.fetched, messagesProcessed: stats.processed,
      casesCreated: stats.casesCreated, leadsCreated: stats.leadsCreated,
      errorCount: stats.errors,
      status: stats.errors ? 'Completed with errors' : 'Completed',
    },
  }).catch(() => {});
}

module.exports = {
  ingestMessages,
  recordPoll,
  parseAddress,
  normalizeSubject,
  extractCaseRef,
  stripQuotedReply,
  senderAllowed,
  isAutomatedMessage,
};
