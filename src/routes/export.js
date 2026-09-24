const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere } = require('../middleware/access');
const { isAdmin } = require('../middleware/rowSecurity');
const { scalarSelect, modelHasField } = require('../utils/modelFields');
const { statusRoutes, summaryRoute } = require('../utils/moduleStatus');

const router = Router();

/*
 * Exports took a session alone and read every row of fifteen modules, deleted
 * ones on request, with any columns: `fields: ["owner"]` returned each
 * record's owner row, password hash included. An export now takes read
 * permission on the module, reaches only the caller's rows, and returns the
 * model's own columns. Deleted rows are for administrators.
 */
const plain = v => ['string', 'number', 'boolean'].includes(typeof v);

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
    if (!permits(req, module, 'read')) return res.status(403).json({ error: `Insufficient permissions for ${module}` });
    const modelName = EXPORTABLE_MODULES[module];
    const filter = {};
    if (filters) {
      if (filters.createdAfter) filter.createdAt = { ...(filter.createdAt || {}), gte: new Date(filters.createdAfter) };
      if (filters.createdBefore) filter.createdAt = { ...(filter.createdAt || {}), lte: new Date(filters.createdBefore) };
      if (plain(filters.ownerId) && modelHasField(modelName, 'ownerId')) filter.ownerId = String(filters.ownerId);
      if (plain(filters.status) && modelHasField(modelName, 'status')) filter.status = String(filters.status);
    }
    let where = await reachableWhere(req, module, modelName, filter);
    // Deleted rows too, for administrators who ask.
    if (includeDeleted && isAdmin(req.user)) where = filter;
    const select = scalarSelect(modelName, fields);
    const data = await prisma[modelName].findMany({ where, ...(select && { select }), take: Math.min(Math.max(parseInt(limit, 10) || 10000, 1), 50000), orderBy: { createdAt: 'desc' } });
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
    // Not a module: on to /history, /templates and the rest, which this
    // route used to swallow.
    if (!EXPORTABLE_MODULES[module]) return next();
    if (!permits(req, module, 'read')) return res.status(403).json({ error: `Insufficient permissions for ${module}` });
    const modelName = EXPORTABLE_MODULES[module];
    const { limit = 1000, offset = 0, status } = req.query;
    const filter = plain(status) && modelHasField(modelName, 'status') ? { status: String(status) } : {};
    const data = await prisma[modelName].findMany({
      where: await reachableWhere(req, module, modelName, filter),
      take: Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 10000),
      skip: Math.max(parseInt(offset, 10) || 0, 0),
      orderBy: { createdAt: 'desc' },
    });
    res.json({ module, count: data.length, offset: +offset, data });
  } catch (err) { next(err); }
});

// Available modules
router.get('/', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const modules = [];
    for (const [key, model] of Object.entries(EXPORTABLE_MODULES)) {
      if (!permits(req, key, 'read')) continue;
      try { const count = await prisma[model].count({ where: await reachableWhere(req, key, model) }); modules.push({ module: key, model, recordCount: count }); }
      catch (e) { modules.push({ module: key, model, recordCount: 0 }); }
    }
    res.json({ availableModules: modules });
  } catch (err) { next(err); }
});

// Export history
router.get('/history', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // The caller's own exports; everyone's, for administrators.
    const history = await prisma.auditLog.findMany({
      where: { module: 'export', ...(isAdmin(req.user) ? {} : { userId: req.userId }) }, orderBy: { createdAt: 'desc' }, take: 50,
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

// Totals from the module's own table.
summaryRoute(router, { module: 'export', model: 'scheduledExport' });
