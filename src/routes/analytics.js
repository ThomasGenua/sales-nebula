const { Router } = require('express');
const { Prisma } = require('@prisma/client');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { reachableWhere } = require('../middleware/access');
const { isAdmin } = require('../middleware/rowSecurity');
const { pickModelFields, scalarWhere, scalarSelect } = require('../utils/modelFields');
const { dealTotalInBase } = require('../utils/currency');
const router = Router();
router.use(authenticate);

const QUERY_MODELS = { contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account', cases: 'case', activities: 'activity', products: 'product', invoices: 'invoice', quotes: 'quote', campaigns: 'campaign', contracts: 'contract', orders: 'order' };
const MODULE_OF_MODEL = Object.fromEntries(Object.entries(QUERY_MODELS).map(([module, model]) => [model, module]));
const dmmfModel = name => Prisma.dmmf.datamodel.models.find(m => m.name.toLowerCase() === String(name).toLowerCase());

/** Where a saved item belongs to the caller, unless they are an administrator. */
const ownedBy = (req, id) => (isAdmin(req.user) ? { id } : { id, createdById: req.userId });

// Datasets
router.get('/datasets', requirePermission('reports', 'read'), async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.analyticsDataset.findMany({ orderBy: { updatedAt: 'desc' } }) }); }
  catch (err) { next(err); }
});
router.post('/datasets', requirePermission('reports', 'edit'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.analyticsDataset.create({ data: { ...pickModelFields('analyticsDataset', req.body).data, createdById: req.userId } })); }
  catch (err) { next(err); }
});
router.post('/datasets/:id/refresh', requirePermission('reports', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const ds = await prisma.analyticsDataset.findUnique({ where: { id: req.params.id } });
    if (!ds) return res.status(404).json({ error: 'Not found' });
    // Execute cross-module query
    let totalRows = 0;
    for (const mod of ds.sourceModules) {
      const MODEL_MAP = { contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account', cases: 'case', activities: 'activity', products: 'product' };
      const model = MODEL_MAP[mod];
      if (model && prisma[model]) { totalRows += await prisma[model].count(); }
    }
    await prisma.analyticsDataset.update({ where: { id: ds.id }, data: { lastRefreshed: new Date(), rowCount: totalRows } });
    res.json({ refreshed: true, rowCount: totalRows });
  } catch (err) { next(err); }
});

// Dashboards
router.get('/dashboards', requirePermission('reports', 'read'), async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.analyticsDashboard.findMany({ orderBy: { updatedAt: 'desc' } }) }); }
  catch (err) { next(err); }
});
router.post('/dashboards', requirePermission('reports', 'edit'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.analyticsDashboard.create({ data: { ...pickModelFields('analyticsDashboard', req.body).data, createdById: req.userId } })); }
  catch (err) { next(err); }
});
router.put('/dashboards/:id', requirePermission('reports', 'edit'), async (req, res, next) => {
  try {
    // The caller's own dashboard: this rewrote anyone's, with any columns.
    const { id, createdById, createdAt, updatedAt, ...rest } = req.body || {};
    const { count } = await req.app.locals.prisma.analyticsDashboard.updateMany({ where: ownedBy(req, req.params.id), data: pickModelFields('analyticsDashboard', rest).data });
    if (!count) return res.status(404).json({ error: 'Not found' });
    res.json(await req.app.locals.prisma.analyticsDashboard.findUnique({ where: { id: req.params.id } }));
  }
  catch (err) { next(err); }
});

// Cross-object query engine
// It ran any `where` and any join, on any module, for anyone signed in: every
// row of twelve modules, and through a join to `owner` with fields
// ["password"], password hashes. Now: read permission on the source module,
// the caller's rows only, plain filters on its own columns, and joins only to
// the modules above the caller can read, their own columns only.
router.post('/query', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { from, joins, where: conditions, orderBy, limit } = req.body || {};
    const model = QUERY_MODELS[from];
    if (!model || !prisma[model]) return res.status(400).json({ error: 'Invalid source module' });
    if (!permits(req, from, 'read')) return res.status(403).json({ error: `Insufficient permissions for ${from}` });

    const relations = dmmfModel(model).fields.filter(f => f.kind === 'object');
    const include = {};
    for (const join of Array.isArray(joins) ? joins : []) {
      const rel = relations.find(r => r.name === String(join?.module || '').replace(/s$/, '') && !r.isList);
      const joinedModule = rel && MODULE_OF_MODEL[rel.type.charAt(0).toLowerCase() + rel.type.slice(1)];
      if (!joinedModule || !permits(req, joinedModule, 'read')) continue;
      include[rel.name] = { select: scalarSelect(rel.type, join.fields) || { id: true } };
    }

    const [sortField, direction] = orderBy && typeof orderBy === 'object' ? Object.entries(orderBy)[0] || [] : [];
    const sortable = sortField && dmmfModel(model).fields.some(f => f.name === sortField && f.kind !== 'object');
    const results = await prisma[model].findMany({
      where: await reachableWhere(req, from, model, scalarWhere(model, conditions)),
      include: Object.keys(include).length > 0 ? include : undefined,
      take: Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 10000),
      orderBy: sortable ? { [sortField]: direction === 'asc' ? 'asc' : 'desc' } : { createdAt: 'desc' },
    });
    res.json({ data: results, count: results.length, query: { from, joins, where: conditions } });
  } catch (err) { next(err); }
});

// Report types
router.get('/report-types', requirePermission('reports', 'read'), async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.reportType.findMany({ where: { active: true } }) }); }
  catch (err) { next(err); }
});
router.post('/report-types', requirePermission('admin', 'edit'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.reportType.create({ data: { ...pickModelFields('reportType', req.body).data, isCustom: true } })); }
  catch (err) { next(err); }
});

// Scheduled reports
router.get('/scheduled-reports', async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.scheduledReport.findMany({ where: { createdById: req.userId } }) }); }
  catch (err) { next(err); }
});
// A scheduled report is its creator's: these changed or deleted anyone's.
router.post('/scheduled-reports', requirePermission('reports', 'edit'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.scheduledReport.create({ data: { ...pickModelFields('scheduledReport', req.body).data, createdById: req.userId } })); }
  catch (err) { next(err); }
});
router.put('/scheduled-reports/:id', requirePermission('reports', 'edit'), async (req, res, next) => {
  try {
    const { id, createdById, createdAt, updatedAt, ...rest } = req.body || {};
    const { count } = await req.app.locals.prisma.scheduledReport.updateMany({ where: ownedBy(req, req.params.id), data: pickModelFields('scheduledReport', rest).data });
    if (!count) return res.status(404).json({ error: 'Not found' });
    res.json(await req.app.locals.prisma.scheduledReport.findUnique({ where: { id: req.params.id } }));
  }
  catch (err) { next(err); }
});
router.delete('/scheduled-reports/:id', requirePermission('reports', 'edit'), async (req, res, next) => {
  try {
    const { count } = await req.app.locals.prisma.scheduledReport.deleteMany({ where: ownedBy(req, req.params.id) });
    if (!count) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  }
  catch (err) { next(err); }
});

module.exports = router;

// Organisation-wide figures, for whoever may read reports; anyone signed in
// could, before.
// Sales funnel analysis
router.get('/funnel', authenticate, requirePermission('reports', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { period = '90' } = req.query;
    const since = new Date(Date.now() - (+period) * 86400000);
    const stages = ['Qualification','Discovery','Proposal','Negotiation','Closed Won','Closed Lost'];
    const funnel = [];
    for (const stage of stages) {
      const count = await prisma.deal.count({ where: { stage, createdAt: { gte: since }, deletedAt: null } });
      const { value } = await dealTotalInBase(prisma, { stage, createdAt: { gte: since }, deletedAt: null });
      funnel.push({ stage, count, value });
    }
    const topEntry = funnel[0]?.count || 1;
    funnel.forEach(f => { f.conversionRate = Math.round((f.count / topEntry) * 100); });
    res.json({ period: +period, funnel });
  } catch (err) { next(err); }
});

// Cohort analysis
router.get('/cohort', authenticate, requirePermission('reports', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { months = 6 } = req.query;
    const cohorts = [];
    for (let i = 0; i < +months; i++) {
      const start = new Date(); start.setMonth(start.getMonth() - i); start.setDate(1); start.setHours(0,0,0,0);
      const end = new Date(start); end.setMonth(end.getMonth() + 1);
      const [created, converted, won] = await Promise.all([
        prisma.lead.count({ where: { createdAt: { gte: start, lt: end }, deletedAt: null } }),
        prisma.lead.count({ where: { createdAt: { gte: start, lt: end }, convertedAt: { not: null }, deletedAt: null } }),
        prisma.deal.count({ where: { createdAt: { gte: start, lt: end }, stage: 'Closed Won', deletedAt: null } }),
      ]);
      cohorts.push({ month: start.toISOString().substring(0, 7), leadsCreated: created, converted, dealsWon: won, conversionRate: created ? Math.round((converted / created) * 100) : 0 });
    }
    res.json(cohorts.reverse());
  } catch (err) { next(err); }
});

// Activity effectiveness
router.get('/activity-effectiveness', authenticate, requirePermission('reports', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const types = ['Call','Email','Meeting','Task','Demo'];
    const effectiveness = [];
    for (const type of types) {
      const [total, completed, withDeals] = await Promise.all([
        prisma.activity.count({ where: { type, deletedAt: null } }),
        prisma.activity.count({ where: { type, status: 'Completed', deletedAt: null } }),
        prisma.activity.count({ where: { type, deletedAt: null, deal: { stage: 'Closed Won' } } }).catch(() => 0),
      ]);
      effectiveness.push({ type, total, completed, completionRate: total ? Math.round((completed / total) * 100) : 0, dealInfluence: withDeals });
    }
    res.json(effectiveness);
  } catch (err) { next(err); }
});
