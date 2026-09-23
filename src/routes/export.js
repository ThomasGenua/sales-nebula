const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { statusRoutes } = require('../utils/moduleStatus');

const router = Router();

const EXPORTABLE_MODULES = {
  contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account',
  cases: 'case', products: 'product', campaigns: 'campaign', activities: 'activity',
  quotes: 'quote', invoices: 'invoice', orders: 'order', contracts: 'contract',
  subscriptions: 'subscription', assets: 'asset', partners: 'partner',
};

// Export module data (POST with filters)
router.post('/', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, format = 'json', filters, fields, limit = 10000, includeDeleted } = req.body;
    if (!module || !EXPORTABLE_MODULES[module]) return res.status(400).json({ error: `Invalid module. Options: ${Object.keys(EXPORTABLE_MODULES).join(', ')}` });
    const modelName = EXPORTABLE_MODULES[module];
    const where = includeDeleted ? {} : { deletedAt: null };
    if (filters) {
      if (filters.createdAfter) where.createdAt = { ...(where.createdAt || {}), gte: new Date(filters.createdAfter) };
      if (filters.createdBefore) where.createdAt = { ...(where.createdAt || {}), lte: new Date(filters.createdBefore) };
      if (filters.ownerId) where.ownerId = filters.ownerId;
      if (filters.status) where.status = filters.status;
    }
    const select = fields?.length ? fields.reduce((acc, f) => { acc[f] = true; return acc; }, { id: true }) : undefined;
    const data = await prisma[modelName].findMany({ where, ...(select && { select }), take: Math.min(+limit, 50000), orderBy: { createdAt: 'desc' } });
    await req.audit({ action: 'read', module: 'export', recordId: module, details: `Exported ${data.length} ${module} records (${format})` });

    if (format === 'csv') {
      if (!data.length) { res.setHeader('Content-Type', 'text/csv'); return res.send(''); }
      const headers = Object.keys(data[0]);
      const escape = (v) => { const s = v === null || v === undefined ? '' : String(v); return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s; };
      const csvRows = [headers.join(','), ...data.map(row => headers.map(h => escape(row[h])).join(','))];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${module}_export_${new Date().toISOString().split('T')[0]}.csv"`);
      return res.send(csvRows.join('\n'));
    }
    res.json({ module, count: data.length, exportedAt: new Date(), format, data });
  } catch (err) { next(err); }
});

// Quick export (GET shorthand)
router.get('/:module', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module } = req.params;
    if (!EXPORTABLE_MODULES[module]) return res.status(400).json({ error: `Invalid module. Options: ${Object.keys(EXPORTABLE_MODULES).join(', ')}` });
    const { limit = 1000, offset = 0, format = 'json', status } = req.query;
    const where = { deletedAt: null };
    if (status) where.status = status;
    const data = await prisma[EXPORTABLE_MODULES[module]].findMany({ where, take: +limit, skip: +offset, orderBy: { createdAt: 'desc' } });
    res.json({ module, count: data.length, offset: +offset, data });
  } catch (err) { next(err); }
});

// Available modules
router.get('/', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const modules = [];
    for (const [key, model] of Object.entries(EXPORTABLE_MODULES)) {
      try { const count = await prisma[model].count({ where: { deletedAt: null } }); modules.push({ module: key, model, recordCount: count }); }
      catch (e) { modules.push({ module: key, model, recordCount: 0 }); }
    }
    res.json({ availableModules: modules });
  } catch (err) { next(err); }
});

// Export history
router.get('/history', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const history = await prisma.auditLog.findMany({
      where: { module: 'export' }, orderBy: { createdAt: 'desc' }, take: 50,
      select: { id: true, details: true, userId: true, createdAt: true },
    });
    res.json(history);
  } catch (err) { next(err); }
});

module.exports = router;

// Scheduled export
router.post('/schedule', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, module, format, frequency, recipients } = req.body;
    if (!module || !EXPORTABLE_MODULES[module]) return res.status(400).json({ error: 'Invalid module' });
    // name is a required column. The create always failed without it, and a
    // .catch() then answered 201 with a schedule that was never saved.
    const schedule = await prisma.scheduledExport.create({ data: { name: name || `${module} export`, module, format: format || 'csv', schedule: frequency || 'weekly', recipients: recipients || [], userId: req.user.id, nextRunAt: new Date(Date.now() + 86400000) } });
    res.status(201).json(schedule);
  } catch (err) { next(err); }
});

// Export template (predefined field sets)
router.get('/templates', authenticate, async (req, res, next) => {
  const templates = [
    { id: 'contacts-full', module: 'contacts', name: 'All Contact Fields', fields: ['firstName','lastName','email','phone','title','department','mailingCity','mailingState','leadSource','status','createdAt'] },
    { id: 'deals-pipeline', module: 'deals', name: 'Pipeline Report', fields: ['name','stage','value','probability','closeDate','source','ownerId','createdAt'] },
    { id: 'leads-scoring', module: 'leads', name: 'Lead Scoring Export', fields: ['firstName','lastName','company','email','score','status','source','createdAt'] },
    { id: 'cases-support', module: 'cases', name: 'Support Cases', fields: ['caseNumber','subject','status','priority','origin','createdAt','closedAt'] },
  ];
  res.json(templates);
});

// Record count, health and summary, answered from the module's own table.
statusRoutes(router, { module: 'export', model: 'scheduledExport' });

// Export progress
router.get('/progress/:jobId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const job = await prisma.exportJob.findUnique({ where: { id: req.params.jobId } }).catch(() => null);
    res.json(job || { jobId: req.params.jobId, status: 'completed', progress: 100 });
  } catch (err) { next(err); }
});

// Export field options per module
router.get('/fields/:module', authenticate, async (req, res, next) => {
  const fieldMap = {
    contacts: ['id','firstName','lastName','email','phone','title','department','status','leadSource','createdAt','updatedAt'],
    leads: ['id','firstName','lastName','email','company','title','status','score','source','createdAt'],
    deals: ['id','name','stage','value','probability','closeDate','source','createdAt'],
    accounts: ['id','name','industry','phone','website','type','annualRevenue','createdAt'],
    cases: ['id','caseNumber','subject','status','priority','origin','createdAt','closedAt'],
  };
  res.json({ module: req.params.module, fields: fieldMap[req.params.module] || ['id','name','createdAt'] });
});

// Analytics / Stats
router.get('/analytics/summary', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const thirtyDays = new Date(Date.now() - 30 * 86400000);
    const modelName = 'Export';
    // Generic stats endpoint
    const stats = {
      module: 'export',
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
      try { return await prisma.$executeRaw`UPDATE "export" SET status = ${status} WHERE id = ${id}`; }
      catch (e) { return null; }
    }));
    await req.audit({ action: 'bulk_update', module: 'export', details: `Bulk status update: ${ids.length} records to ${status}` });
    res.json({ updated: updated.filter(Boolean).length, requested: ids.length });
  } catch (err) { next(err); }
});
