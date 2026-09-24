const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere } = require('../middleware/access');
const { isAdmin, subordinateUserIds } = require('../middleware/rowSecurity');
const { pickModelFields } = require('../utils/modelFields');
const { currencyContext, sumInBase } = require('../utils/currency');

const router = Router();
router.use(authenticate, auditMiddleware);

const include = {
  user: { select: { id: true, firstName: true, lastName: true } },
  territory: { select: { id: true, name: true } },
  items: { include: { deal: { select: { id: true, name: true, stage: true, value: true, probability: true, closeDate: true, account: { select: { id: true, name: true } } } } } },
};

/**
 * `include`, with only the items on deals row security lets the caller see.
 * Every item came back with its deal's name, value and account, whoever's.
 */
async function includeFor(req) {
  return { ...include, items: { ...include.items, where: { deal: { is: await reachableWhere(req, 'deals', 'deal') } } } };
}

/**
 * A forecast's commit, best case, pipeline and closed from the deals
 * `dealWhere` (reachableWhere) admits: its items, loaded on those deals only,
 * and those deals closed won in its period, as POST counts them. The rollups
 * reported the stored totals, summed from every deal, so anyone with deals
 * read learned what deals they could not open were worth.
 */
async function figuresFor(prisma, forecast, dealWhere, ctx) {
  const amount = i => (i.overrideAmount != null ? i.overrideAmount : i.amount);
  const sum = keep => forecast.items.filter(i => keep(i.category)).reduce((s, i) => s + amount(i), 0);
  const closedDeals = await prisma.deal.findMany({
    where: { AND: [dealWhere, { stage: 'Closed Won', closeDate: { gte: forecast.periodStart, lte: forecast.periodEnd } }] },
    select: { value: true, currency: true },
  });
  return {
    commit: sum(c => c === 'Commit'),
    bestCase: sum(c => c === 'Commit' || c === 'Best Case'),
    pipeline: sum(c => c !== 'Omitted'),
    closed: sumInBase(closedDeals, ctx),
  };
}

/** Whether the caller is an admin or sits above `userId` in the role hierarchy. */
async function managesUser(req, userId) {
  if (isAdmin(req.user)) return true;
  return (await subordinateUserIds(req.app.locals.prisma, req.user)).includes(userId);
}

/**
 * A forecast is changed by its owner (userId), a manager above them or an
 * admin, and approved only by a manager or an admin, never its owner.
 * deals:edit, which every rep holds, was the only check, so a rep could
 * approve their own forecast and edit or delete a colleague's.
 * Its owner changes it only while it is Open: they went on editing it once
 * submitted, even after it was approved. A manager or an admin still may.
 */
function forecastAccess({ approve = false } = {}) {
  return async (req, res, next) => {
    try {
      const forecast = await req.app.locals.prisma.forecast.findUnique({ where: { id: req.params.id }, select: { userId: true, status: true, quotaAmount: true } });
      if (!forecast) return res.status(404).json({ error: 'Not found' });
      const isOwner = forecast.userId === req.userId;
      if (approve && isOwner) return res.status(403).json({ error: 'You cannot approve your own forecast' });
      const manages = await managesUser(req, forecast.userId);
      if (!isOwner && !manages) {
        return res.status(403).json({
          error: approve
            ? 'Only a manager of the forecast owner or an admin can approve it'
            : 'Only the forecast owner, their manager or an admin can change it',
        });
      }
      if (!manages && forecast.status !== 'Open') {
        return res.status(409).json({ error: `This forecast is ${forecast.status}: until it is reopened, only a manager of its owner or an admin can change it` });
      }
      req.forecast = forecast;
      next();
    } catch (err) { next(err); }
  };
}

// What PUT may change. The body went to Prisma whole, so a caller could hand
// a forecast to someone else or mark it Approved. Status moves through submit
// and approve; the totals are summed from the items.
const EDITABLE_FIELDS = ['name', 'period', 'periodStart', 'periodEnd', 'quotaAmount', 'territoryId', 'notes'];

// LIST forecasts
router.get('/', requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { period, userId, status } = req.query;
    let where = {};
    if (period) where.period = period;
    if (userId) where.userId = userId;
    if (status) where.status = status;
    const forecasts = await prisma.forecast.findMany({ where, include: await includeFor(req), orderBy: { periodStart: 'desc' } });
    res.json({ data: forecasts });
  } catch (err) { next(err); }
});

// GET one
router.get('/:id', requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const forecast = await prisma.forecast.findUnique({ where: { id: req.params.id }, include: await includeFor(req) });
    if (!forecast) return res.status(404).json({ error: 'Not found' });
    res.json(forecast);
  } catch (err) { next(err); }
});

// CREATE forecast (auto-populate items from open deals)
router.post('/', requirePermission('deals', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { period, periodStart, periodEnd, quotaAmount, territoryId, userId, status, ...rest } = req.body;

    // The creator owns it unless a manager or admin files it for a report, and
    // it starts Open. `rest` overrode both, so a rep could file an Approved
    // forecast, or one in a colleague's name.
    const forecastUserId = userId || req.userId;
    const manages = await managesUser(req, forecastUserId);
    if (forecastUserId !== req.userId && !manages) {
      return res.status(403).json({ error: 'You can only create forecasts for yourself or your reports' });
    }
    // The quota is set by the owner's manager or an admin: a rep filing their
    // own forecast set their own target.
    if (quotaAmount && !manages) {
      return res.status(403).json({ error: 'Only a manager of the forecast owner or an admin can set its quota' });
    }

    // Get open deals closing in this period, of those the caller can see: a
    // forecast was built from every deal, and its items showed them.
    const deals = await prisma.deal.findMany({
      where: await reachableWhere(req, 'deals', 'deal', {
        stage: { notIn: ['Closed Won', 'Closed Lost'] },
        closeDate: { gte: new Date(periodStart), lte: new Date(periodEnd) },
        deletedAt: null,
        ...(req.body.ownerId ? { ownerId: req.body.ownerId } : {}),
      }),
    });

    // A forecast is in the default currency, so each deal's amount is
    // converted as it is added.
    const ctx = await currencyContext(prisma);

    // Auto-categorize based on probability
    const items = deals.map(d => ({
      dealId: d.id,
      amount: ctx.toBase(d.value, d.currency),
      probability: d.probability,
      closeDate: d.closeDate,
      category: d.probability >= 90 ? 'Commit' : d.probability >= 70 ? 'Best Case' : 'Pipeline',
    }));

    const commit = items.filter(i => i.category === 'Commit').reduce((s, i) => s + i.amount, 0);
    const bestCase = items.filter(i => i.category === 'Best Case' || i.category === 'Commit').reduce((s, i) => s + i.amount, 0);
    const pipeline = items.reduce((s, i) => s + i.amount, 0);

    // Get already closed deals in period, likewise
    const closedDeals = await prisma.deal.findMany({
      where: await reachableWhere(req, 'deals', 'deal', { stage: 'Closed Won', closeDate: { gte: new Date(periodStart), lte: new Date(periodEnd) }, deletedAt: null }),
    });
    const closed = sumInBase(closedDeals, ctx);

    const forecast = await prisma.forecast.create({
      data: {
        name: `${period} Forecast`,
        period,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        userId: forecastUserId,
        quotaAmount: quotaAmount || 0,
        commit, bestCase, pipeline, closed,
        territoryId: territoryId || null,
        // Only the fields PUT may change: `rest` could also override the
        // totals summed above, or carry nested writes.
        ...pickModelFields('forecast', Object.fromEntries(
          EDITABLE_FIELDS.filter(f => rest[f] !== undefined && !['period', 'periodStart', 'periodEnd', 'quotaAmount', 'territoryId'].includes(f)).map(f => [f, rest[f]])
        )).data,
        items: { create: items },
      },
      include,
    });

    await req.audit({ action: 'create', module: 'forecasts', recordId: forecast.id, details: `Created ${period} forecast with ${items.length} items` });
    res.status(201).json(forecast);
  } catch (err) { next(err); }
});

// UPDATE forecast
router.put('/:id', requirePermission('deals', 'edit'), forecastAccess(), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const body = req.body || {};
    const { data } = pickModelFields('forecast', Object.fromEntries(
      EDITABLE_FIELDS.filter(f => body[f] !== undefined).map(f => [f, body[f]])
    ));
    // The quota, the target it is measured against, is changed by the owner's
    // manager or an admin: its owner could set their own.
    if (data.quotaAmount !== undefined && data.quotaAmount !== req.forecast.quotaAmount && !(await managesUser(req, req.forecast.userId))) {
      return res.status(403).json({ error: 'Only a manager of the forecast owner or an admin can set its quota' });
    }
    const forecast = await prisma.forecast.update({ where: { id: req.params.id }, data, include: await includeFor(req) });
    res.json(forecast);
  } catch (err) { next(err); }
});

// UPDATE forecast item (recategorize or override)
router.put('/:id/items/:itemId', requirePermission('deals', 'edit'), forecastAccess(), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { category, overrideAmount, notes } = req.body;
    // An item of the forecast in the path: any forecast's items went by id.
    // Its deal must be one the caller can see, as GET shows only those; the
    // reply carries the whole deal.
    const onForecast = await prisma.forecastItem.findFirst({
      where: { id: req.params.itemId, forecastId: req.params.id, deal: { is: await reachableWhere(req, 'deals', 'deal') } },
      select: { id: true },
    });
    if (!onForecast) return res.status(404).json({ error: 'Not found' });
    const item = await prisma.forecastItem.update({
      where: { id: onForecast.id },
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
router.post('/:id/submit', requirePermission('deals', 'edit'), forecastAccess(), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const forecast = await prisma.forecast.update({ where: { id: req.params.id }, data: { status: 'Submitted' }, include: await includeFor(req) });
    await req.audit({ action: 'update', module: 'forecasts', recordId: forecast.id, details: 'Forecast submitted' });
    res.json(forecast);
  } catch (err) { next(err); }
});

// APPROVE forecast
router.post('/:id/approve', requirePermission('deals', 'edit'), forecastAccess({ approve: true }), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const forecast = await prisma.forecast.update({ where: { id: req.params.id }, data: { status: 'Approved' }, include: await includeFor(req) });
    await req.audit({ action: 'update', module: 'forecasts', recordId: forecast.id, details: 'Forecast approved' });
    res.json(forecast);
  } catch (err) { next(err); }
});

// GET rollup summary (manager view across all reps)
// Registered before /:id/rollup, which took `stats` for a forecast id, so this
// never answered.
router.get('/stats/rollup', requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { period } = req.query;
    let where = {};
    if (period) where.period = period;
    // Each forecast's figures from the deals the caller can see (figuresFor),
    // so a manager counts a report's deals where row security shows them.
    const dealWhere = await reachableWhere(req, 'deals', 'deal');
    const ctx = await currencyContext(prisma);
    const found = await prisma.forecast.findMany({
      where,
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
        territory: { select: { id: true, name: true } },
        items: { where: { deal: { is: dealWhere } }, select: { category: true, amount: true, overrideAmount: true } },
      },
    });
    const forecasts = await Promise.all(found.map(async f => ({ ...f, ...(await figuresFor(prisma, f, dealWhere, ctx)) })));

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

// GET per-forecast rollup
router.get('/:id/rollup', requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Items on deals the caller can see only, and figures from those deals.
    const dealWhere = await reachableWhere(req, 'deals', 'deal');
    const forecast = await prisma.forecast.findUnique({
      where: { id: req.params.id },
      include: { items: { where: { deal: { is: dealWhere } }, include: { deal: { select: { id: true, name: true, stage: true, value: true, probability: true, closeDate: true, account: { select: { name: true } } } } } } },
    });
    if (!forecast) return res.status(404).json({ error: 'Not found' });
    const { commit, bestCase, pipeline, closed } = await figuresFor(prisma, forecast, dealWhere, await currencyContext(prisma));

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
      commit,
      bestCase,
      pipeline,
      closed,
      attainment: forecast.quotaAmount > 0 ? Math.round(closed / forecast.quotaAmount * 100) : 0,
      gap: Math.max(0, forecast.quotaAmount - closed),
      byCategory,
    });
  } catch (err) { next(err); }
});

// DELETE
router.delete('/:id', requirePermission('deals', 'full'), forecastAccess(), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.forecast.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
