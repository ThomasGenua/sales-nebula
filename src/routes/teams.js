const { Router } = require('express');
const { currencyContext, sumInBase } = require('../utils/currency');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere } = require('../middleware/access');

const router = Router();
router.use(authenticate, auditMiddleware);

/**
 * Whether the account or deal a team route names is a live one the caller may
 * see (Read) or change (Edit), as canReach judges it; otherwise answers 404.
 * Any id was taken: a missing one failed on its foreign key (500), and a team
 * was read or changed on an account or deal the caller could not open.
 */
async function reachableParent(req, res, module, modelName, id, minLevel) {
  const found = await req.app.locals.prisma[modelName].findFirst({
    where: await reachableWhere(req, module, modelName, { id: String(id) }, minLevel), select: { id: true },
  });
  if (!found) res.status(404).json({ error: `${modelName === 'deal' ? 'Deal' : 'Account'} not found` });
  return !!found;
}

/** Whether `userId` names an active user, who alone may join a team; otherwise answers 400. */
async function activeUser(req, res, userId) {
  const user = userId ? await req.app.locals.prisma.user.findFirst({ where: { id: String(userId), active: true }, select: { id: true } }) : null;
  if (!user) res.status(400).json({ error: 'userId must name an active user' });
  return !!user;
}

/**
 * The member `memberId` of the team at `where` (its account or deal), or null
 * once it has answered 404. Edits and removals took the member id alone, so
 * the account or deal in the path was never looked at.
 */
async function teamMember(req, res, delegate, where) {
  const member = await req.app.locals.prisma[delegate].findFirst({ where: { id: req.params.memberId, ...where }, select: { id: true } });
  if (!member) res.status(404).json({ error: 'Team member not found' });
  return member;
}

/**
 * The live team at :id with its members (and their names), when the caller may
 * see its numbers: one of its members, its manager, or someone who may read
 * users. Otherwise null, once it has answered 404 as for a missing team. Any
 * team's revenue and workload went to anyone signed in.
 */
async function findTeam(req, res, members) {
  const team = await req.app.locals.prisma.team.findFirst({ where: { id: req.params.id, deletedAt: null }, include: { members } });
  const mayView = !!team && (team.managerId === req.user.id || team.members.some(m => m.userId === req.user.id) || permits(req, 'users', 'read'));
  if (!mayView) res.status(404).json({ error: 'Team not found' });
  return mayView ? team : null;
}

// ─── ACCOUNT TEAMS ───
router.get('/account/:accountId', requirePermission('accounts', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!(await reachableParent(req, res, 'accounts', 'account', req.params.accountId, 'Read'))) return;
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
    if (!(await reachableParent(req, res, 'accounts', 'account', req.params.accountId, 'Edit'))) return;
    if (!(await activeUser(req, res, req.body.userId))) return;
    const member = await prisma.accountTeam.create({
      data: { accountId: req.params.accountId, userId: String(req.body.userId), role: req.body.role || 'Team Member', access: req.body.access || 'read' },
    });
    await req.audit({ action: 'create', module: 'account_teams', recordId: member.id, details: `Added team member` });
    res.status(201).json(member);
  } catch (err) { next(err); }
});

router.put('/account/:accountId/:memberId', requirePermission('accounts', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!(await reachableParent(req, res, 'accounts', 'account', req.params.accountId, 'Edit'))) return;
    if (!(await teamMember(req, res, 'accountTeam', { accountId: req.params.accountId }))) return;
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
    if (!(await reachableParent(req, res, 'accounts', 'account', req.params.accountId, 'Edit'))) return;
    if (!(await teamMember(req, res, 'accountTeam', { accountId: req.params.accountId }))) return;
    await prisma.accountTeam.delete({ where: { id: req.params.memberId } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── DEAL TEAMS ───
router.get('/deal/:dealId', requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!(await reachableParent(req, res, 'deals', 'deal', req.params.dealId, 'Read'))) return;
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
    if (!(await reachableParent(req, res, 'deals', 'deal', req.params.dealId, 'Edit'))) return;
    if (!(await activeUser(req, res, req.body.userId))) return;
    const member = await prisma.dealTeam.create({
      data: {
        dealId: req.params.dealId, userId: String(req.body.userId),
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
    if (!(await reachableParent(req, res, 'deals', 'deal', req.params.dealId, 'Edit'))) return;
    if (!(await teamMember(req, res, 'dealTeam', { dealId: req.params.dealId }))) return;
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
    if (!(await reachableParent(req, res, 'deals', 'deal', req.params.dealId, 'Edit'))) return;
    if (!(await teamMember(req, res, 'dealTeam', { dealId: req.params.dealId }))) return;
    await prisma.dealTeam.delete({ where: { id: req.params.memberId } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;

// Team performance metrics
router.get('/:id/performance', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const team = await findTeam(req, res, true);
    if (!team) return;
    const memberIds = team.members.map(m => m.userId);
    const [deals, closedWon, activities] = await Promise.all([
      prisma.deal.findMany({ where: { ownerId: { in: memberIds }, deletedAt: null } }),
      prisma.deal.findMany({ where: { ownerId: { in: memberIds }, stage: 'Closed Won', deletedAt: null } }),
      prisma.activity.count({ where: { ownerId: { in: memberIds }, deletedAt: null, createdAt: { gte: new Date(Date.now() - 30*86400000) } } }),
    ]);
    // In the default currency; each deal's value is converted first.
    const ctx = await currencyContext(prisma);
    const pipeline = sumInBase(deals.filter(d => !['Closed Won','Closed Lost'].includes(d.stage)), ctx);
    const won = sumInBase(closedWon, ctx);
    // Of the deals decided, as the dashboard counts it; open deals counted as losses.
    const decided = closedWon.length + deals.filter(d => d.stage === 'Closed Lost').length;
    const winRate = decided ? Math.round(closedWon.length / decided * 100) : 0;
    res.json({ teamId: team.id, members: memberIds.length, pipeline, wonRevenue: won, winRate, activitiesLast30Days: activities, avgDealSize: closedWon.length ? Math.round(won / closedWon.length) : 0 });
  } catch (err) { next(err); }
});

// Team leaderboard
router.get('/:id/leaderboard', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const team = await findTeam(req, res, { include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } } });
    if (!team) return;
    const board = [];
    const ctx = await currencyContext(prisma);
    for (const m of team.members) {
      const [wonDeals, activities] = await Promise.all([
        prisma.deal.findMany({ where: { ownerId: m.userId, stage: 'Closed Won', deletedAt: null } }),
        prisma.activity.count({ where: { ownerId: m.userId, status: 'Completed', deletedAt: null } }),
      ]);
      board.push({ user: m.user, wonDeals: wonDeals.length, wonRevenue: sumInBase(wonDeals, ctx), activitiesCompleted: activities, role: m.role });
    }
    board.sort((a, b) => b.wonRevenue - a.wonRevenue);
    res.json(board);
  } catch (err) { next(err); }
});

// Team performance analytics
router.get('/:id/analytics', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const team = await findTeam(req, res, { include: { user: { select: { id: true, firstName: true, lastName: true } } } });
    if (!team) return;
    const memberIds = team.members.map(m => m.userId);
    const thirtyDays = new Date(Date.now() - 30 * 86400000);
    const [deals, activities, cases] = await Promise.all([
      prisma.deal.findMany({ where: { ownerId: { in: memberIds }, deletedAt: null, updatedAt: { gte: thirtyDays } }, select: { ownerId: true, value: true, currency: true, stage: true } }),
      // Completed live activities of the last 30 days. Completing one sets its
      // status and not completedAt, which this alone asked for, so it read 0;
      // a completion time is used where there is one, else the activity's date.
      prisma.activity.count({ where: { ownerId: { in: memberIds }, status: 'Completed', deletedAt: null, OR: [{ completedAt: { gte: thirtyDays } }, { completedAt: null, date: { gte: thirtyDays } }] } }),
      prisma.case.findMany({ where: { ownerId: { in: memberIds }, deletedAt: null, createdAt: { gte: thirtyDays } }, select: { ownerId: true, status: true } }),
    ]);
    const wonDeals = deals.filter(d => d.stage === 'Closed Won');
    const ctx = await currencyContext(prisma);
    const totalRevenue = sumInBase(wonDeals, ctx);
    const memberStats = memberIds.map(uid => {
      const user = team.members.find(m => m.userId === uid)?.user;
      const userDeals = deals.filter(d => d.ownerId === uid);
      return { userId: uid, name: `${user?.firstName || ''} ${user?.lastName || ''}`.trim(), deals: userDeals.length, wonDeals: userDeals.filter(d => d.stage === 'Closed Won').length, revenue: sumInBase(userDeals.filter(d => d.stage === 'Closed Won'), ctx) };
    });
    res.json({ teamId: team.id, teamName: team.name, members: memberStats, totals: { deals: deals.length, wonDeals: wonDeals.length, totalRevenue, activitiesCompleted: activities, casesOpened: cases.length }, period: '30d' });
  } catch (err) { next(err); }
});

// Workload distribution
router.get('/:id/workload', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const team = await findTeam(req, res, { include: { user: { select: { id: true, firstName: true, lastName: true } } } });
    if (!team) return;
    const memberIds = team.members.map(m => m.userId);
    const workload = [];
    for (const uid of memberIds) {
      const user = team.members.find(m => m.userId === uid)?.user;
      // Open as activities.js and the dashboard mean it. No activity is ever
      // 'Open' or 'InProgress' (they are Scheduled, Planned, Pending), so open
      // tasks were always 0, and resolved cases were counted as open.
      const [openDeals, openTasks, openCases] = await Promise.all([
        prisma.deal.count({ where: { ownerId: uid, stage: { notIn: ['Closed Won', 'Closed Lost'] }, deletedAt: null } }),
        prisma.activity.count({ where: { ownerId: uid, status: { notIn: ['Completed', 'Cancelled'] }, deletedAt: null } }),
        prisma.case.count({ where: { ownerId: uid, status: { notIn: ['Resolved', 'Closed'] }, deletedAt: null } }),
      ]);
      workload.push({ userId: uid, name: `${user?.firstName || ''} ${user?.lastName || ''}`.trim(), openDeals, openTasks, openCases, totalLoad: openDeals + openTasks + openCases });
    }
    workload.sort((a, b) => b.totalLoad - a.totalLoad);
    res.json({ teamId: team.id, workload, avgLoad: workload.length ? (workload.reduce((s, w) => s + w.totalLoad, 0) / workload.length).toFixed(1) : 0 });
  } catch (err) { next(err); }
});
