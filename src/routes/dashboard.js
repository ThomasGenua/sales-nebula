const { Router } = require('express');
const { authenticate } = require('../middleware/auth');

const router = Router();
router.use(authenticate);

// GET /api/dashboard - Aggregate stats for homepage
router.get('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfQuarter = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);

    const [
      contactCount, leadCount, accountCount,
      allDeals, activitiesThisMonth, casesOpen,
      recentActivities, recentDeals,
    ] = await Promise.all([
      prisma.contact.count(),
      prisma.lead.count({ where: { status: { not: 'Converted' } } }),
      prisma.account.count(),
      prisma.deal.findMany({ select: { id: true, stage: true, value: true, probability: true, closeDate: true, createdAt: true } }),
      prisma.activity.count({ where: { date: { gte: startOfMonth } } }),
      prisma.case.count({ where: { status: { notIn: ['Resolved', 'Closed'] } } }),
      prisma.activity.findMany({
        orderBy: { date: 'desc' }, take: 10,
        include: { contact: { select: { id: true, firstName: true, lastName: true } }, deal: { select: { id: true, name: true } }, assignedTo: { select: { id: true, firstName: true, lastName: true } } },
      }),
      prisma.deal.findMany({
        where: { createdAt: { gte: startOfMonth } },
        orderBy: { createdAt: 'desc' }, take: 10,
        include: { account: { select: { id: true, name: true } }, owner: { select: { id: true, firstName: true, lastName: true } } },
      }),
    ]);

    // Pipeline breakdown
    const openDeals = allDeals.filter(d => d.stage !== 'Closed Won' && d.stage !== 'Closed Lost');
    const wonDeals = allDeals.filter(d => d.stage === 'Closed Won');
    const lostDeals = allDeals.filter(d => d.stage === 'Closed Lost');
    const wonThisMonth = wonDeals.filter(d => d.closeDate && d.closeDate >= startOfMonth);
    const wonThisQuarter = wonDeals.filter(d => d.closeDate && d.closeDate >= startOfQuarter);

    // Conversion rates
    const totalConverted = await prisma.lead.count({ where: { status: 'Converted' } });
    const totalLeadsEver = await prisma.lead.count();

    // Weighted pipeline
    const weightedPipeline = openDeals.reduce((s, d) => s + (d.value * d.probability / 100), 0);

    // Deals closing this month
    const closingThisMonth = openDeals.filter(d => {
      if (!d.closeDate) return false;
      return d.closeDate.getMonth() === now.getMonth() && d.closeDate.getFullYear() === now.getFullYear();
    });

    res.json({
      counts: {
        contacts: contactCount,
        leads: leadCount,
        accounts: accountCount,
        openDeals: openDeals.length,
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

    const leaderboard = await Promise.all(users.map(async (user) => {
      const [wonDeals, openDeals, activities] = await Promise.all([
        prisma.deal.findMany({ where: { ownerId: user.id, stage: 'Closed Won' }, select: { value: true, closeDate: true } }),
        prisma.deal.findMany({ where: { ownerId: user.id, stage: { notIn: ['Closed Won', 'Closed Lost'] } }, select: { value: true } }),
        prisma.activity.count({ where: { assignedId: user.id, date: { gte: startOfMonth } } }),
      ]);

      const wonThisMonth = wonDeals.filter(d => d.closeDate && d.closeDate >= startOfMonth);

      return {
        user: { id: user.id, firstName: user.firstName, lastName: user.lastName, avatar: user.avatar },
        wonAllTime: wonDeals.reduce((s, d) => s + d.value, 0),
        wonThisMonth: wonThisMonth.reduce((s, d) => s + d.value, 0),
        openPipeline: openDeals.reduce((s, d) => s + d.value, 0),
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

// Top performers
router.get('/leaderboard', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { period = '30' } = req.query;
    const since = new Date(Date.now() - (+period) * 86400000);
    const users = await prisma.user.findMany({ where: { active: true }, select: { id: true, firstName: true, lastName: true } });
    const leaderboard = [];
    for (const u of users) {
      const [won, activities] = await Promise.all([
        // A won deal's closeDate is when it closed; there is no closedAt.
        prisma.deal.aggregate({ where: { ownerId: u.id, stage: 'Closed Won', closeDate: { gte: since }, deletedAt: null }, _sum: { value: true }, _count: true }),
        prisma.activity.count({ where: { ownerId: u.id, status: 'Completed', createdAt: { gte: since }, deletedAt: null } }),
      ]);
      if ((won._count || 0) > 0 || activities > 0) {
        leaderboard.push({ user: u, wonDeals: won._count || 0, wonRevenue: won._sum.value || 0, completedActivities: activities });
      }
    }
    leaderboard.sort((a, b) => b.wonRevenue - a.wonRevenue);
    res.json(leaderboard.slice(0, 10));
  } catch (err) { next(err); }
});
