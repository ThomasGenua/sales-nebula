const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { queryWithIncludes } = require('../utils/modelFields');

const router = Router();
router.use(authenticate);

// Publishing fans out to every subscriber's webhook and socket, and the
// history holds every payload; both took a session alone.

// ─── EVENT PUBLISHING ───
router.post('/publish', requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { channel, payload, module, recordId } = req.body;
    if (!channel) return res.status(400).json({ error: 'channel required' });

    const event = await prisma.platformEvent.create({
      data: { channel, payload: payload || {}, userId: req.userId, module, recordId },
    });

    // Dispatch to subscribers
    const subs = await prisma.eventSubscription.findMany({ where: { active: true } });
    const matching = subs.filter(s => {
      if (s.channel === channel) return true;
      if (s.channel.endsWith('.*')) return channel.startsWith(s.channel.replace('.*', '.'));
      if (s.channel === '*') return true;
      return false;
    });

    const dispatched = [];
    for (const sub of matching) {
      if (sub.type === 'websocket') {
        req.app.locals.emit?.(channel, { event, payload });
        dispatched.push({ type: 'websocket', channel });
      } else if (sub.type === 'webhook') {
        // Async webhook delivery
        const { fireWebhookEvent } = require('../services/webhooks');
        fireWebhookEvent(channel, { event: event.id, channel, payload, module, recordId }, req.app.locals.prisma).catch(() => {});
        dispatched.push({ type: 'webhook', endpoint: sub.endpoint });
      }
    }

    res.status(201).json({ event, dispatched: dispatched.length, subscribers: matching.length });
  } catch (err) { next(err); }
});

// ─── EVENT HISTORY ───
router.get('/history', requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const { channel, module, limit = 50, before } = req.query;
    const where = {};
    if (channel) where.channel = channel;
    if (module) where.module = module;
    if (before) where.createdAt = { lt: new Date(before) };
    const events = await req.app.locals.prisma.platformEvent.findMany({
      where, orderBy: { createdAt: 'desc' }, take: Math.min(parseInt(limit) || 50, 200),
    });
    res.json({ data: events });
  } catch (err) { next(err); }
});

// ─── SUBSCRIPTIONS CRUD ───
// Each row carries a webhook's endpoint and HMAC secret; this took a session alone.
router.get('/subscriptions', requirePermission('admin', 'read'), async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.eventSubscription.findMany() }); }
  catch (err) { next(err); }
});

router.post('/subscriptions', requirePermission('admin', 'edit'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.eventSubscription.create({ data: req.body })); }
  catch (err) { next(err); }
});

router.put('/subscriptions/:id', requirePermission('admin', 'edit'), async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.eventSubscription.update({ where: { id: req.params.id }, data: req.body })); }
  catch (err) { next(err); }
});

router.delete('/subscriptions/:id', requirePermission('admin', 'full'), async (req, res, next) => {
  try { await req.app.locals.prisma.eventSubscription.delete({ where: { id: req.params.id } }); res.json({ success: true }); }
  catch (err) { next(err); }
});

module.exports = router;

// Event attendees management
router.post('/:id/attendees', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { contactIds, leadIds, userIds } = req.body;
    const event = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!event) return res.status(404).json({ error: 'Not found' });
    const attendees = [];
    for (const cId of (contactIds || [])) { attendees.push(await prisma.eventAttendee.create({ data: { eventId: event.id, contactId: cId, status: 'Invited' } }).catch(() => null)); }
    for (const lId of (leadIds || [])) { attendees.push(await prisma.eventAttendee.create({ data: { eventId: event.id, leadId: lId, status: 'Invited' } }).catch(() => null)); }
    for (const uId of (userIds || [])) { attendees.push(await prisma.eventAttendee.create({ data: { eventId: event.id, userId: uId, status: 'Accepted' } }).catch(() => null)); }
    res.json({ added: attendees.filter(Boolean).length });
  } catch (err) { next(err); }
});

router.get('/:id/attendees', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const attendees = await queryWithIncludes(prisma, 'eventAttendee', 'findMany', { where: { eventId: req.params.id }, include: { contact: { select: { firstName: true, lastName: true, email: true } }, lead: { select: { firstName: true, lastName: true, email: true } } } });
    res.json(attendees);
  } catch (err) { next(err); }
});

// RSVP
router.put('/:eventId/attendees/:attendeeId/rsvp', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { status } = req.body;
    if (!['Accepted', 'Declined', 'Tentative'].includes(status)) return res.status(400).json({ error: 'status must be Accepted, Declined, or Tentative' });
    const att = await prisma.eventAttendee.update({ where: { id: req.params.attendeeId }, data: { status, respondedAt: new Date() } });
    res.json(att);
  } catch (err) { next(err); }
});

// Recurring events
router.post('/:id/recurrence', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { frequency, interval, count, endDate } = req.body;
    if (!frequency || !['daily', 'weekly', 'monthly'].includes(frequency)) return res.status(400).json({ error: 'frequency required (daily/weekly/monthly)' });
    const parent = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!parent) return res.status(404).json({ error: 'Not found' });
    const created = [];
    const intervalMs = { daily: 86400000, weekly: 604800000, monthly: 2592000000 }[frequency] * (interval || 1);
    const maxCount = Math.min(count || 12, 52);
    let startTime = new Date(parent.startDate).getTime();
    for (let i = 0; i < maxCount; i++) {
      startTime += intervalMs;
      if (endDate && startTime > new Date(endDate).getTime()) break;
      const dur = parent.endDate ? new Date(parent.endDate) - new Date(parent.startDate) : 3600000;
      const ev = await prisma.event.create({ data: { name: parent.name, description: parent.description, location: parent.location, startDate: new Date(startTime), endDate: new Date(startTime + dur), type: parent.type, ownerId: parent.ownerId, recurrenceParentId: parent.id } });
      created.push(ev.id);
    }
    res.json({ parentId: parent.id, createdEvents: created.length, eventIds: created });
  } catch (err) { next(err); }
});

// Calendar view
router.get('/calendar/range', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end dates required' });
    const events = await queryWithIncludes(prisma, 'event', 'findMany', { where: { startDate: { gte: new Date(start) }, endDate: { lte: new Date(end) }, deletedAt: null }, orderBy: { startDate: 'asc' }, include: { owner: { select: { firstName: true, lastName: true } } } });
    const grouped = {};
    events.forEach(e => { const day = new Date(e.startDate).toISOString().split('T')[0]; (grouped[day] = grouped[day] || []).push(e); });
    res.json({ range: { start, end }, totalEvents: events.length, byDate: grouped });
  } catch (err) { next(err); }
});

// Event reminders
router.post('/:id/reminder', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { minutesBefore } = req.body;
    const event = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!event) return res.status(404).json({ error: 'Not found' });
    const reminderTime = new Date(new Date(event.startDate).getTime() - (minutesBefore || 15) * 60000);
    await prisma.event.update({ where: { id: req.params.id }, data: { reminderMinutes: minutesBefore || 15, reminderAt: reminderTime } });
    res.json({ eventId: event.id, reminderAt: reminderTime, minutesBefore: minutesBefore || 15 });
  } catch (err) { next(err); }
});
