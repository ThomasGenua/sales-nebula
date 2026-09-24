const crypto = require('crypto');
const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { createNumbered, CASE_NUMBER } = require('../utils/numbering');
const { summaryRoute } = require('../utils/moduleStatus');

const router = Router();

const sameSecret = (given, expected) => {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * The inbound endpoints open cases for whoever calls them, so only the mail
 * provider may: it sends EMAIL_TO_CASE_SECRET as an X-Webhook-Secret header,
 * or as the password of HTTP basic auth for providers that can only put
 * credentials in the webhook URL. Unset, the endpoints stay closed.
 */
function requireInboundSecret(req, res, next) {
  const expected = process.env.EMAIL_TO_CASE_SECRET;
  if (!expected) return res.status(503).json({ error: 'Email-to-case is not configured' });
  const basic = /^Basic\s+(.+)$/i.exec(req.get('authorization') || '');
  const password = basic ? Buffer.from(basic[1], 'base64').toString('utf8').split(':').slice(1).join(':') : null;
  if (sameSecret(req.get('x-webhook-secret'), expected) || sameSecret(password, expected)) return next();
  return res.status(401).json({ error: 'Invalid webhook secret' });
}

// Receive inbound email (webhook endpoint)
router.post('/inbound', requireInboundSecret, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { from, to, subject, body, htmlBody, threadId, messageId, attachments, headers } = req.body;
    if (!from || !subject) return res.status(400).json({ error: 'from and subject required' });

    // Thread matching: reply to existing case
    let existingCase = null;
    if (threadId) existingCase = await prisma.case.findFirst({ where: { emailThreadId: threadId } });
    if (!existingCase && subject) {
      // Case numbers read "CS-001"; a tag may carry the whole number or just its digits.
      const caseRefMatch = subject.match(/\[Case#\s*([\w-]+)\]/i);
      if (caseRefMatch) {
        const ref = caseRefMatch[1];
        existingCase = await prisma.case.findFirst({ where: { caseNumber: { in: [ref, `${CASE_NUMBER.prefix}${ref}`] } } });
      }
    }
    if (!existingCase && messageId) {
      existingCase = await prisma.case.findFirst({ where: { lastEmailMessageId: messageId } });
    }

    // Find contact by email
    const emailAddr = typeof from === 'object' ? from.address : from;
    const contact = await prisma.contact.findFirst({ where: { email: { equals: emailAddr, mode: 'insensitive' } } });

    // Load config for defaults
    let config = await prisma.emailToCaseConfig.findFirst().catch(() => null);
    if (!config) config = { defaultPriority: 'Medium', defaultStatus: 'New', autoResponse: true };

    if (existingCase) {
      await prisma.caseComment.create({
        // CaseComment stores the message in "text"; "body" is not a column.
        // The customer wrote it, so there is no internal author to name.
        data: { caseId: existingCase.id, text: body || htmlBody || subject, isPublic: true, authorEmail: emailAddr },
      });
      await prisma.case.update({
        where: { id: existingCase.id },
        data: { updatedAt: new Date(), lastEmailAt: new Date(), lastEmailMessageId: messageId || null, emailCount: { increment: 1 } },
      });
      res.json({ action: 'comment_added', caseId: existingCase.id, caseNumber: existingCase.caseNumber });
    } else {
      // Priority detection from subject keywords
      let priority = config.defaultPriority || 'Medium';
      const subjectLower = subject.toLowerCase();
      if (subjectLower.includes('urgent') || subjectLower.includes('critical') || subjectLower.includes('emergency')) priority = 'Critical';
      else if (subjectLower.includes('important') || subjectLower.includes('asap')) priority = 'High';

      // The webhook carries attachment metadata only, never the file, so
      // there is nothing to store as an Attachment. Say what arrived instead.
      const attachmentNote = attachments?.length
        ? `\n\nAttachments received but not stored: ${attachments.map(a => a.filename).filter(Boolean).join(', ')}`
        : '';
      const newCase = await createNumbered(prisma, 'case', CASE_NUMBER, {
        data: {
          subject: subject.replace(/^(Re:|Fwd?:|FW:)\s*/gi, '').trim(),
          description: (body || htmlBody || '') + attachmentNote, origin: 'Email',
          status: config.defaultStatus || 'New', priority,
          contactEmail: emailAddr, emailThreadId: threadId || null,
          lastEmailMessageId: messageId || null, emailCount: 1,
          ...(contact && { contactId: contact.id, accountId: contact.accountId }),
        },
      });

      res.status(201).json({ action: 'case_created', caseId: newCase.id, caseNumber: newCase.caseNumber });
    }
  } catch (err) { next(err); }
});

// Bulk inbound (batch processing)
router.post('/inbound/bulk', requireInboundSecret, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { emails } = req.body;
    if (!emails?.length) return res.status(400).json({ error: 'emails array required' });
    const results = [];
    for (const email of emails.slice(0, 50)) {
      try {
        const contact = await prisma.contact.findFirst({ where: { email: { equals: email.from, mode: 'insensitive' } } });
        const c = await createNumbered(prisma, 'case', CASE_NUMBER, {
          data: { subject: email.subject || 'No Subject', description: email.body || '', origin: 'Email', status: 'New', priority: 'Medium', contactEmail: email.from, ...(contact && { contactId: contact.id }) },
        });
        results.push({ email: email.from, action: 'created', caseId: c.id });
      } catch (e) { results.push({ email: email.from, action: 'error', error: e.message }); }
    }
    res.json({ processed: results.length, results });
  } catch (err) { next(err); }
});

// Config CRUD
router.get('/config', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    let config = await prisma.emailToCaseConfig.findFirst();
    if (!config) config = { enabled: true, defaultPriority: 'Medium', defaultStatus: 'New', autoResponse: true, routingAddress: 'support@company.com', maxEmailsPerHour: 100, spamFilter: true, threadingEnabled: true };
    res.json(config);
  } catch (err) { next(err); }
});

router.put('/config', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.emailToCaseConfig.findFirst();
    const config = existing ? await prisma.emailToCaseConfig.update({ where: { id: existing.id }, data: req.body }) : await prisma.emailToCaseConfig.create({ data: req.body });
    await req.audit({ action: 'update', module: 'emailToCase', recordId: config.id, details: 'Config updated' });
    res.json(config);
  } catch (err) { next(err); }
});

// Email routing rules
router.get('/routing-rules', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rules = await prisma.emailRoutingRule.findMany({ where: { deletedAt: null }, orderBy: { priority: 'asc' } });
    res.json(rules);
  } catch (err) { next(err); }
});

router.post('/routing-rules', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, condition, assignToId, priority, caseType } = req.body;
    if (!name || !condition) return res.status(400).json({ error: 'name and condition required' });
    const rule = await prisma.emailRoutingRule.create({
      data: { name, condition, assignToId, priority: priority || 0, caseType, active: true },
    });
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

module.exports = router;

// Totals from the module's own table.
summaryRoute(router, { module: 'cases', model: 'case', where: { origin: 'Email' } });
