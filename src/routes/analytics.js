const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { dealTotalInBase } = require('../utils/currency');
const router = Router();
router.use(authenticate);

// Datasets
router.get('/datasets', async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.analyticsDataset.findMany({ orderBy: { updatedAt: 'desc' } }) }); }
  catch (err) { next(err); }
});
router.post('/datasets', requirePermission('reports', 'edit'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.analyticsDataset.create({ data: { ...req.body, createdById: req.userId } })); }
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
router.get('/dashboards', async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.analyticsDashboard.findMany({ orderBy: { updatedAt: 'desc' } }) }); }
  catch (err) { next(err); }
});
router.post('/dashboards', requirePermission('reports', 'edit'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.analyticsDashboard.create({ data: { ...req.body, createdById: req.userId } })); }
  catch (err) { next(err); }
});
router.put('/dashboards/:id', requirePermission('reports', 'edit'), async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.analyticsDashboard.update({ where: { id: req.params.id }, data: req.body })); }
  catch (err) { next(err); }
});

// Cross-object query engine
router.post('/query', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { from, joins, select, where: conditions, groupBy, orderBy, limit } = req.body;
    const MODEL_MAP = { contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account', cases: 'case', activities: 'activity', products: 'product', invoices: 'invoice', quotes: 'quote', campaigns: 'campaign', contracts: 'contract', orders: 'order' };
    const model = MODEL_MAP[from];
    if (!model || !prisma[model]) return res.status(400).json({ error: 'Invalid source module' });
    const include = {};
    if (joins) {
      for (const join of joins) {
        const rel = join.module.replace(/s$/, '');
        include[rel] = { select: join.fields ? Object.fromEntries(join.fields.map(f => [f, true])) : undefined };
      }
    }
    const queryWhere = {};
    if (conditions) Object.entries(conditions).forEach(([k, v]) => { queryWhere[k] = v; });
    const results = await prisma[model].findMany({
      where: queryWhere, include: Object.keys(include).length > 0 ? include : undefined,
      take: Math.min(parseInt(limit) || 1000, 10000), orderBy: orderBy || { createdAt: 'desc' },
    });
    res.json({ data: results, count: results.length, query: { from, joins, where: conditions } });
  } catch (err) { next(err); }
});

// Report types
router.get('/report-types', async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.reportType.findMany({ where: { active: true } }) }); }
  catch (err) { next(err); }
});
router.post('/report-types', requirePermission('admin', 'edit'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.reportType.create({ data: { ...req.body, isCustom: true } })); }
  catch (err) { next(err); }
});

// Scheduled reports
router.get('/scheduled-reports', async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.scheduledReport.findMany({ where: { createdById: req.userId } }) }); }
  catch (err) { next(err); }
});
router.post('/scheduled-reports', async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.scheduledReport.create({ data: { ...req.body, createdById: req.userId } })); }
  catch (err) { next(err); }
});
router.put('/scheduled-reports/:id', async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.scheduledReport.update({ where: { id: req.params.id }, data: req.body })); }
  catch (err) { next(err); }
});
router.delete('/scheduled-reports/:id', async (req, res, next) => {
  try { await req.app.locals.prisma.scheduledReport.delete({ where: { id: req.params.id } }); res.json({ success: true }); }
  catch (err) { next(err); }
});

module.exports = router;

// Sales funnel analysis
router.get('/funnel', authenticate, async (req, res, next) => {
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
router.get('/cohort', authenticate, async (req, res, next) => {
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
router.get('/activity-effectiveness', authenticate, async (req, res, next) => {
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
