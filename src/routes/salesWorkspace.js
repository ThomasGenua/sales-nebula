const { Router } = require('express');
const { authenticate, permits, requirePermission } = require('../middleware/auth');
const { reachableWhere } = require('../middleware/access');

const router = Router();
router.use(authenticate);
const STAGES = ['Qualification', 'Discovery', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'];
const openActivity = { status: { notIn: ['Completed', 'Cancelled'] } };
const mine = id => ({ OR: [{ assignedId: id }, { assignedId: null, ownerId: id }] });
const pageOf = req => Math.max(1, parseInt(req.query.page, 10) || 1);
const size = 25;

// A bounded window supplied by the browser preserves the rep's local day,
// including daylight-saving changes, instead of using the server timezone.
function dayWindow(query) {
  const start = new Date(query.start), end = new Date(query.end);
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || end <= start || end - start > 26 * 3600000) return null;
  const calendarDay = /^\d{4}-\d{2}-\d{2}$/.test(query.day || '') ? query.day : start.toISOString().slice(0, 10);
  const dueStart = new Date(`${calendarDay}T00:00:00.000Z`);
  if (!Number.isFinite(+dueStart)) return null;
  return { start, end, dueStart, dueEnd: new Date(+dueStart + 86400000) };
}

async function annotateDeals(req, deals) {
  const db = req.app.locals.prisma;
  const ids = deals.map(d => d.id);
  const mayReadTasks = permits(req, 'activities', 'read');
  const [history, tasks] = await Promise.all([
    db.dealStageHistory.findMany({ where: { dealId: { in: ids } }, orderBy: { createdAt: 'desc' } }),
    mayReadTasks ? db.activity.findMany({
      where: await reachableWhere(req, 'activities', 'activity', { dealId: { in: ids }, ...openActivity }),
      select: { id: true, subject: true, dueDate: true, date: true, dealId: true },
    }) : [],
  ]);
  const dates = new Map();
  for (const h of history) if (!dates.has(h.dealId)) dates.set(h.dealId, h.createdAt);
  const next = new Map();
  tasks.sort((a, b) => +(a.dueDate || a.date) - +(b.dueDate || b.date));
  for (const t of tasks) if (!next.has(t.dealId)) next.set(t.dealId, t);
  return deals.map(d => ({ ...d, stageSince: dates.get(d.id) || d.createdAt,
    nextAction: next.get(d.id) || null, nextActionAvailable: mayReadTasks }));
}

router.get('/my-day', async (req, res, next) => {
  try {
    const db = req.app.locals.prisma;
    const section = req.query.section || 'overdue';
    const day = dayWindow(req.query);
    if (!day) return res.status(400).json({ error: 'A valid start and end of your day are required' });
    const page = pageOf(req);
    let module, model, where, orderBy;
    if (['overdue', 'today'].includes(section)) {
      module = 'activities'; model = 'activity';
      const range = section === 'overdue' ? { lt: day.start } : { gte: day.start, lt: day.end };
      const dueRange = section === 'overdue' ? { lt: day.dueStart } : { gte: day.dueStart, lt: day.dueEnd };
      where = { AND: [mine(req.userId), openActivity, { OR: [{ dueDate: dueRange }, { dueDate: null, date: range }] }] };
      orderBy = [{ dueDate: 'asc' }, { date: 'asc' }, { id: 'asc' }];
    } else if (section === 'leads') {
      module = 'leads'; model = 'lead';
      // "New leads" is based on an explicit sales status, not an inference
      // from updatedAt (imports and automated edits also change that date).
      where = { ownerId: req.userId, status: 'New', convertedAt: null };
      orderBy = [{ createdAt: 'asc' }, { id: 'asc' }];
    } else if (section === 'deals') {
      module = 'deals'; model = 'deal';
      where = { ownerId: req.userId, stage: { notIn: ['Closed Won', 'Closed Lost'] } };
      const stale = { updatedAt: { lt: new Date(Date.now() - 14 * 86400000) } };
      if (permits(req, 'activities', 'read')) {
        const visibleTasks = await reachableWhere(req, 'activities', 'activity', openActivity);
        where.OR = [stale, { activities: { none: visibleTasks } }];
      } else Object.assign(where, stale);
      orderBy = [{ closeDate: 'asc' }, { id: 'asc' }];
    } else return res.status(400).json({ error: 'Unknown work queue section' });
    if (!permits(req, module, 'read')) return res.status(403).json({ error: `Insufficient permissions for ${module}` });
    where = await reachableWhere(req, module, model, where);
    const [rows, total] = await Promise.all([
      db[model].findMany({ where, orderBy, take: size, skip: (page - 1) * size }), db[model].count({ where }),
    ]);
    res.json({ data: module === 'deals' ? await annotateDeals(req, rows) : rows, total, page, pages: Math.ceil(total / size), module });
  } catch (err) { next(err); }
});

router.get('/pipeline', requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const db = req.app.locals.prisma;
    const filter = {};
    if (req.query.mine === 'true') filter.ownerId = req.userId;
    if (req.query.search) filter.name = { contains: String(req.query.search), mode: 'insensitive' };
    for (const [query, op] of [['closeFrom', 'gte'], ['closeTo', 'lte']]) {
      if (req.query[query]) {
        const date = new Date(String(req.query[query]) + (query === 'closeTo' ? 'T23:59:59.999Z' : 'T00:00:00.000Z'));
        if (!Number.isFinite(+date)) return res.status(400).json({ error: 'Invalid close date' });
        filter.closeDate = { ...filter.closeDate, [op]: date };
      }
    }
    const where = await reachableWhere(req, 'deals', 'deal', filter);
    const groups = await db.deal.groupBy({ by: ['stage', 'currency'], where, _count: true, _sum: { value: true } });
    const stages = [...new Set([...STAGES, ...groups.map(g => g.stage)])];
    if (req.query.stage && !stages.includes(String(req.query.stage))) return res.status(400).json({ error: 'Unknown stage' });
    const page = pageOf(req);
    const selected = req.query.stage ? [String(req.query.stage)] : stages;
    const columns = [];
    for (const stage of selected) {
      const rows = await db.deal.findMany({ where: { AND: [where, { stage }] }, orderBy: [{ closeDate: 'asc' }, { id: 'asc' }], take: size, skip: (page - 1) * size });
      const stageGroups = groups.filter(g => g.stage === stage);
      columns.push({ stage, total: stageGroups.reduce((n, g) => n + g._count, 0),
        amounts: stageGroups.map(g => ({ currency: g.currency, value: g._sum.value || 0 })),
        rows: await annotateDeals(req, rows), page });
    }
    res.json({ columns, stages, pageSize: size });
  } catch (err) { next(err); }
});

router.get('/insights', requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const db = req.app.locals.prisma;
    const deals = await db.deal.findMany({ where: await reachableWhere(req, 'deals', 'deal'), select: { id: true, stage: true, createdAt: true } });
    const history = await db.dealStageHistory.findMany({ where: { deal: { is: await reachableWhere(req, 'deals', 'deal') } }, orderBy: { createdAt: 'asc' } });
    const visits = new Map(deals.map(d => [d.id, new Set([d.stage])]));
    const wins = new Map();
    for (const h of history) { if (h.fromStage) visits.get(h.dealId)?.add(h.fromStage); visits.get(h.dealId)?.add(h.toStage); if (h.toStage === 'Closed Won') wins.set(h.dealId, h.createdAt); }
    const wonDeals = deals.filter(d => d.stage === 'Closed Won');
    const lost = deals.filter(d => d.stage === 'Closed Lost').length;
    const cycles = wonDeals.filter(d => wins.has(d.id)).map(d => Math.max(0, (wins.get(d.id) - d.createdAt) / 86400000));
    const stages = STAGES.slice(0, 4).map((stage, i) => { const next = STAGES[i + 1]; const reached = [...visits.values()].filter(v => v.has(stage)); return { stage, next, visited: reached.length, conversion: reached.length ? Math.round(reached.filter(v => v.has(next)).length / reached.length * 100) : null }; });
    res.json({ won: wonDeals.length, lost, winRate: wonDeals.length + lost ? Math.round(wonDeals.length / (wonDeals.length + lost) * 100) : 0, salesCycleDays: cycles.length ? Math.round(cycles.reduce((a, b) => a + b, 0) / cycles.length) : null, cycleSample: cycles.length, stages });
  } catch (err) { next(err); }
});

module.exports = router;
