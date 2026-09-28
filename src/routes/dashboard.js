const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { buildAccessFilter, applyAccessFilter } = require('../middleware/rowSecurity');
const { visibleLinks } = require('../middleware/access');
const { currencyContext, sumInBase } = require('../utils/currency');

const router = Router();
router.use(authenticate);

// GET /api/dashboard - Aggregate stats for homepage
router.get('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfQuarter = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);

    // Live records the user may see. This counted soft-deleted records, and
    // ignored sharing, so under a Private default a rep still saw other reps'
    // deals and activities in the recent lists.
    const user = req.user || await prisma.user.findUnique({ where: { id: req.userId }, include: { role: true } });
    const [contacts, leads, accounts, deals, activities, cases] = await Promise.all([
      ['contacts', 'contact'], ['leads', 'lead'], ['accounts', 'account'],
      ['deals', 'deal'], ['activities', 'activity'], ['cases', 'case'],
    ].map(async ([module, modelName]) => {
      const filter = await buildAccessFilter(prisma, user, module, { modelName });
      return (where = {}) => applyAccessFilter({ ...where, deletedAt: null }, filter);
    }));

    const [
      contactCount, leadCount, accountCount,
      allDeals, activitiesThisMonth, casesOpen,
      recentActivities, recentDeals,
    ] = await Promise.all([
      prisma.contact.count({ where: contacts() }),
      prisma.lead.count({ where: leads({ status: { not: 'Converted' } }) }),
      prisma.account.count({ where: accounts() }),
      prisma.deal.findMany({ where: deals(), select: { id: true, stage: true, value: true, currency: true, probability: true, closeDate: true, createdAt: true } }),
      prisma.activity.count({ where: activities({ date: { gte: startOfMonth } }) }),
      prisma.case.count({ where: cases({ status: { notIn: ['Resolved', 'Closed'] } }) }),
      prisma.activity.findMany({
        where: activities(),
        orderBy: { date: 'desc' }, take: 10,
        include: { contact: { select: { id: true, firstName: true, lastName: true } }, deal: { select: { id: true, name: true } }, assignedTo: { select: { id: true, firstName: true, lastName: true } } },
      }),
      prisma.deal.findMany({
        where: deals({ createdAt: { gte: startOfMonth } }),
        orderBy: { createdAt: 'desc' }, take: 10,
        include: { account: { select: { id: true, name: true } }, owner: { select: { id: true, firstName: true, lastName: true } } },
      }),
    ]);
    // Their linked contacts, deals and accounts as far as the caller may see
    // them; the names came back whoever the records belonged to.
    await Promise.all([
      visibleLinks(req, 'activity', recentActivities, { contact: true, deal: true }),
      visibleLinks(req, 'deal', recentDeals, { account: true }),
    ]);

    // Every amount below is in the default currency: each deal's value is
    // converted before anything is added up.
    const ctx = await currencyContext(prisma);
    allDeals.forEach(d => { d.value = ctx.toBase(d.value, d.currency); });

    // Pipeline breakdown
    const openDeals = allDeals.filter(d => d.stage !== 'Closed Won' && d.stage !== 'Closed Lost');
    const wonDeals = allDeals.filter(d => d.stage === 'Closed Won');
    const lostDeals = allDeals.filter(d => d.stage === 'Closed Lost');
    const wonThisMonth = wonDeals.filter(d => d.closeDate && d.closeDate >= startOfMonth);
    const wonThisQuarter = wonDeals.filter(d => d.closeDate && d.closeDate >= startOfQuarter);

    // Conversion rates
    const totalConverted = await prisma.lead.count({ where: leads({ status: 'Converted' }) });
    const totalLeadsEver = await prisma.lead.count({ where: leads() });

    // New business, last 30 days against the 30 before. These replace the
    // fixed +12% / +8% the dashboard cards used to show. No change is
    // reported when the earlier window is empty.
    const DAY = 86400000;
    const recentFrom = new Date(now - 30 * DAY);
    const priorFrom = new Date(now - 60 * DAY);
    const openedRecently = allDeals.filter(d => d.createdAt >= recentFrom);
    const openedBefore = allDeals.filter(d => d.createdAt >= priorFrom && d.createdAt < recentFrom);
    const sumValue = list => list.reduce((s, d) => s + d.value, 0);
    const changePct = (current, previous) => (previous > 0 ? Math.round(((current - previous) / previous) * 100) : null);

    // Weighted pipeline
    const weightedPipeline = openDeals.reduce((s, d) => s + (d.value * d.probability / 100), 0);

    // Deals closing this month
    const closingThisMonth = openDeals.filter(d => {
      if (!d.closeDate) return false;
      return d.closeDate.getMonth() === now.getMonth() && d.closeDate.getFullYear() === now.getFullYear();
    });

    res.json({
      currency: ctx.base,
      counts: {
        contacts: contactCount,
        leads: leadCount,
        accounts: accountCount,
        openDeals: openDeals.length,
        // The dashboard's deal-outcome chart reads these; Lost was always 0.
        wonDeals: wonDeals.length,
        lostDeals: lostDeals.length,
        openCases: casesOpen,
        activitiesThisMonth,
      },
      pipeline: {
        totalValue: openDeals.reduce((s, d) => s + d.value, 0),
        weightedValue: Math.round(weightedPipeline),
        dealCount: openDeals.length,
        avgDealSize: openDeals.length > 0 ? Math.round(openDeals.reduce((s, d) => s + d.value, 0) / openDeals.length) : 0,
        closingThisMonth: {
          count: closingThisMonth.length,
          value: closingThisMonth.reduce((s, d) => s + d.value, 0),
        },
      },
      revenue: {
        wonThisMonth: { count: wonThisMonth.length, value: wonThisMonth.reduce((s, d) => s + d.value, 0) },
        wonThisQuarter: { count: wonThisQuarter.length, value: wonThisQuarter.reduce((s, d) => s + d.value, 0) },
        wonAllTime: { count: wonDeals.length, value: wonDeals.reduce((s, d) => s + d.value, 0) },
      },
      rates: {
        winRate: (wonDeals.length + lostDeals.length) > 0 ? Math.round(wonDeals.length / (wonDeals.length + lostDeals.length) * 100) : 0,
        leadConversion: totalLeadsEver > 0 ? Math.round(totalConverted / totalLeadsEver * 100) : 0,
      },
      trends: {
        window: '30d',
        newDeals: { current: openedRecently.length, previous: openedBefore.length, changePct: changePct(openedRecently.length, openedBefore.length) },
        newPipeline: { current: sumValue(openedRecently), previous: sumValue(openedBefore), changePct: changePct(sumValue(openedRecently), sumValue(openedBefore)) },
      },
      recentActivities,
      recentDeals,
    });
  } catch (err) { next(err); }
});

// GET /api/dashboard/leaderboard - Sales rep performance
router.get('/leaderboard', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    const users = await prisma.user.findMany({
      where: { active: true },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    const ctx = await currencyContext(prisma);

    const leaderboard = await Promise.all(users.map(async (user) => {
      const [wonDeals, openDeals, activities] = await Promise.all([
        prisma.deal.findMany({ where: { ownerId: user.id, stage: 'Closed Won', deletedAt: null }, select: { value: true, currency: true, closeDate: true } }),
        prisma.deal.findMany({ where: { ownerId: user.id, stage: { notIn: ['Closed Won', 'Closed Lost'] }, deletedAt: null }, select: { value: true, currency: true } }),
        // A rep's activities are those they own (a create sets the owner) or
        // are assigned; counting the assignee alone missed almost all of them.
        prisma.activity.count({ where: { OR: [{ ownerId: user.id }, { assignedId: user.id }], date: { gte: startOfMonth }, deletedAt: null } }),
      ]);

      const wonThisMonth = wonDeals.filter(d => d.closeDate && d.closeDate >= startOfMonth);

      // In the default currency, like every other total.
      return {
        user: { id: user.id, firstName: user.firstName, lastName: user.lastName, avatar: user.avatar },
        wonAllTime: sumInBase(wonDeals, ctx),
        wonThisMonth: sumInBase(wonThisMonth, ctx),
        openPipeline: sumInBase(openDeals, ctx),
        activitiesThisMonth: activities,
        dealCount: wonDeals.length,
      };
    }));

    leaderboard.sort((a, b) => b.wonThisMonth - a.wonThisMonth);
    res.json({ data: leaderboard });
  } catch (err) { next(err); }
});

module.exports = router;

// Dashboard widgets
router.get('/widgets', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const userId = req.user.id;

    // My tasks due today
    const today = new Date(); today.setHours(0,0,0,0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const myTasks = await prisma.activity.findMany({ where: { ownerId: userId, dueDate: { gte: today, lt: tomorrow }, status: { not: 'Completed' }, deletedAt: null }, take: 10, orderBy: { dueDate: 'asc' } });

    // My deals needing attention
    const staleDeals = await prisma.deal.findMany({ where: { ownerId: userId, stage: { notIn: ['Closed Won','Closed Lost'] }, updatedAt: { lt: new Date(Date.now() - 7*86400000) }, deletedAt: null }, take: 5, orderBy: { updatedAt: 'asc' } });

    // Overdue cases
    const overdueCases = await prisma.case.findMany({ where: { ownerId: userId, status: { notIn: ['Closed','Resolved'] }, slaDueAt: { lt: new Date() }, deletedAt: null }, take: 5 });

    res.json({ myTasks, staleDeals, overdueCases, taskCount: myTasks.length, staleDealCount: staleDeals.length, overdueCount: overdueCases.length });
  } catch (err) { next(err); }
});

// A second GET /leaderboard stood here. The one above answers that path, so
// this one never ran; it is removed rather than left to look live.
