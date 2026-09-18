const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();

// Receive inbound email (webhook endpoint)
router.post('/inbound', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { from, to, subject, body, htmlBody, threadId, messageId, attachments, headers } = req.body;
    if (!from || !subject) return res.status(400).json({ error: 'from and subject required' });

    // Thread matching: reply to existing case
    let existingCase = null;
    if (threadId) existingCase = await prisma.case.findFirst({ where: { emailThreadId: threadId } });
    if (!existingCase && subject) {
      const caseRefMatch = subject.match(/\[Case#(\d+)\]/);
      if (caseRefMatch) existingCase = await prisma.case.findFirst({ where: { caseNumber: caseRefMatch[1] } });
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

      const newCase = await prisma.case.create({
        data: {
          subject: subject.replace(/^(Re:|Fwd?:|FW:)\s*/gi, '').trim(),
          description: body || htmlBody || '', origin: 'Email',
          status: config.defaultStatus || 'New', priority,
          contactEmail: emailAddr, emailThreadId: threadId || null,
          lastEmailMessageId: messageId || null, emailCount: 1,
          ...(contact && { contactId: contact.id, accountId: contact.accountId }),
        },
      });

      // Process attachments
      if (attachments?.length) {
        for (const att of attachments) {
          await prisma.attachment.create({
            data: { name: att.filename, parentModule: 'cases', parentId: newCase.id, mimeType: att.contentType, fileSize: att.size || 0 },
          }).catch(() => {});
        }
      }

      res.status(201).json({ action: 'case_created', caseId: newCase.id, caseNumber: newCase.caseNumber });
    }
  } catch (err) { next(err); }
});

// Bulk inbound (batch processing)
router.post('/inbound/bulk', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { emails } = req.body;
    if (!emails?.length) return res.status(400).json({ error: 'emails array required' });
    const results = [];
    for (const email of emails.slice(0, 50)) {
      try {
        const contact = await prisma.contact.findFirst({ where: { email: { equals: email.from, mode: 'insensitive' } } });
        const c = await prisma.case.create({
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

// Analytics / Stats
router.get('/analytics/summary', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const thirtyDays = new Date(Date.now() - 30 * 86400000);
    const modelName = 'EmailToCase';
    // Generic stats endpoint
    const stats = {
      module: 'emailToCase',
      generatedAt: new Date(),
      environment: process.env.NODE_ENV || 'development',
    };
    res.json(stats);
  } catch (err) { next(err); }
});

// Bulk status update
router.post('/bulk/status', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { ids, status } = req.body;
    if (!ids?.length || !status) return res.status(400).json({ error: 'ids and status required' });
    const updated = await Promise.all(ids.slice(0, 100).map(async (id) => {
      try { return await prisma.$executeRaw`UPDATE "emailToCase" SET status = ${status} WHERE id = ${id}`; }
      catch (e) { return null; }
    }));
    await req.audit({ action: 'bulk_update', module: 'emailToCase', details: `Bulk status update: ${ids.length} records to ${status}` });
    res.json({ updated: updated.filter(Boolean).length, requested: ids.length });
  } catch (err) { next(err); }
});
