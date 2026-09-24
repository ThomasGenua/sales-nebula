const { createCrudRouter } = require('../utils/crud');
const { requirePermission } = require('../middleware/auth');
const { reachableWhere, linkRefusal } = require('../middleware/access');
const { isAdmin, subordinateUserIds } = require('../middleware/rowSecurity');
const { fireWebhookEvent } = require('../services/webhooks');

/**
 * Whose activities a list shows: the caller's own, or another user's for an
 * admin or that user's manager. `?userId=` used to return anyone's. Null
 * when the caller may not see that user's.
 */
async function listedUserId(req) {
  const userId = req.query.userId ? String(req.query.userId) : req.userId;
  if (userId === req.userId || isAdmin(req.user)) return userId;
  const reports = await subordinateUserIds(req.app.locals.prisma, req.user);
  return reports.includes(userId) ? userId : null;
}

const NOT_YOURS = 'You can only list your own activities or those of people who report to you';

// Whose an activity is: whoever it is assigned to, or, assigned to nobody,
// whoever owns it. An activity made on the page (or by a workflow) has an
// owner and no assignee, and these lists matched assignedId alone, so none
// of those ever showed up in them.
const theirs = userId => ({ OR: [{ assignedId: userId }, { assignedId: null, ownerId: userId }] });

// When an activity falls: its due date, or, with none, its date. The page
// sets dueDate; date defaults to when the record was made, so a task due
// next week was overdue the moment it was saved.
const falls = range => ({ OR: [{ dueDate: range }, { dueDate: null, date: range }] });

// Overdue: due before today (a due date is a day, so one due today is not
// late yet), or, with no due date, its date and time have passed.
function overdueWhere(now = new Date()) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { OR: [{ dueDate: { lt: startOfToday } }, { dueDate: null, date: { lt: now } }] };
}

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
        const userId = await listedUserId(req);
        if (!userId) return res.status(403).json({ error: NOT_YOURS });
        const where = {
          AND: [overdueWhere(), theirs(userId)],
          status: { notIn: ['Completed', 'Cancelled'] },
        };

        const activities = await prisma.activity.findMany({
          where: await reachableWhere(req, 'activities', 'activity', where),
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

        // Live ones only, as the other lists: deleted activities were listed.
        const activities = await prisma.activity.findMany({
          where: await reachableWhere(req, 'activities', 'activity', {
            AND: [falls({ gte: startOfDay, lt: endOfDay }), theirs(req.userId)],
          }),
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
        const { start, end } = req.query;
        if (!start || !end) return res.status(400).json({ error: 'start and end dates required' });
        const userId = await listedUserId(req);
        if (!userId) return res.status(403).json({ error: NOT_YOURS });

        if (Number.isNaN(new Date(start).getTime()) || Number.isNaN(new Date(end).getTime())) return res.status(400).json({ error: 'start and end must be dates' });
        const where = {
          AND: [falls({ gte: new Date(start), lte: new Date(end) }), theirs(userId)],
        };

        const activities = await prisma.activity.findMany({
          where: await reachableWhere(req, 'activities', 'activity', where),
          include: {
            contact: { select: { id: true, firstName: true, lastName: true } },
            deal: { select: { id: true, name: true } },
            assignedTo: { select: { id: true, firstName: true, lastName: true } },
          },
          orderBy: { date: 'asc' },
        });

        // Group by date for calendar rendering, on the day each one falls
        const byDate = {};
        activities.forEach(a => {
          const key = (a.dueDate || a.date).toISOString().split('T')[0];
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
          // When it was done: completedAt was never set.
          data: {
            status: 'Completed',
            completedAt: new Date(),
            result: req.body.result || 'Completed',
          },
          include: {
            contact: { select: { id: true, firstName: true, lastName: true } },
            deal: { select: { id: true, name: true } },
          },
        });

        // Auto-create follow-up if requested. It is the completer's, as an
        // activity they create is, and Scheduled, the status activities start
        // in; with no owner or assignee, a Private default hid it from them.
        if (req.body.followUp) {
          const due = new Date(req.body.followUp.date || Date.now() + 7 * 86400000);
          await prisma.activity.create({
            data: {
              type: req.body.followUp.type || 'Task',
              subject: req.body.followUp.subject || `Follow-up: ${activity.subject}`,
              date: due,
              dueDate: due,
              ownerId: req.userId,
              assignedId: activity.assignedId || req.userId,
              contactId: activity.contactId,
              dealId: activity.dealId,
              accountId: activity.accountId,
              status: 'Scheduled',
            },
          });
        }

        await req.audit({ action: 'update', module: 'activities', recordId: activity.id, details: `Completed activity: ${activity.subject}` });
        await fireWebhookEvent(prisma, 'activity.completed', { id: activity.id, type: activity.type });
        res.json(activity);
      } catch (err) { next(err); }
    });

    // POST /api/activities/:id/reschedule
    router.post('/:id/reschedule', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        if (!req.body.date || Number.isNaN(new Date(req.body.date).getTime())) return res.status(400).json({ error: 'date required' });
        // Moved as a whole, due date included, and back to Scheduled: the
        // due date the page shows stayed put, and 'Planned' is a status
        // nothing else gives an activity.
        const activity = await prisma.activity.update({
          where: { id: req.params.id },
          data: { date: new Date(req.body.date), dueDate: new Date(req.body.date), status: 'Scheduled', completedAt: null },
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
        startOfWeek.setHours(0, 0, 0, 0); // from the start of Sunday, not this time of day on it

        // The caller's live activities (theirs), each on the day it falls;
        // deleted ones were counted.
        const mine = where => ({ AND: [theirs(req.userId), { deletedAt: null }, where] });
        const [total, completed, overdue, thisWeek, thisMonth, byType] = await Promise.all([
          prisma.activity.count({ where: mine({}) }),
          prisma.activity.count({ where: mine({ status: 'Completed' }) }),
          prisma.activity.count({ where: mine({ AND: [overdueWhere(now), { status: { notIn: ['Completed', 'Cancelled'] } }] }) }),
          prisma.activity.count({ where: mine(falls({ gte: startOfWeek })) }),
          prisma.activity.count({ where: mine(falls({ gte: startOfMonth })) }),
          prisma.activity.groupBy({ by: ['type'], where: mine(falls({ gte: startOfMonth })), _count: true }),
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
        // Only on records the caller can see. The keys were stored as sent, so
        // a call could be filed on anyone's deal and its name read back.
        const linkProblem = await linkRefusal(req, 'activity', { contactId, dealId, accountId });
        if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
        const activity = await prisma.activity.create({
          data: {
            type: 'Call',
            subject: subject || 'Phone Call',
            description,
            duration: parseInt(duration) || 0,
            result: result || 'Completed',
            status: 'Completed',
            completedAt: new Date(),
            date: new Date(),
            // The caller's, as owner too: the stats that go by owner missed
            // every call logged here.
            ownerId: req.userId,
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
        // Only on records the caller can see, as for log-call.
        const linkProblem = await linkRefusal(req, 'activity', { contactId, dealId, accountId });
        if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
        const activity = await prisma.activity.create({
          data: {
            type: 'Meeting',
            subject: subject || 'Meeting',
            description: description || '',
            duration: parseInt(duration) || 60,
            result: req.body.result || '',
            status: date && new Date(date) > new Date() ? 'Scheduled' : 'Completed',
            ...(!(date && new Date(date) > new Date()) && { completedAt: new Date() }),
            date: date ? new Date(date) : new Date(),
            ownerId: req.userId,
            assignedId: req.userId,
            contactId, dealId, accountId,
          },
        });
        res.status(201).json(activity);
      } catch (err) { next(err); }
    });
  },
});
