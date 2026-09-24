const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { reachableWhere } = require('../middleware/access');
const { isAdmin } = require('../middleware/rowSecurity');
const { queryWithIncludes, columnsFrom } = require('../utils/modelFields');

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
    let webhooksSent = false;
    for (const sub of matching) {
      if (sub.type === 'websocket') {
        req.app.locals.emit?.(channel, { event, payload });
        dispatched.push({ type: 'websocket', channel });
      } else if (sub.type === 'webhook') {
        // Async webhook delivery. The signature is (prisma, event, payload);
        // called as (channel, payload, prisma), it threw inside and sent nothing.
        // Delivered once per publish, however many subscriptions match (each
        // match sent every webhook the event again), and as platform.<channel>:
        // the caller names the channel, and unprefixed it could pass for a
        // system event (deals.created), signed with each webhook's secret.
        if (!webhooksSent) {
          const { fireWebhookEvent } = require('../services/webhooks');
          fireWebhookEvent(prisma, `platform.${channel}`, { event: event.id, channel, payload, module, recordId }).catch(() => {});
          webhooksSent = true;
        }
        dispatched.push({ type: 'webhook', endpoint: sub.endpoint });
      }
    }

    res.status(201).json({ event, dispatched: dispatched.length, subscribers: matching.length });
  } catch (err) { next(err); }
});

// ─── EVENT HISTORY ───
// Payloads can carry record data from any module, so reading them takes
// admin: full. admin: read, which the Sales Rep role holds, read them all.
router.get('/history', requirePermission('admin', 'full'), async (req, res, next) => {
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
// The list masks the secret, as webhooks.js does: admin read is a sales rep's
// level, and it handed them every subscription's signing key.
router.get('/subscriptions', requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const subs = await req.app.locals.prisma.eventSubscription.findMany();
    res.json({ data: subs.map(s => ({ ...s, secret: s.secret ? '****' : null })) });
  } catch (err) { next(err); }
});

// The subscription's own columns: the body went to Prisma whole.
router.post('/subscriptions', requirePermission('admin', 'edit'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.eventSubscription.create({ data: columnsFrom('eventSubscription', req.body) })); }
  catch (err) { next(err); }
});

router.put('/subscriptions/:id', requirePermission('admin', 'edit'), async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.eventSubscription.update({ where: { id: req.params.id }, data: columnsFrom('eventSubscription', req.body) })); }
  catch (err) { next(err); }
});

router.delete('/subscriptions/:id', requirePermission('admin', 'full'), async (req, res, next) => {
  try { await req.app.locals.prisma.eventSubscription.delete({ where: { id: req.params.id } }); res.json({ success: true }); }
  catch (err) { next(err); }
});

module.exports = router;

// ─── EVENTS ───
// Calendar entries (Event), under the activities permission as the calendar's
// are (calendar.js). These took a session and any event id: anyone signed in
// listed every event, read any event's attendees, invited people to, copied
// and set reminders on events not theirs, and answered anyone's invitation.

/** Events the caller may see (theirs, ones they made or attend) or, with edit, change; an admin, any. */
function eventScope(req, edit = false) {
  if (isAdmin(req.user)) return {};
  const mine = [{ ownerId: req.user.id }, { createdById: req.user.id }];
  return { OR: edit ? mine : [...mine, { attendees: { some: { userId: req.user.id } } }] };
}

/** The live event at `id` in the caller's reach (edit: theirs to change), or null once it has answered 404. */
async function findEvent(req, res, id, edit = false) {
  const event = await req.app.locals.prisma.event.findFirst({ where: { AND: [{ id: String(id), deletedAt: null }, eventScope(req, edit)] } });
  if (!event) res.status(404).json({ error: 'Not found' });
  return event;
}

const idList = value => (Array.isArray(value) ? value.map(String) : []);

/**
 * Why these contacts or leads may not be added as attendees, or null: each
 * must be a live record the caller can see, since their names and emails come
 * back with the event. EventAttendee declares no relation for linkRefusal()
 * to follow.
 */
async function attendeeRefusal(req, key, module, modelName, ids) {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return null;
  const seen = permits(req, module, 'read')
    ? await req.app.locals.prisma[modelName].count({ where: await reachableWhere(req, module, modelName, { id: { in: wanted } }) })
    : 0;
  return seen === wanted.length ? null : `${key} names a ${modelName} you cannot see`;
}

/** The contacts or leads among `ids` the caller can see, id -> name and email. */
async function visiblePeople(req, module, modelName, ids) {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length || !permits(req, module, 'read')) return new Map();
  const rows = await req.app.locals.prisma[modelName].findMany({
    where: await reachableWhere(req, module, modelName, { id: { in: wanted } }),
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  return new Map(rows.map(r => [r.id, r]));
}

// Event attendees management
router.post('/:id/attendees', authenticate, requirePermission('activities', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { contactIds, leadIds, userIds } = req.body;
    const event = await findEvent(req, res, req.params.id, true);
    if (!event) return;
    const hidden = await attendeeRefusal(req, 'contactIds', 'contacts', 'contact', idList(contactIds))
      || await attendeeRefusal(req, 'leadIds', 'leads', 'lead', idList(leadIds));
    if (hidden) return res.status(400).json({ error: hidden, code: 'LINK_NOT_VISIBLE' });
    const attendees = [];
    for (const cId of idList(contactIds)) { attendees.push(await prisma.eventAttendee.create({ data: { eventId: event.id, contactId: cId, status: 'Invited' } }).catch(() => null)); }
    for (const lId of idList(leadIds)) { attendees.push(await prisma.eventAttendee.create({ data: { eventId: event.id, leadId: lId, status: 'Invited' } }).catch(() => null)); }
    for (const uId of idList(userIds)) { attendees.push(await prisma.eventAttendee.create({ data: { eventId: event.id, userId: uId, status: 'Accepted' } }).catch(() => null)); }
    res.json({ added: attendees.filter(Boolean).length });
  } catch (err) { next(err); }
});

// A contact's or lead's name and email only with that module's read permission
// and a live record the caller can see. Otherwise the attendee row comes back
// without the person's details: contact or lead null, and the row's own name
// and email emptied. Anyone who could see the event read every attendee's.
router.get('/:id/attendees', authenticate, requirePermission('activities', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!(await findEvent(req, res, req.params.id))) return;
    const attendees = await prisma.eventAttendee.findMany({ where: { eventId: req.params.id } });
    const contacts = await visiblePeople(req, 'contacts', 'contact', attendees.map(a => a.contactId));
    const leads = await visiblePeople(req, 'leads', 'lead', attendees.map(a => a.leadId));
    res.json(attendees.map(a => {
      const contact = contacts.get(a.contactId) || null;
      const lead = leads.get(a.leadId) || null;
      const hidden = (a.contactId && !contact) || (a.leadId && !lead);
      return { ...a, ...(hidden && { name: null, email: null }), contact, lead };
    }));
  } catch (err) { next(err); }
});

// RSVP
// Your own invitation, or any on an event you may change. This answered for
// anyone by attendee id, whether or not the attendee was on :eventId.
router.put('/:eventId/attendees/:attendeeId/rsvp', authenticate, requirePermission('activities', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { status } = req.body;
    if (!['Accepted', 'Declined', 'Tentative'].includes(status)) return res.status(400).json({ error: 'status must be Accepted, Declined, or Tentative' });
    const attendee = await prisma.eventAttendee.findFirst({ where: { id: req.params.attendeeId, eventId: req.params.eventId } });
    if (!attendee) return res.status(404).json({ error: 'Not found' });
    const own = attendee.userId === req.user.id;
    if (!(await findEvent(req, res, attendee.eventId, !own))) return;
    if (!own && !permits(req, 'activities', 'edit')) return res.status(403).json({ error: 'Insufficient permissions for activities' });
    const att = await prisma.eventAttendee.update({ where: { id: attendee.id }, data: { status, respondedAt: new Date() } });
    res.json(att);
  } catch (err) { next(err); }
});

// Recurring events
// Copies of an event the caller may change, kept to the same people.
router.post('/:id/recurrence', authenticate, requirePermission('activities', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { frequency, interval, count, endDate } = req.body;
    if (!frequency || !['daily', 'weekly', 'monthly'].includes(frequency)) return res.status(400).json({ error: 'frequency required (daily/weekly/monthly)' });
    const parent = await findEvent(req, res, req.params.id, true);
    if (!parent) return;
    const created = [];
    const intervalMs = { daily: 86400000, weekly: 604800000, monthly: 2592000000 }[frequency] * (interval || 1);
    const maxCount = Math.min(count || 12, 52);
    let startTime = new Date(parent.startDate).getTime();
    for (let i = 0; i < maxCount; i++) {
      startTime += intervalMs;
      if (endDate && startTime > new Date(endDate).getTime()) break;
      const dur = parent.endDate ? new Date(parent.endDate) - new Date(parent.startDate) : 3600000;
      const ev = await prisma.event.create({ data: { name: parent.name, description: parent.description, location: parent.location, startDate: new Date(startTime), endDate: new Date(startTime + dur), type: parent.type, ownerId: parent.ownerId, createdById: parent.createdById, recurrenceParentId: parent.id } });
      created.push(ev.id);
    }
    res.json({ parentId: parent.id, createdEvents: created.length, eventIds: created });
  } catch (err) { next(err); }
});

// Calendar view
// The events the caller may see; this listed everyone's.
router.get('/calendar/range', authenticate, requirePermission('activities', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end dates required' });
    const events = await queryWithIncludes(prisma, 'event', 'findMany', { where: { startDate: { gte: new Date(start) }, endDate: { lte: new Date(end) }, deletedAt: null, ...eventScope(req) }, orderBy: { startDate: 'asc' }, include: { owner: { select: { firstName: true, lastName: true } } } });
    const grouped = {};
    events.forEach(e => { const day = new Date(e.startDate).toISOString().split('T')[0]; (grouped[day] = grouped[day] || []).push(e); });
    res.json({ range: { start, end }, totalEvents: events.length, byDate: grouped });
  } catch (err) { next(err); }
});

// Event reminders
// The reminder is the event's own, so it is for those who may change it.
router.post('/:id/reminder', authenticate, requirePermission('activities', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { minutesBefore } = req.body;
    const event = await findEvent(req, res, req.params.id, true);
    if (!event) return;
    const reminderTime = new Date(new Date(event.startDate).getTime() - (minutesBefore || 15) * 60000);
    await prisma.event.update({ where: { id: req.params.id }, data: { reminderMinutes: minutesBefore || 15, reminderAt: reminderTime } });
    res.json({ eventId: event.id, reminderAt: reminderTime, minutesBefore: minutesBefore || 15 });
  } catch (err) { next(err); }
});
