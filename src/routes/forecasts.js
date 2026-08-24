const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();
router.use(authenticate, auditMiddleware);

const include = {
  user: { select: { id: true, firstName: true, lastName: true } },
  territory: { select: { id: true, name: true } },
  items: { include: { deal: { select: { id: true, name: true, stage: true, value: true, probability: true, closeDate: true, account: { select: { id: true, name: true } } } } } },
};

// LIST forecasts
router.get('/', requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { period, userId, status } = req.query;
    let where = {};
    if (period) where.period = period;
    if (userId) where.userId = userId;
    if (status) where.status = status;
    const forecasts = await prisma.forecast.findMany({ where, include, orderBy: { periodStart: 'desc' } });
    res.json({ data: forecasts });
  } catch (err) { next(err); }
});

// GET one
router.get('/:id', requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const forecast = await prisma.forecast.findUnique({ where: { id: req.params.id }, include });
    if (!forecast) return res.status(404).json({ error: 'Not found' });
    res.json(forecast);
  } catch (err) { next(err); }
});

// CREATE forecast (auto-populate items from open deals)
router.post('/', requirePermission('deals', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { period, periodStart, periodEnd, quotaAmount, territoryId, ...rest } = req.body;

    // Get open deals closing in this period
    const deals = await prisma.deal.findMany({
      where: {
        stage: { notIn: ['Closed Won', 'Closed Lost'] },
        closeDate: { gte: new Date(periodStart), lte: new Date(periodEnd) },
        ...(req.body.ownerId ? { ownerId: req.body.ownerId } : {}),
      },
    });

    // Auto-categorize based on probability
    const items = deals.map(d => ({
      dealId: d.id,
      amount: d.value,
      probability: d.probability,
      closeDate: d.closeDate,
      category: d.probability >= 90 ? 'Commit' : d.probability >= 70 ? 'Best Case' : 'Pipeline',
    }));

    const commit = items.filter(i => i.category === 'Commit').reduce((s, i) => s + i.amount, 0);
    const bestCase = items.filter(i => i.category === 'Best Case' || i.category === 'Commit').reduce((s, i) => s + i.amount, 0);
    const pipeline = items.reduce((s, i) => s + i.amount, 0);

    // Get already closed deals in period
    const closedDeals = await prisma.deal.findMany({
      where: { stage: 'Closed Won', closeDate: { gte: new Date(periodStart), lte: new Date(periodEnd) } },
    });
    const closed = closedDeals.reduce((s, d) => s + d.value, 0);

    const forecast = await prisma.forecast.create({
      data: {
        name: `${period} Forecast`,
        period,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        userId: req.userId,
        quotaAmount: quotaAmount || 0,
        commit, bestCase, pipeline, closed,
        territoryId: territoryId || null,
        ...rest,
        items: { create: items },
      },
      include,
    });

    await req.audit({ action: 'create', module: 'forecasts', recordId: forecast.id, details: `Created ${period} forecast with ${items.length} items` });
    res.status(201).json(forecast);
  } catch (err) { next(err); }
});

// UPDATE forecast
router.put('/:id', requirePermission('deals', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { items, id, createdAt, updatedAt, user, territory, ...data } = req.body;
    const forecast = await prisma.forecast.update({ where: { id: req.params.id }, data, include });
    res.json(forecast);
  } catch (err) { next(err); }
});

// UPDATE forecast item (recategorize or override)
router.put('/:id/items/:itemId', requirePermission('deals', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { category, overrideAmount, notes } = req.body;
    const item = await prisma.forecastItem.update({
      where: { id: req.params.itemId },
      data: { ...(category && { category }), ...(overrideAmount !== undefined && { overrideAmount }), ...(notes && { notes }) },
      include: { deal: true },
    });

    // Recalculate forecast totals
    const allItems = await prisma.forecastItem.findMany({ where: { forecastId: req.params.id } });
    const getAmt = (i) => i.overrideAmount != null ? i.overrideAmount : i.amount;
    const commit = allItems.filter(i => i.category === 'Commit').reduce((s, i) => s + getAmt(i), 0);
    const bestCase = allItems.filter(i => ['Commit', 'Best Case'].includes(i.category)).reduce((s, i) => s + getAmt(i), 0);
    const pipeline = allItems.filter(i => i.category !== 'Omitted').reduce((s, i) => s + getAmt(i), 0);
    await prisma.forecast.update({ where: { id: req.params.id }, data: { commit, bestCase, pipeline } });

    res.json(item);
  } catch (err) { next(err); }
});

// SUBMIT forecast
router.post('/:id/submit', requirePermission('deals', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const forecast = await prisma.forecast.update({ where: { id: req.params.id }, data: { status: 'Submitted' }, include });
    await req.audit({ action: 'update', module: 'forecasts', recordId: forecast.id, details: 'Forecast submitted' });
    res.json(forecast);
  } catch (err) { next(err); }
});

// APPROVE forecast
router.post('/:id/approve', requirePermission('deals', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const forecast = await prisma.forecast.update({ where: { id: req.params.id }, data: { status: 'Approved' }, include });
    await req.audit({ action: 'update', module: 'forecasts', recordId: forecast.id, details: 'Forecast approved' });
    res.json(forecast);
  } catch (err) { next(err); }
});

// GET per-forecast rollup
router.get('/:id/rollup', requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const forecast = await prisma.forecast.findUnique({
      where: { id: req.params.id },
      include: { items: { include: { deal: { select: { id: true, name: true, stage: true, value: true, probability: true, closeDate: true, account: { select: { name: true } } } } } } },
    });
    if (!forecast) return res.status(404).json({ error: 'Not found' });

    const getAmt = (i) => i.overrideAmount != null ? i.overrideAmount : i.amount;
    const byCategory = {};
    for (const item of forecast.items) {
      if (!byCategory[item.category]) byCategory[item.category] = { count: 0, amount: 0, items: [] };
      byCategory[item.category].count++;
      byCategory[item.category].amount += getAmt(item);
      byCategory[item.category].items.push({
        dealId: item.deal.id,
        dealName: item.deal.name,
        account: item.deal.account?.name,
        amount: getAmt(item),
        probability: item.probability,
        closeDate: item.deal.closeDate,
        stage: item.deal.stage,
      });
    }

    res.json({
      forecastId: forecast.id,
      period: forecast.period,
      quota: forecast.quotaAmount,
      commit: forecast.commit,
      bestCase: forecast.bestCase,
      pipeline: forecast.pipeline,
      closed: forecast.closed,
      attainment: forecast.quotaAmount > 0 ? Math.round(forecast.closed / forecast.quotaAmount * 100) : 0,
      gap: Math.max(0, forecast.quotaAmount - forecast.closed),
      byCategory,
    });
  } catch (err) { next(err); }
});

// GET rollup summary (manager view across all reps)
router.get('/stats/rollup', requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { period } = req.query;
    let where = {};
    if (period) where.period = period;
    const forecasts = await prisma.forecast.findMany({ where, include: { user: { select: { id: true, firstName: true, lastName: true } }, territory: { select: { id: true, name: true } } } });

    const rollup = {
      totalQuota: forecasts.reduce((s, f) => s + f.quotaAmount, 0),
      totalCommit: forecasts.reduce((s, f) => s + f.commit, 0),
      totalBestCase: forecasts.reduce((s, f) => s + f.bestCase, 0),
      totalPipeline: forecasts.reduce((s, f) => s + f.pipeline, 0),
      totalClosed: forecasts.reduce((s, f) => s + f.closed, 0),
      byRep: forecasts.map(f => ({
        user: f.user,
        territory: f.territory,
        quota: f.quotaAmount,
        commit: f.commit,
        bestCase: f.bestCase,
        pipeline: f.pipeline,
        closed: f.closed,
        attainment: f.quotaAmount > 0 ? Math.round(f.closed / f.quotaAmount * 100) : 0,
      })),
    };
    rollup.attainment = rollup.totalQuota > 0 ? Math.round(rollup.totalClosed / rollup.totalQuota * 100) : 0;
    rollup.gap = rollup.totalQuota - rollup.totalClosed;
    rollup.coverage = rollup.gap > 0 ? (rollup.totalPipeline / rollup.gap).toFixed(1) : 'N/A';

    res.json(rollup);
  } catch (err) { next(err); }
});

// DELETE
router.delete('/:id', requirePermission('deals', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.forecast.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
