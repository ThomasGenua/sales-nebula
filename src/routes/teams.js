const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();
router.use(authenticate, auditMiddleware);

// ─── ACCOUNT TEAMS ───
router.get('/account/:accountId', requirePermission('accounts', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const members = await prisma.accountTeam.findMany({
      where: { accountId: req.params.accountId },
      include: { account: { select: { id: true, name: true } } },
    });
    res.json({ data: members });
  } catch (err) { next(err); }
});

router.post('/account/:accountId', requirePermission('accounts', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const member = await prisma.accountTeam.create({
      data: { accountId: req.params.accountId, userId: req.body.userId, role: req.body.role || 'Team Member', access: req.body.access || 'read' },
    });
    await req.audit({ action: 'create', module: 'account_teams', recordId: member.id, details: `Added team member` });
    res.status(201).json(member);
  } catch (err) { next(err); }
});

router.put('/account/:accountId/:memberId', requirePermission('accounts', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const member = await prisma.accountTeam.update({
      where: { id: req.params.memberId },
      data: { role: req.body.role, access: req.body.access },
    });
    res.json(member);
  } catch (err) { next(err); }
});

router.delete('/account/:accountId/:memberId', requirePermission('accounts', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.accountTeam.delete({ where: { id: req.params.memberId } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── DEAL TEAMS ───
router.get('/deal/:dealId', requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const members = await prisma.dealTeam.findMany({
      where: { dealId: req.params.dealId },
      include: { deal: { select: { id: true, name: true } } },
    });
    res.json({ data: members });
  } catch (err) { next(err); }
});

router.post('/deal/:dealId', requirePermission('deals', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const member = await prisma.dealTeam.create({
      data: {
        dealId: req.params.dealId, userId: req.body.userId,
        role: req.body.role || 'Team Member', access: req.body.access || 'read',
        splitPercent: req.body.splitPercent,
      },
    });
    await req.audit({ action: 'create', module: 'deal_teams', recordId: member.id, details: `Added deal team member` });
    res.status(201).json(member);
  } catch (err) { next(err); }
});

router.put('/deal/:dealId/:memberId', requirePermission('deals', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const member = await prisma.dealTeam.update({
      where: { id: req.params.memberId },
      data: { role: req.body.role, access: req.body.access, splitPercent: req.body.splitPercent },
    });
    res.json(member);
  } catch (err) { next(err); }
});

router.delete('/deal/:dealId/:memberId', requirePermission('deals', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.dealTeam.delete({ where: { id: req.params.memberId } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;

// Team performance metrics
router.get('/:id/performance', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const team = await prisma.team.findUnique({ where: { id: req.params.id }, include: { members: true } });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    const memberIds = team.members.map(m => m.userId);
    const [deals, closedWon, activities] = await Promise.all([
      prisma.deal.findMany({ where: { ownerId: { in: memberIds }, deletedAt: null } }),
      prisma.deal.findMany({ where: { ownerId: { in: memberIds }, stage: 'Closed Won', deletedAt: null } }),
      prisma.activity.count({ where: { ownerId: { in: memberIds }, deletedAt: null, createdAt: { gte: new Date(Date.now() - 30*86400000) } } }),
    ]);
    const pipeline = deals.filter(d => !['Closed Won','Closed Lost'].includes(d.stage)).reduce((s, d) => s + (d.value || 0), 0);
    const won = closedWon.reduce((s, d) => s + (d.value || 0), 0);
    const winRate = deals.length ? Math.round(closedWon.length / deals.length * 100) : 0;
    res.json({ teamId: team.id, members: memberIds.length, pipeline, wonRevenue: won, winRate, activitiesLast30Days: activities, avgDealSize: closedWon.length ? Math.round(won / closedWon.length) : 0 });
  } catch (err) { next(err); }
});

// Team leaderboard
router.get('/:id/leaderboard', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const team = await prisma.team.findUnique({ where: { id: req.params.id }, include: { members: { include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } } } } });
    if (!team) return res.status(404).json({ error: 'Not found' });
    const board = [];
    for (const m of team.members) {
      const [wonDeals, activities] = await Promise.all([
        prisma.deal.findMany({ where: { ownerId: m.userId, stage: 'Closed Won', deletedAt: null } }),
        prisma.activity.count({ where: { ownerId: m.userId, status: 'Completed', deletedAt: null } }),
      ]);
      board.push({ user: m.user, wonDeals: wonDeals.length, wonRevenue: wonDeals.reduce((s, d) => s + (d.value || 0), 0), activitiesCompleted: activities, role: m.role });
    }
    board.sort((a, b) => b.wonRevenue - a.wonRevenue);
    res.json(board);
  } catch (err) { next(err); }
});

// Team performance analytics
router.get('/:id/analytics', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const team = await prisma.team.findUnique({ where: { id: req.params.id }, include: { members: { include: { user: { select: { id: true, firstName: true, lastName: true } } } } } });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    const memberIds = team.members.map(m => m.userId);
    const thirtyDays = new Date(Date.now() - 30 * 86400000);
    const [deals, activities, cases] = await Promise.all([
      prisma.deal.findMany({ where: { ownerId: { in: memberIds }, deletedAt: null, updatedAt: { gte: thirtyDays } }, select: { ownerId: true, value: true, stage: true } }),
      prisma.activity.count({ where: { ownerId: { in: memberIds }, completedAt: { not: null }, completedAt: { gte: thirtyDays } } }),
      prisma.case.findMany({ where: { ownerId: { in: memberIds }, deletedAt: null, createdAt: { gte: thirtyDays } }, select: { ownerId: true, status: true } }),
    ]);
    const wonDeals = deals.filter(d => d.stage === 'Closed Won');
    const totalRevenue = wonDeals.reduce((s, d) => s + (d.value || 0), 0);
    const memberStats = memberIds.map(uid => {
      const user = team.members.find(m => m.userId === uid)?.user;
      const userDeals = deals.filter(d => d.ownerId === uid);
      return { userId: uid, name: `${user?.firstName || ''} ${user?.lastName || ''}`.trim(), deals: userDeals.length, wonDeals: userDeals.filter(d => d.stage === 'Closed Won').length, revenue: userDeals.filter(d => d.stage === 'Closed Won').reduce((s, d) => s + (d.value || 0), 0) };
    });
    res.json({ teamId: team.id, teamName: team.name, members: memberStats, totals: { deals: deals.length, wonDeals: wonDeals.length, totalRevenue, activitiesCompleted: activities, casesOpened: cases.length }, period: '30d' });
  } catch (err) { next(err); }
});

// Workload distribution
router.get('/:id/workload', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const team = await prisma.team.findUnique({ where: { id: req.params.id }, include: { members: { include: { user: { select: { id: true, firstName: true, lastName: true } } } } } });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    const memberIds = team.members.map(m => m.userId);
    const workload = [];
    for (const uid of memberIds) {
      const user = team.members.find(m => m.userId === uid)?.user;
      const [openDeals, openTasks, openCases] = await Promise.all([
        prisma.deal.count({ where: { ownerId: uid, stage: { notIn: ['Closed Won', 'Closed Lost'] }, deletedAt: null } }),
        prisma.activity.count({ where: { ownerId: uid, status: { in: ['Open', 'InProgress'] }, deletedAt: null } }),
        prisma.case.count({ where: { ownerId: uid, status: { not: 'Closed' }, deletedAt: null } }),
      ]);
      workload.push({ userId: uid, name: `${user?.firstName || ''} ${user?.lastName || ''}`.trim(), openDeals, openTasks, openCases, totalLoad: openDeals + openTasks + openCases });
    }
    workload.sort((a, b) => b.totalLoad - a.totalLoad);
    res.json({ teamId: team.id, workload, avgLoad: workload.length ? (workload.reduce((s, w) => s + w.totalLoad, 0) / workload.length).toFixed(1) : 0 });
  } catch (err) { next(err); }
});
