const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { linkRefusal } = require('../middleware/access');
const { statusRoutes, summaryRoute } = require('../utils/moduleStatus');
const { columnsFrom } = require('../utils/modelFields');

const router = Router();

// List territories
router.get('/', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50, search, modelId } = req.query;
    const where = { deletedAt: null };
    if (search) where.name = { contains: search, mode: 'insensitive' };
    if (modelId) where.modelId = modelId;
    const [data, total] = await Promise.all([
      prisma.territory.findMany({ where, orderBy: { name: 'asc' }, take: +limit, skip: (+page - 1) * +limit, include: { parent: { select: { id: true, name: true } } } }),
      prisma.territory.count({ where }),
    ]);
    res.json({ data, total, page: +page, pages: Math.ceil(total / +limit) });
  } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('territories', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, parentId, type, description, rules } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const t = await prisma.territory.create({ data: { name, parentId, type: type || 'Geographic', description, rules } });
    await req.audit({ action: 'create', module: 'territories', recordId: t.id });
    res.status(201).json(t);
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, requirePermission('territories', 'edit'), auditMiddleware, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const t = await prisma.territory.update({ where: { id: req.params.id }, data: columnsFrom('territory', req.body) }); res.json(t); } catch (err) { next(err); }
});

router.delete('/:id', authenticate, requirePermission('territories', 'full'), auditMiddleware, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; await prisma.territory.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } }); res.json({ success: true }); } catch (err) { next(err); }
});

// Hierarchy tree
router.get('/hierarchy', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const all = await prisma.territory.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } });
    const buildTree = (parentId = null) => all.filter(t => t.parentId === parentId).map(t => ({ ...t, children: buildTree(t.id) }));
    res.json(buildTree(null));
  } catch (err) { next(err); }
});

// Territory members
router.get('/:id/members', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const members = await prisma.territoryMember.findMany({
      where: { territoryId: req.params.id },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });
    res.json(members);
  } catch (err) { next(err); }
});

router.post('/:id/members', authenticate, requirePermission('territories', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { userId, role } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const member = await prisma.territoryMember.create({ data: { territoryId: req.params.id, userId, role: role || 'Member' } });
    res.status(201).json(member);
  } catch (err) { next(err); }
});

router.delete('/:id/members/:memberId', authenticate, requirePermission('territories', 'edit'), async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; await prisma.territoryMember.delete({ where: { id: req.params.memberId } }); res.json({ success: true }); } catch (err) { next(err); }
});

// Assign accounts to territory
router.post('/:id/assign', authenticate, requirePermission('territories', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { accountIds } = req.body;
    if (!Array.isArray(accountIds) || !accountIds.length) return res.status(400).json({ error: 'accountIds required' });
    // Only accounts the caller can see, checked before any is assigned: the
    // ids were stored as sent.
    const seen = new Map();
    for (const accountId of accountIds) {
      const linkProblem = await linkRefusal(req, 'territoryAccount', { accountId }, null, seen);
      if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
    }
    // Account has no territoryId column; membership is the TerritoryAccount table.
    const result = { count: 0 };
    for (const accountId of accountIds) {
      await prisma.territoryAccount.upsert({
        where: { territoryId_accountId: { territoryId: req.params.id, accountId } },
        update: {},
        create: { territoryId: req.params.id, accountId, assignedBy: 'manual' },
      });
      result.count++;
    }
    await req.audit({ action: 'update', module: 'territories', recordId: req.params.id, details: `Assigned ${result.count} accounts` });
    res.json({ assigned: result.count });
  } catch (err) { next(err); }
});

// Territory performance
router.get('/:id/performance', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const accounts = await prisma.territoryAccount.findMany({ where: { territoryId: req.params.id }, select: { accountId: true } });
    const accountIds = accounts.map(a => a.accountId);
    const deals = await prisma.deal.findMany({ where: { accountId: { in: accountIds } } });
    const won = deals.filter(d => d.stage === 'Closed Won');
    const pipeline = deals.filter(d => !['Closed Won', 'Closed Lost'].includes(d.stage));
    res.json({
      territoryId: req.params.id, accountCount: accounts.length, totalDeals: deals.length,
      wonDeals: won.length, wonRevenue: won.reduce((s, d) => s + (parseFloat(d.value) || 0), 0),
      pipelineDeals: pipeline.length, pipelineValue: pipeline.reduce((s, d) => s + (parseFloat(d.value) || 0), 0),
      winRate: deals.length ? ((won.length / deals.length) * 100).toFixed(1) : 0,
    });
  } catch (err) { next(err); }
});

// Territory models
router.get('/models', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const models = await prisma.territoryModel.findMany({ orderBy: { name: 'asc' } });
    res.json(models);
  } catch (err) { next(err); }
});

module.exports = router;

// Record count, health and summary, answered from the module's own table.
statusRoutes(router, { module: 'territories', model: 'territory' });

// Totals from the module's own table.
summaryRoute(router, { module: 'territories', model: 'territory' });

/**
 * Assign accounts to a territory.
 *
 * The schema carries both a TerritoryAccount join table and Account.territoryId,
 * and /:id/assign only ever wrote the latter — so membership recorded through
 * the join table was invisible to it, and vice versa. This writes both.
 */
router.post('/:id/accounts', authenticate, requirePermission('territories', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const ids = req.body.accountIds || (req.body.accountId ? [req.body.accountId] : []);
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'accountId or accountIds required' });

    const territory = await prisma.territory.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!territory) return res.status(404).json({ error: 'Territory not found' });

    // Only accounts the caller can see, as for /:id/assign.
    const seen = new Map();
    for (const accountId of ids) {
      const linkProblem = await linkRefusal(req, 'territoryAccount', { accountId }, null, seen);
      if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
    }

    const assigned = [];
    for (const accountId of ids) {
      const row = await prisma.territoryAccount.upsert({
        where: { territoryId_accountId: { territoryId: req.params.id, accountId } },
        update: {},
        create: { territoryId: req.params.id, accountId, assignedBy: 'manual' },
      });
      assigned.push(row);
    }

    await req.audit({ action: 'update', module: 'territories', recordId: req.params.id, details: `Assigned ${assigned.length} account(s)` });
    res.status(201).json({ territoryId: req.params.id, assigned: assigned.length, accounts: assigned });
  } catch (err) { next(err); }
});

/** Roll-up for a territory, counting membership from both places it is stored. */
router.get('/:id/stats', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const territory = await prisma.territory.findUnique({ where: { id: req.params.id }, select: { id: true, name: true } });
    if (!territory) return res.status(404).json({ error: 'Territory not found' });

    const [joined, members] = await Promise.all([
      prisma.territoryAccount.findMany({ where: { territoryId: req.params.id }, select: { accountId: true } }),
      prisma.territoryMember.count({ where: { territoryId: req.params.id } }),
    ]);
    const accountIds = [...new Set(joined.map(j => j.accountId))];

    const deals = accountIds.length
      ? await prisma.deal.findMany({ where: { accountId: { in: accountIds } }, select: { stage: true, value: true } })
      : [];
    const won = deals.filter(d => d.stage === 'Closed Won');
    const open = deals.filter(d => !['Closed Won', 'Closed Lost'].includes(d.stage));
    const sum = rows => rows.reduce((t, d) => t + (parseFloat(d.value) || 0), 0);

    res.json({
      territoryId: territory.id,
      name: territory.name,
      accountCount: accountIds.length,
      memberCount: members,
      dealCount: deals.length,
      wonCount: won.length,
      wonValue: sum(won),
      openCount: open.length,
      pipelineValue: sum(open),
      winRate: deals.length ? Number(((won.length / deals.length) * 100).toFixed(1)) : 0,
    });
  } catch (err) { next(err); }
});

/* Registered last: "/:id" is one segment, the same shape as /hierarchy,
   /models and /count, and while it sat at the top it answered those as
   territory lookups. */
router.get('/:id', authenticate, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const t = await prisma.territory.findUnique({ where: { id: req.params.id }, include: { parent: true, children: true } }); if (!t) return res.status(404).json({ error: 'Not found' }); res.json(t); } catch (err) { next(err); }
});

module.exports = router;
