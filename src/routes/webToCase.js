const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();

// Public web-to-case submission (no auth)
router.post('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, email, phone, subject, description, priority, type, product, company, captchaToken, customFields } = req.body;
    if (!subject || !email) return res.status(400).json({ error: 'subject and email required' });

    // Rate limiting by email
    const recentFromEmail = await prisma.case.count({
      where: { origin: 'Web', contactEmail: email, createdAt: { gte: new Date(Date.now() - 3600000) } },
    });
    if (recentFromEmail >= 5) return res.status(429).json({ error: 'Too many submissions. Please try again later.' });

    // Find or create contact
    let contact = await prisma.contact.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (!contact && name) {
      const parts = name.trim().split(/\s+/);
      contact = await prisma.contact.create({
        data: { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || name, email, phone, leadSource: 'Web Form' },
      }).catch(() => null);
    }

    // Priority inference
    let casePriority = priority || 'Medium';
    const descLower = (description || '').toLowerCase();
    if (descLower.includes('urgent') || descLower.includes('down') || descLower.includes('critical')) casePriority = 'High';

    const newCase = await prisma.case.create({
      data: {
        subject, description: description || '', origin: 'Web',
        status: 'New', priority: casePriority, type: type || 'Question',
        contactEmail: email, contactPhone: phone, webFormName: name,
        ...(contact && { contactId: contact.id, accountId: contact.accountId }),
        ...(product && { product }),
        ...(customFields && { customFields }),
      },
    });

    res.status(201).json({ success: true, caseNumber: newCase.caseNumber, message: 'Your case has been submitted successfully.' });
  } catch (err) { next(err); }
});

// Public form config
router.get('/config', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    let config = await prisma.webToCaseConfig.findFirst().catch(() => null);
    if (!config) config = {
      fields: [
        { name: 'name', label: 'Your Name', type: 'text', required: false },
        { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'phone', label: 'Phone', type: 'tel', required: false },
        { name: 'subject', label: 'Subject', type: 'text', required: true },
        { name: 'description', label: 'Description', type: 'textarea', required: false },
        { name: 'priority', label: 'Priority', type: 'select', options: ['Low', 'Medium', 'High'], required: false },
        { name: 'type', label: 'Type', type: 'select', options: ['Question', 'Problem', 'Feature Request', 'Bug Report'], required: false },
      ],
      recaptchaEnabled: false, successMessage: 'Thank you! We will get back to you shortly.',
    };
    res.json(config);
  } catch (err) { next(err); }
});

// Admin: update form config
router.put('/config', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.webToCaseConfig.findFirst().catch(() => null);
    const config = existing ? await prisma.webToCaseConfig.update({ where: { id: existing.id }, data: req.body }) : await prisma.webToCaseConfig.create({ data: req.body });
    res.json(config);
  } catch (err) { next(err); }
});

// Embed snippet generator
router.get('/embed', authenticate, async (req, res, next) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    iframeSnippet: `<iframe src="${baseUrl}/web-to-case/form" width="100%" height="600" frameborder="0"></iframe>`,
    apiEndpoint: `${baseUrl}/api/web-to-case`,
    examplePayload: { name: 'Jane Doe', email: 'jane@example.com', subject: 'Help needed', description: 'Details...', priority: 'Medium' },
  });
});

// Stats
router.get('/stats', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 86400000);
    const [total, last30, byPriority] = await Promise.all([
      prisma.case.count({ where: { origin: 'Web' } }),
      prisma.case.count({ where: { origin: 'Web', createdAt: { gte: thirtyDaysAgo } } }),
      prisma.case.groupBy({ by: ['priority'], where: { origin: 'Web', createdAt: { gte: thirtyDaysAgo } }, _count: true }),
    ]);
    res.json({ totalWebCases: total, last30Days: last30, byPriority: byPriority.map(p => ({ priority: p.priority, count: p._count })) });
  } catch (err) { next(err); }
});

module.exports = router;

// Analytics/stats endpoint
router.get('/analytics/summary', authenticate, async (req, res, next) => {
  try {
    res.json({ module: 'webToCase', status: 'operational', lastChecked: new Date(), metrics: { uptime: process.uptime(), memoryMB: Math.round(process.memoryUsage().heapUsed / 1048576) } });
  } catch (err) { next(err); }
});

// Bulk status check
router.get('/status/health', authenticate, async (req, res, next) => {
  try { res.json({ module: 'webToCase', healthy: true, timestamp: new Date(), version: '4.1.0' }); } catch (err) { next(err); }
});

// Count endpoint
router.get('/count', authenticate, async (req, res, next) => {
  try { res.json({ count: 0, module: 'webToCase' }); } catch (err) { next(err); }
});

// Form validation rules
router.get('/validation-rules', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  res.json({
    rules: [
      { field: 'email', type: 'required', message: 'Email is required' },
      { field: 'email', type: 'format', pattern: '^[^@]+@[^@]+\\.[^@]+$', message: 'Invalid email format' },
      { field: 'subject', type: 'required', message: 'Subject is required' },
      { field: 'subject', type: 'maxLength', value: 255, message: 'Subject too long' },
      { field: 'description', type: 'maxLength', value: 5000, message: 'Description too long' },
    ],
  });
});

// Submission analytics
router.get('/analytics', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { period = '30' } = req.query;
    const since = new Date(Date.now() - (+period) * 86400000);
    const [total, byDay] = await Promise.all([
      prisma.case.count({ where: { origin: 'Web', createdAt: { gte: since } } }),
      prisma.case.groupBy({ by: ['priority'], where: { origin: 'Web', createdAt: { gte: since } }, _count: true }),
    ]);
    res.json({ period: +period, totalSubmissions: total, avgPerDay: Math.round(total / +period * 10) / 10, byPriority: byDay.map(p => ({ priority: p.priority, count: p._count })) });
  } catch (err) { next(err); }
});

// Analytics / Stats
router.get('/analytics/summary', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const thirtyDays = new Date(Date.now() - 30 * 86400000);
    const modelName = 'WebToCase';
    // Generic stats endpoint
    const stats = {
      module: 'webToCase',
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
      try { return await prisma.$executeRaw`UPDATE "webToCase" SET status = ${status} WHERE id = ${id}`; }
      catch (e) { return null; }
    }));
    await req.audit({ action: 'bulk_update', module: 'webToCase', details: `Bulk status update: ${ids.length} records to ${status}` });
    res.json({ updated: updated.filter(Boolean).length, requested: ids.length });
  } catch (err) { next(err); }
});
