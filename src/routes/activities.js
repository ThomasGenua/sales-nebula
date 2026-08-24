const { createCrudRouter } = require('../utils/crud');
const { requirePermission } = require('../middleware/auth');

module.exports = createCrudRouter('activity', 'activities', {
  include: {
    contact: { select: { id: true, firstName: true, lastName: true } },
    deal: { select: { id: true, name: true, stage: true } },
    assignedTo: { select: { id: true, firstName: true, lastName: true } },
  },
  searchFilter: (q) => ({ subject: { contains: q, mode: 'insensitive' } }),
  validate: (data) => {
    const errors = {};
    if (!data.subject?.trim()) errors.subject = 'Required';
    return { valid: Object.keys(errors).length === 0, errors };
  },
  orderBy: { date: 'desc' },
  customRoutes: (router) => {
    // GET /api/activities/overdue - Activities past due
    router.get('/overdue/list', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const where = {
          date: { lt: new Date() },
          status: { notIn: ['Completed', 'Cancelled'] },
        };
        if (req.query.userId) where.assignedId = req.query.userId;
        else where.assignedId = req.userId;

        const activities = await prisma.activity.findMany({
          where,
          include: {
            contact: { select: { id: true, firstName: true, lastName: true } },
            deal: { select: { id: true, name: true, stage: true } },
          },
          orderBy: { date: 'asc' },
        });
        res.json({ data: activities, count: activities.length });
      } catch (err) { next(err); }
    });

    // GET /api/activities/today - Today's activities
    router.get('/today/list', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const today = new Date();
        const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const endOfDay = new Date(startOfDay.getTime() + 86400000);

        const activities = await prisma.activity.findMany({
          where: {
            assignedId: req.userId,
            date: { gte: startOfDay, lt: endOfDay },
          },
          include: {
            contact: { select: { id: true, firstName: true, lastName: true } },
            deal: { select: { id: true, name: true } },
          },
          orderBy: { date: 'asc' },
        });
        res.json({ data: activities });
      } catch (err) { next(err); }
    });

    // GET /api/activities/calendar - Calendar view (date range)
    router.get('/calendar/range', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const { start, end, userId } = req.query;
        if (!start || !end) return res.status(400).json({ error: 'start and end dates required' });

        const where = {
          date: { gte: new Date(start), lte: new Date(end) },
        };
        if (userId) where.assignedId = userId;

        const activities = await prisma.activity.findMany({
          where,
          include: {
            contact: { select: { id: true, firstName: true, lastName: true } },
            deal: { select: { id: true, name: true } },
            assignedTo: { select: { id: true, firstName: true, lastName: true } },
          },
          orderBy: { date: 'asc' },
        });

        // Group by date for calendar rendering
        const byDate = {};
        activities.forEach(a => {
          const key = a.date.toISOString().split('T')[0];
          if (!byDate[key]) byDate[key] = [];
          byDate[key].push(a);
        });

        res.json({ data: activities, byDate, total: activities.length });
      } catch (err) { next(err); }
    });

    // POST /api/activities/:id/complete - Mark as completed
    router.post('/:id/complete', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const activity = await prisma.activity.update({
          where: { id: req.params.id },
          data: {
            status: 'Completed',
            result: req.body.result || 'Completed',
          },
          include: {
            contact: { select: { id: true, firstName: true, lastName: true } },
            deal: { select: { id: true, name: true } },
          },
        });

        // Auto-create follow-up if requested
        if (req.body.followUp) {
          await prisma.activity.create({
            data: {
              type: req.body.followUp.type || 'Task',
              subject: req.body.followUp.subject || `Follow-up: ${activity.subject}`,
              date: new Date(req.body.followUp.date || Date.now() + 7 * 86400000),
              assignedId: activity.assignedId,
              contactId: activity.contactId,
              dealId: activity.dealId,
              accountId: activity.accountId,
              status: 'Planned',
            },
          });
        }

        await req.audit({ action: 'update', module: 'activities', recordId: activity.id, details: `Completed activity: ${activity.subject}` });
        res.json(activity);
      } catch (err) { next(err); }
    });

    // POST /api/activities/:id/reschedule
    router.post('/:id/reschedule', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        if (!req.body.date) return res.status(400).json({ error: 'date required' });
        const activity = await prisma.activity.update({
          where: { id: req.params.id },
          data: { date: new Date(req.body.date), status: 'Planned' },
        });
        res.json(activity);
      } catch (err) { next(err); }
    });

    // GET /api/activities/stats/summary - Activity metrics
    router.get('/stats/summary', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay());

        const [total, completed, overdue, thisWeek, thisMonth, byType] = await Promise.all([
          prisma.activity.count({ where: { assignedId: req.userId } }),
          prisma.activity.count({ where: { assignedId: req.userId, status: 'Completed' } }),
          prisma.activity.count({ where: { assignedId: req.userId, date: { lt: now }, status: { notIn: ['Completed', 'Cancelled'] } } }),
          prisma.activity.count({ where: { assignedId: req.userId, date: { gte: startOfWeek } } }),
          prisma.activity.count({ where: { assignedId: req.userId, date: { gte: startOfMonth } } }),
          prisma.activity.groupBy({ by: ['type'], where: { assignedId: req.userId, date: { gte: startOfMonth } }, _count: true }),
        ]);

        res.json({
          total, completed, overdue, thisWeek, thisMonth,
          completionRate: total > 0 ? Math.round(completed / total * 100) : 0,
          byType: Object.fromEntries(byType.map(b => [b.type, b._count])),
        });
      } catch (err) { next(err); }
    });

    // POST /api/activities/log-call - Quick log a call
    router.post('/log-call', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const { contactId, dealId, accountId, subject, description, duration, result } = req.body;
        const activity = await prisma.activity.create({
          data: {
            type: 'Call',
            subject: subject || 'Phone Call',
            description,
            duration: parseInt(duration) || 0,
            result: result || 'Completed',
            status: 'Completed',
            date: new Date(),
            assignedId: req.userId,
            contactId, dealId, accountId,
          },
          include: {
            contact: { select: { id: true, firstName: true, lastName: true } },
            deal: { select: { id: true, name: true } },
          },
        });
        res.status(201).json(activity);
      } catch (err) { next(err); }
    });

    // POST /api/activities/log-meeting
    router.post('/log-meeting', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const { contactId, dealId, accountId, subject, description, duration, date, attendees } = req.body;
        const activity = await prisma.activity.create({
          data: {
            type: 'Meeting',
            subject: subject || 'Meeting',
            description: description || '',
            duration: parseInt(duration) || 60,
            result: req.body.result || '',
            status: date && new Date(date) > new Date() ? 'Planned' : 'Completed',
            date: date ? new Date(date) : new Date(),
            assignedId: req.userId,
            contactId, dealId, accountId,
          },
        });
        res.status(201).json(activity);
      } catch (err) { next(err); }
    });
  },
});
