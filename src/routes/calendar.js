const { Router } = require('express');
const crypto = require('crypto');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere, linkRefusal } = require('../middleware/access');
const { isAdmin } = require('../middleware/rowSecurity');
const { editableFields, columnsFrom } = require('../utils/modelFields');
const {
  parseRRule, expandRecurrence, describeRRule,
  buildICalendar, parseICalendar, findFreeSlots, mergeIntervals,
} = require('../utils/recurrence');

const router = Router();

/** Normalize a query date. Bare dates become start-of-day / end-of-day. */
function parseRangeDate(value, endOfDay = false) {
  if (!value) return null;
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(value).trim());
  const d = new Date(value);
  if (isNaN(d)) return null;
  if (isDateOnly) {
    const [y, m, dd] = String(value).trim().split('-').map(Number);
    return endOfDay ? new Date(y, m - 1, dd, 23, 59, 59, 999) : new Date(y, m - 1, dd, 0, 0, 0, 0);
  }
  return d;
}

/**
 * Load events in a window and expand recurring series into occurrences.
 * Materialized exceptions override their generated slot; cancelled slots drop out.
 */
async function expandEventsInRange(prisma, where, rangeStart, rangeEnd, opts = {}) {
  const maxPerSeries = opts.maxPerSeries || 200;

  const [plain, series] = await Promise.all([
    prisma.calendarEvent.findMany({
      where: { ...where, deletedAt: null, isRecurring: false, isException: false, startAt: { lte: rangeEnd }, endAt: { gte: rangeStart } },
      include: opts.include,
      orderBy: { startAt: 'asc' },
    }),
    prisma.calendarEvent.findMany({
      where: { ...where, deletedAt: null, isRecurring: true, startAt: { lte: rangeEnd } },
      include: { ...(opts.include || {}), exceptions: true },
      orderBy: { startAt: 'asc' },
    }),
  ]);

  const occurrences = [...plain.map(e => ({ ...e, isOccurrence: false }))];

  for (const master of series) {
    const exceptions = master.exceptions || [];
    const exdates = exceptions.filter(x => x.originalStart).map(x => new Date(x.originalStart));
    const durationMs = new Date(master.endAt) - new Date(master.startAt);

    const seriesEnd = master.recurrenceEnd && new Date(master.recurrenceEnd) < rangeEnd
      ? new Date(master.recurrenceEnd) : rangeEnd;

    const starts = expandRecurrence(master.startAt, master.rrule, rangeStart, seriesEnd, {
      exdates, max: maxPerSeries,
    });

    const { exceptions: _drop, ...masterFields } = master;
    for (const start of starts) {
      occurrences.push({
        ...masterFields,
        id: `${master.id}::${start.toISOString()}`,
        seriesId: master.id,
        startAt: start,
        endAt: new Date(start.getTime() + durationMs),
        isOccurrence: true,
        recurrenceDescription: describeRRule(master.rrule),
      });
    }

    // Modified occurrences replace their original slot
    for (const ex of exceptions) {
      if (ex.deletedAt || ex.isCancelled) continue;
      if (new Date(ex.startAt) <= rangeEnd && new Date(ex.endAt) >= rangeStart) {
        occurrences.push({ ...ex, seriesId: master.id, isOccurrence: true, isException: true });
      }
    }
  }

  return occurrences.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
}

// ── WHO SEES AND CHANGES AN EVENT ─────────────────────────────────────
// An event is its owner's and its invitees'. These routes took any event id,
// and the list returned every user's calendar to anyone signed in.

// What its owner marked private stays with the people in the event, even
// when an admin looks across everyone's calendars.
const PRIVATE_VISIBILITY = ['Private', 'Confidential'];

/** Events the user owns or is invited to (an edited occurrence, through its series). */
function participantWhere(userId) {
  return {
    OR: [
      { ownerId: userId },
      { invitees: { some: { userId } } },
      { parentEvent: { is: { invitees: { some: { userId } } } } },
    ],
  };
}

/** Events the user may see: their own and their invitations; for an admin, anyone's not marked private. */
function visibleEventWhere(user) {
  if (!isAdmin(user)) return participantWhere(user.id);
  return { OR: [participantWhere(user.id), { visibility: { notIn: PRIVATE_VISIBILITY } }] };
}

/** Events the user may change: those they own or organize, or any for an admin. */
function editableEventWhere(user) {
  if (isAdmin(user)) return {};
  return { OR: [{ ownerId: user.id }, { invitees: { some: { userId: user.id, isOrganizer: true } } }] };
}

/** A live event by id, when `scope` lets the user at it; null otherwise. */
function findEvent(prisma, id, scope, args = {}) {
  return prisma.calendarEvent.findFirst({ where: { AND: [{ id: String(id), deletedAt: null }, scope] }, ...args });
}

/**
 * Resource bookings as the user may see them. A booking for an event outside
 * visibleEventWhere shows only when the resource is busy: it named the event
 * and its title, and its purpose repeats that title (POST /events books with
 * it), Private and Confidential events included.
 */
async function bookingsSeenBy(req, bookings) {
  const ids = [...new Set(bookings.map(b => b.eventId).filter(Boolean))];
  const seen = new Set(ids.length ? (await req.app.locals.prisma.calendarEvent.findMany({
    where: { AND: [{ id: { in: ids } }, visibleEventWhere(req.user)] }, select: { id: true },
  })).map(e => e.id) : []);
  return bookings.map(b => (!b.eventId || seen.has(b.eventId) ? b : {
    id: b.id, resourceId: b.resourceId, startAt: b.startAt, endAt: b.endAt, status: b.status,
    purpose: 'Busy', event: { title: 'Busy' },
  }));
}

/**
 * Reminders as the user may see them. A reminder brought its event's title,
 * place and link along, and its message is the title unless the organizer
 * wrote one (POST /events); both went on showing after the user was taken
 * off the event. For an event outside visibleEventWhere, or deleted, a
 * reminder now keeps only its own timing and status.
 */
async function remindersSeenBy(req, reminders) {
  const ids = [...new Set(reminders.map(r => r.eventId).filter(Boolean))];
  const seen = new Set(ids.length ? (await req.app.locals.prisma.calendarEvent.findMany({
    where: { AND: [{ id: { in: ids }, deletedAt: null }, visibleEventWhere(req.user)] }, select: { id: true },
  })).map(e => e.id) : []);
  return reminders.map(r => (!r.eventId || seen.has(r.eventId) ? r : { ...r, event: null, message: null }));
}

// ── EVENTS ────────────────────────────────────────────────────────────

// List / expand events in a date range
router.get('/events', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { start, end, ownerId, eventType, status, accountId, contactId, dealId, mine } = req.query;

    const rangeStart = parseRangeDate(start) || new Date(new Date().setHours(0, 0, 0, 0));
    const rangeEnd = parseRangeDate(end, true) || new Date(rangeStart.getTime() + 30 * 86400000);
    if (rangeEnd < rangeStart) return res.status(400).json({ error: 'end must be after start' });

    const where = {};
    if (mine === 'true') where.ownerId = req.user.id;
    else if (ownerId) where.ownerId = ownerId;
    if (eventType) where.eventType = eventType;
    if (status) where.status = status;
    if (accountId) where.accountId = accountId;
    if (contactId) where.contactId = contactId;
    if (dealId) where.dealId = dealId;

    // Filters narrow what the caller may see; with none, that is their own
    // events and the ones they are invited to (for an admin, anyone's not
    // marked private).
    const events = await expandEventsInRange(prisma, { AND: [where, visibleEventWhere(req.user)] }, rangeStart, rangeEnd, {
      include: { invitees: true, reminders: true },
    });

    res.json({ rangeStart, rangeEnd, count: events.length, events });
  } catch (err) { next(err); }
});

// Day / week / month view helper
router.get('/view/:mode', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { mode } = req.params;
    const anchor = parseRangeDate(req.query.date) || new Date();
    let rangeStart, rangeEnd;

    if (mode === 'day') {
      rangeStart = new Date(anchor); rangeStart.setHours(0, 0, 0, 0);
      rangeEnd = new Date(anchor); rangeEnd.setHours(23, 59, 59, 999);
    } else if (mode === 'week') {
      const wkst = parseInt(req.query.weekStart, 10) || 0;
      rangeStart = new Date(anchor);
      rangeStart.setDate(anchor.getDate() - ((anchor.getDay() - wkst + 7) % 7));
      rangeStart.setHours(0, 0, 0, 0);
      rangeEnd = new Date(rangeStart); rangeEnd.setDate(rangeStart.getDate() + 6); rangeEnd.setHours(23, 59, 59, 999);
    } else if (mode === 'month') {
      rangeStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      rangeEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (mode === 'agenda') {
      rangeStart = new Date(anchor); rangeStart.setHours(0, 0, 0, 0);
      rangeEnd = new Date(rangeStart.getTime() + (parseInt(req.query.days, 10) || 14) * 86400000);
    } else {
      return res.status(400).json({ error: 'mode must be day, week, month, or agenda' });
    }

    // Everyone's calendar is an admin's view; all=true showed it to anyone.
    const where = req.query.all === 'true' && isAdmin(req.user) ? visibleEventWhere(req.user) : { ownerId: req.user.id };
    const events = await expandEventsInRange(prisma, where, rangeStart, rangeEnd, { include: { invitees: true } });

    // Bucket by ISO date for direct grid rendering
    const byDate = {};
    for (const ev of events) {
      const key = new Date(ev.startAt).toISOString().slice(0, 10);
      (byDate[key] = byDate[key] || []).push(ev);
    }

    res.json({ mode, anchor, rangeStart, rangeEnd, total: events.length, byDate, events });
  } catch (err) { next(err); }
});

// Get one event (accepts a virtual occurrence id "masterId::ISO")
router.get('/events/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [baseId, occurrenceIso] = req.params.id.split('::');

    const event = await findEvent(prisma, baseId, visibleEventWhere(req.user), {
      include: { invitees: true, reminders: true, bookings: { include: { resource: true } }, exceptions: true },
    });
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (occurrenceIso) {
      const start = new Date(occurrenceIso);
      const durationMs = new Date(event.endAt) - new Date(event.startAt);
      return res.json({
        ...event, id: req.params.id, seriesId: event.id,
        startAt: start, endAt: new Date(start.getTime() + durationMs),
        isOccurrence: true, recurrenceDescription: describeRRule(event.rrule),
      });
    }

    res.json({ ...event, recurrenceDescription: event.rrule ? describeRRule(event.rrule) : null });
  } catch (err) { next(err); }
});

// Create event
router.post('/events', authenticate, requirePermission('activities', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const {
      title, description, location, eventType, status, startAt, endAt, allDay, timezone,
      rrule, recurrenceEnd, invitees, reminders, resourceIds, color, meetingUrl, visibility,
      accountId, contactId, dealId, caseId, leadId, parentModule, parentId,
    } = req.body;

    if (!title) return res.status(400).json({ error: 'title required' });
    if (!startAt || !endAt) return res.status(400).json({ error: 'startAt and endAt required' });
    const s = new Date(startAt), e = new Date(endAt);
    if (isNaN(s) || isNaN(e)) return res.status(400).json({ error: 'Invalid date format' });
    if (e <= s) return res.status(400).json({ error: 'endAt must be after startAt' });
    if (rrule && !parseRRule(rrule)) return res.status(400).json({ error: 'Invalid RRULE' });

    // The account, contact, deal, case and lead an event is filed on were
    // stored as sent, records the caller cannot see included.
    const linkProblem = await linkRefusal(req, 'calendarEvent', { accountId, contactId, dealId, caseId, leadId });
    if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });

    // Resources are booked as POST /resources/:id/book books one: live and
    // active, and Pending when it needs approval. Every booking here was
    // Confirmed, which skipped the approver.
    if (resourceIds != null && !Array.isArray(resourceIds)) return res.status(400).json({ error: 'resourceIds must be an array' });
    const rids = [...new Set((resourceIds || []).map(String))];
    const resources = rids.length ? await prisma.calendarResource.findMany({ where: { id: { in: rids }, deletedAt: null } }) : [];
    if (resources.length < rids.length) return res.status(404).json({ error: 'Resource not found' });
    if (resources.some(r => !r.active)) return res.status(400).json({ error: 'Resource is inactive' });

    // Resource conflict check before committing
    if (rids.length) {
      const clash = await prisma.resourceBooking.findFirst({
        where: {
          resourceId: { in: rids }, status: { in: ['Pending', 'Confirmed'] },
          startAt: { lt: e }, endAt: { gt: s },
        },
        include: { resource: { select: { name: true } } },
      });
      if (clash) return res.status(409).json({ error: 'Resource already booked', resource: clash.resource?.name, conflictStart: clash.startAt, conflictEnd: clash.endAt });
    }

    const event = await prisma.calendarEvent.create({
      data: {
        title, description, location,
        eventType: eventType || 'Meeting', status: status || 'Planned',
        startAt: s, endAt: e, allDay: !!allDay, timezone: timezone || 'UTC',
        isRecurring: !!rrule, rrule: rrule || null,
        recurrenceEnd: recurrenceEnd ? new Date(recurrenceEnd) : null,
        ownerId: req.user.id, color, meetingUrl, visibility: visibility || 'Default',
        accountId, contactId, dealId, caseId, leadId, parentModule, parentId,
        externalUid: crypto.randomUUID(),
      },
    });

    // Organizer plus invitees
    const inviteeRows = [{ eventId: event.id, userId: req.user.id, name: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(), email: req.user.email, isOrganizer: true, role: 'Chair', responseStatus: 'Accepted', respondedAt: new Date() }];
    for (const inv of invitees || []) {
      if (inv.userId && inv.userId === req.user.id) continue;
      inviteeRows.push({
        eventId: event.id, userId: inv.userId || null, contactId: inv.contactId || null,
        leadId: inv.leadId || null, email: inv.email || null, name: inv.name || null,
        role: inv.role || 'Required', responseStatus: 'NeedsAction',
      });
    }
    await prisma.eventInvitee.createMany({ data: inviteeRows });

    // Reminders for every invited user
    for (const rem of reminders || []) {
      const minutes = rem.minutesBefore ?? 15;
      const targets = rem.allInvitees ? inviteeRows.filter(i => i.userId).map(i => i.userId) : [req.user.id];
      for (const uid of targets) {
        await prisma.reminder.create({
          data: { eventId: event.id, userId: uid, method: rem.method || 'Popup', minutesBefore: minutes, triggerAt: new Date(s.getTime() - minutes * 60000), message: rem.message || title },
        });
      }
    }

    if (resources.length) {
      await prisma.resourceBooking.createMany({
        data: resources.map(r => ({ resourceId: r.id, eventId: event.id, bookedById: req.user.id, startAt: s, endAt: e, status: r.requiresApproval ? 'Pending' : 'Confirmed', purpose: title })),
      });
    }

    await req.audit({ action: 'create', module: 'calendar', recordId: event.id, details: `Event created: ${title}` });

    const full = await prisma.calendarEvent.findUnique({
      where: { id: event.id },
      include: { invitees: true, reminders: true, bookings: { include: { resource: true } } },
    });
    res.status(201).json({ ...full, recurrenceDescription: rrule ? describeRRule(rrule) : null });
  } catch (err) { next(err); }
});

// Update event. scope=occurrence|following|series
router.put('/events/:id', authenticate, requirePermission('activities', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [baseId, occurrenceIso] = req.params.id.split('::');
    const scope = req.body.scope || (occurrenceIso ? 'occurrence' : 'series');

    // Its owner's or organizer's to change; activities:edit alone changed anyone's.
    const master = await findEvent(prisma, baseId, editableEventWhere(req.user));
    if (!master) return res.status(404).json({ error: 'Event not found' });

    const { scope: _s, invitees: _i, reminders: _r, resourceIds: _rid, ...body } = req.body;
    // The event's own columns, less its owner and its place in a series:
    // relation keys and parentEventId let a caller pull other people's events
    // into their own series, and so into their calendar.
    const fields = editableFields('calendarEvent', body);
    for (const key of ['parentEventId', 'originalStart', 'isException', 'externalUid']) delete fields[key];
    if (fields.startAt) fields.startAt = new Date(fields.startAt);
    if (fields.endAt) fields.endAt = new Date(fields.endAt);
    if (fields.startAt && fields.endAt && fields.endAt <= fields.startAt) {
      return res.status(400).json({ error: 'endAt must be after startAt' });
    }
    if (fields.rrule && !parseRRule(fields.rrule)) return res.status(400).json({ error: 'Invalid RRULE' });
    // As on create: a new account, contact, deal, case or lead link must name
    // a record the caller can see; these went through unchecked.
    const linkProblem = await linkRefusal(req, 'calendarEvent', fields, master);
    if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });

    // Single occurrence of a series: materialize an exception record
    if (scope === 'occurrence' && occurrenceIso && master.isRecurring) {
      const originalStart = new Date(occurrenceIso);
      const durationMs = new Date(master.endAt) - new Date(master.startAt);
      const existing = await prisma.calendarEvent.findFirst({ where: { parentEventId: master.id, originalStart } });

      if (existing) {
        const updated = await prisma.calendarEvent.update({ where: { id: existing.id }, data: fields });
        return res.json({ ...updated, scope: 'occurrence' });
      }

      const { id, createdAt, updatedAt, externalUid, ...base } = master;
      const exception = await prisma.calendarEvent.create({
        data: {
          ...base,
          startAt: fields.startAt || originalStart,
          endAt: fields.endAt || new Date(originalStart.getTime() + durationMs),
          ...fields,
          isRecurring: false, rrule: null, recurrenceEnd: null,
          parentEventId: master.id, originalStart, isException: true,
          externalUid: crypto.randomUUID(),
        },
      });
      await req.audit({ action: 'update', module: 'calendar', recordId: master.id, details: `Occurrence modified: ${originalStart.toISOString()}` });
      return res.json({ ...exception, scope: 'occurrence' });
    }

    // This and following: cap the original series, start a new one
    if (scope === 'following' && occurrenceIso && master.isRecurring) {
      const splitAt = new Date(occurrenceIso);
      await prisma.calendarEvent.update({
        where: { id: master.id },
        data: { recurrenceEnd: new Date(splitAt.getTime() - 1) },
      });
      const { id, createdAt, updatedAt, externalUid, ...base } = master;
      const durationMs = new Date(master.endAt) - new Date(master.startAt);
      const newSeries = await prisma.calendarEvent.create({
        data: {
          ...base, ...fields,
          startAt: fields.startAt || splitAt,
          endAt: fields.endAt || new Date(splitAt.getTime() + durationMs),
          externalUid: crypto.randomUUID(),
        },
      });
      await req.audit({ action: 'update', module: 'calendar', recordId: master.id, details: `Series split at ${splitAt.toISOString()}` });
      return res.json({ ...newSeries, scope: 'following', splitFrom: master.id });
    }

    const updated = await prisma.calendarEvent.update({ where: { id: master.id }, data: fields });

    // Keep reminder trigger times aligned with a moved start
    if (fields.startAt) {
      const rems = await prisma.reminder.findMany({ where: { eventId: master.id, status: 'Pending' } });
      for (const r of rems) {
        await prisma.reminder.update({ where: { id: r.id }, data: { triggerAt: new Date(fields.startAt.getTime() - r.minutesBefore * 60000) } });
      }
      if (fields.endAt) {
        await prisma.resourceBooking.updateMany({ where: { eventId: master.id }, data: { startAt: fields.startAt, endAt: fields.endAt } });
      }
    }

    await req.audit({ action: 'update', module: 'calendar', recordId: master.id, details: `Event updated: ${updated.title}` });
    res.json({ ...updated, scope: 'series' });
  } catch (err) { next(err); }
});

// Delete event or single occurrence
router.delete('/events/:id', authenticate, requirePermission('activities', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [baseId, occurrenceIso] = req.params.id.split('::');
    const scope = req.query.scope || (occurrenceIso ? 'occurrence' : 'series');

    // Its owner's or organizer's to delete; activities:edit alone deleted anyone's.
    const master = await findEvent(prisma, baseId, editableEventWhere(req.user));
    if (!master) return res.status(404).json({ error: 'Event not found' });

    if (scope === 'occurrence' && occurrenceIso && master.isRecurring) {
      const originalStart = new Date(occurrenceIso);
      const { id, createdAt, updatedAt, externalUid, ...base } = master;
      await prisma.calendarEvent.create({
        data: { ...base, parentEventId: master.id, originalStart, isException: true, isCancelled: true, isRecurring: false, rrule: null, externalUid: crypto.randomUUID() },
      });
      await req.audit({ action: 'delete', module: 'calendar', recordId: master.id, details: `Occurrence cancelled: ${originalStart.toISOString()}` });
      return res.json({ cancelled: true, scope: 'occurrence', occurrence: originalStart });
    }

    await prisma.calendarEvent.update({ where: { id: master.id }, data: { deletedAt: new Date() } });
    await prisma.reminder.updateMany({ where: { eventId: master.id }, data: { status: 'Dismissed' } });
    await prisma.resourceBooking.updateMany({ where: { eventId: master.id }, data: { status: 'Cancelled' } });
    await req.audit({ action: 'delete', module: 'calendar', recordId: master.id, details: `Event deleted: ${master.title}` });
    res.json({ deleted: true, scope: 'series' });
  } catch (err) { next(err); }
});

// Move / resize (drag-and-drop support)
router.patch('/events/:id/move', authenticate, requirePermission('activities', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [baseId] = req.params.id.split('::');
    const { startAt, endAt } = req.body;
    if (!startAt || !endAt) return res.status(400).json({ error: 'startAt and endAt required' });
    const s = new Date(startAt), e = new Date(endAt);
    if (e <= s) return res.status(400).json({ error: 'endAt must be after startAt' });

    // This moved anyone's event with a session alone.
    if (!(await findEvent(prisma, baseId, editableEventWhere(req.user), { select: { id: true } }))) {
      return res.status(404).json({ error: 'Event not found' });
    }
    const updated = await prisma.calendarEvent.update({ where: { id: baseId }, data: { startAt: s, endAt: e } });
    const rems = await prisma.reminder.findMany({ where: { eventId: baseId, status: 'Pending' } });
    for (const r of rems) {
      await prisma.reminder.update({ where: { id: r.id }, data: { triggerAt: new Date(s.getTime() - r.minutesBefore * 60000) } });
    }
    await prisma.resourceBooking.updateMany({ where: { eventId: baseId }, data: { startAt: s, endAt: e } });
    res.json(updated);
  } catch (err) { next(err); }
});

// ── INVITEES ──────────────────────────────────────────────────────────

router.get('/events/:id/invitees', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [baseId] = req.params.id.split('::');
    // Who is in an event is as private as the event.
    if (!(await findEvent(prisma, baseId, visibleEventWhere(req.user), { select: { id: true } }))) {
      return res.status(404).json({ error: 'Event not found' });
    }
    const invitees = await prisma.eventInvitee.findMany({ where: { eventId: baseId }, orderBy: [{ isOrganizer: 'desc' }, { createdAt: 'asc' }] });
    const summary = invitees.reduce((acc, i) => { acc[i.responseStatus] = (acc[i.responseStatus] || 0) + 1; return acc; }, {});
    res.json({ total: invitees.length, summary, invitees });
  } catch (err) { next(err); }
});

router.post('/events/:id/invitees', authenticate, requirePermission('activities', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [baseId] = req.params.id.split('::');
    const list = Array.isArray(req.body) ? req.body : (req.body.invitees || [req.body]);
    if (!list.length) return res.status(400).json({ error: 'invitees required' });

    // The organizer's to invite to; anyone could add themselves to any event.
    const event = await findEvent(prisma, baseId, editableEventWhere(req.user));
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const created = [];
    for (const inv of list) {
      if (!inv.userId && !inv.contactId && !inv.leadId && !inv.email) continue;
      const dupe = await prisma.eventInvitee.findFirst({
        where: { eventId: baseId, OR: [inv.userId ? { userId: inv.userId } : null, inv.contactId ? { contactId: inv.contactId } : null, inv.email ? { email: inv.email } : null].filter(Boolean) },
      });
      if (dupe) continue;
      created.push(await prisma.eventInvitee.create({
        data: { eventId: baseId, userId: inv.userId || null, contactId: inv.contactId || null, leadId: inv.leadId || null, email: inv.email || null, name: inv.name || null, role: inv.role || 'Required', responseStatus: 'NeedsAction' },
      }));
    }
    await req.audit({ action: 'update', module: 'calendar', recordId: baseId, details: `${created.length} invitees added` });
    res.status(201).json({ added: created.length, invitees: created });
  } catch (err) { next(err); }
});

// Respond to an invitation
router.post('/events/:id/respond', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [baseId] = req.params.id.split('::');
    const { response, comment } = req.body;
    const allowed = ['Accepted', 'Declined', 'Tentative'];
    if (!allowed.includes(response)) return res.status(400).json({ error: `response must be one of ${allowed.join(', ')}` });

    const invitee = await prisma.eventInvitee.findFirst({ where: { eventId: baseId, userId: req.user.id } });
    if (!invitee) return res.status(404).json({ error: 'You are not invited to this event' });

    const updated = await prisma.eventInvitee.update({
      where: { id: invitee.id },
      data: { responseStatus: response, respondedAt: new Date(), comment: comment || null },
    });

    // Declining clears the attendee's own reminders
    if (response === 'Declined') {
      await prisma.reminder.updateMany({ where: { eventId: baseId, userId: req.user.id, status: 'Pending' }, data: { status: 'Dismissed' } });
    }

    await req.audit({ action: 'update', module: 'calendar', recordId: baseId, details: `Invitation ${response}` });
    res.json(updated);
  } catch (err) { next(err); }
});

router.delete('/events/:eventId/invitees/:inviteeId', authenticate, requirePermission('activities', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // An invitee of this event, which the caller organizes: this took any
    // invitee id and never looked at the event.
    const [baseId] = req.params.eventId.split('::');
    if (!(await findEvent(prisma, baseId, editableEventWhere(req.user), { select: { id: true } }))) {
      return res.status(404).json({ error: 'Event not found' });
    }
    const invitee = await prisma.eventInvitee.findFirst({ where: { id: req.params.inviteeId, eventId: baseId } });
    if (!invitee) return res.status(404).json({ error: 'Invitee not found' });
    if (invitee.isOrganizer) return res.status(400).json({ error: 'Cannot remove the organizer' });
    await prisma.eventInvitee.delete({ where: { id: req.params.inviteeId } });
    res.json({ removed: true });
  } catch (err) { next(err); }
});

// My pending invitations
router.get('/invitations/pending', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const invitations = await prisma.eventInvitee.findMany({
      where: { userId: req.user.id, responseStatus: 'NeedsAction', event: { deletedAt: null, startAt: { gte: new Date() } } },
      include: { event: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ count: invitations.length, invitations });
  } catch (err) { next(err); }
});

// ── FREE / BUSY AND AVAILABILITY ──────────────────────────────────────

router.get('/freebusy', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { userIds, start, end } = req.query;
    const rangeStart = parseRangeDate(start) || new Date();
    const rangeEnd = parseRangeDate(end, true) || new Date(rangeStart.getTime() + 7 * 86400000);
    const ids = userIds ? String(userIds).split(',').filter(Boolean) : [req.user.id];

    const result = {};
    for (const uid of ids) {
      const events = await expandEventsInRange(prisma, { ownerId: uid, status: { not: 'Cancelled' } }, rangeStart, rangeEnd);
      const invited = await prisma.eventInvitee.findMany({
        where: { userId: uid, responseStatus: { in: ['Accepted', 'Tentative'] }, event: { deletedAt: null, startAt: { lte: rangeEnd }, endAt: { gte: rangeStart } } },
        include: { event: true },
      });
      const busy = mergeIntervals([
        ...events.filter(e => !e.isCancelled).map(e => ({ start: e.startAt, end: e.endAt })),
        ...invited.map(i => ({ start: i.event.startAt, end: i.event.endAt })),
      ]);
      const totalBusyMs = busy.reduce((s, b) => s + (new Date(b.end) - new Date(b.start)), 0);
      result[uid] = { busy, blocks: busy.length, busyHours: +(totalBusyMs / 3600000).toFixed(2) };
    }

    res.json({ rangeStart, rangeEnd, freebusy: result });
  } catch (err) { next(err); }
});

// Find a slot that works for everyone
router.post('/availability', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { userIds, resourceIds, durationMinutes = 30, start, end, limit = 20 } = req.body;
    const ids = userIds?.length ? userIds : [req.user.id];
    const rangeStart = start ? new Date(start) : new Date();
    const rangeEnd = end ? new Date(end) : new Date(rangeStart.getTime() + 14 * 86400000);
    if (durationMinutes <= 0) return res.status(400).json({ error: 'durationMinutes must be positive' });

    const allBusy = [];
    for (const uid of ids) {
      const events = await expandEventsInRange(prisma, { ownerId: uid, status: { not: 'Cancelled' } }, rangeStart, rangeEnd);
      allBusy.push(...events.filter(e => !e.isCancelled).map(e => ({ start: e.startAt, end: e.endAt })));
      const invited = await prisma.eventInvitee.findMany({
        where: { userId: uid, responseStatus: { in: ['Accepted', 'Tentative'] }, event: { deletedAt: null, startAt: { lte: rangeEnd }, endAt: { gte: rangeStart } } },
        include: { event: { select: { startAt: true, endAt: true } } },
      });
      allBusy.push(...invited.map(i => ({ start: i.event.startAt, end: i.event.endAt })));
    }

    if (resourceIds?.length) {
      const bookings = await prisma.resourceBooking.findMany({
        where: { resourceId: { in: resourceIds }, status: { in: ['Pending', 'Confirmed'] }, startAt: { lt: rangeEnd }, endAt: { gt: rangeStart } },
      });
      allBusy.push(...bookings.map(b => ({ start: b.startAt, end: b.endAt })));
    }

    // Working hours: the intersection is the strictest participant
    const hours = await prisma.workingHours.findMany({ where: { OR: [{ userId: { in: ids } }, { userId: null }] } });
    const byDay = {};
    for (const h of hours) {
      const cur = byDay[h.dayOfWeek];
      if (!cur) { byDay[h.dayOfWeek] = { ...h }; continue; }
      cur.startMinute = Math.max(cur.startMinute, h.startMinute);
      cur.endMinute = Math.min(cur.endMinute, h.endMinute);
      cur.isWorkingDay = cur.isWorkingDay && h.isWorkingDay;
    }
    const workingHours = Object.values(byDay);

    const slots = findFreeSlots(allBusy, rangeStart, rangeEnd, durationMinutes, workingHours);
    const suggestions = slots.slice(0, limit).map(s => ({
      start: s.start, end: new Date(s.start.getTime() + durationMinutes * 60000),
      windowEnd: s.end, windowMinutes: Math.floor((s.end - s.start) / 60000),
    }));

    res.json({ participants: ids.length, durationMinutes, rangeStart, rangeEnd, slotsFound: slots.length, suggestions });
  } catch (err) { next(err); }
});

// ── REMINDERS ─────────────────────────────────────────────────────────

router.get('/reminders/due', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const now = new Date();
    const due = await prisma.reminder.findMany({
      where: {
        userId: req.user.id,
        status: { in: ['Pending', 'Snoozed'] },
        OR: [{ status: 'Pending', triggerAt: { lte: now } }, { status: 'Snoozed', snoozedUntil: { lte: now } }],
      },
      include: { event: { select: { id: true, title: true, startAt: true, endAt: true, location: true, meetingUrl: true } } },
      orderBy: { triggerAt: 'asc' },
      take: 50,
    });
    // The event's details only while the user may still see it (remindersSeenBy).
    res.json({ count: due.length, reminders: await remindersSeenBy(req, due) });
  } catch (err) { next(err); }
});

router.get('/reminders/upcoming', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const hours = parseInt(req.query.hours, 10) || 24;
    const reminders = await prisma.reminder.findMany({
      where: { userId: req.user.id, status: 'Pending', triggerAt: { gte: new Date(), lte: new Date(Date.now() + hours * 3600000) } },
      include: { event: { select: { id: true, title: true, startAt: true } } },
      orderBy: { triggerAt: 'asc' },
    });
    res.json({ windowHours: hours, count: reminders.length, reminders: await remindersSeenBy(req, reminders) });
  } catch (err) { next(err); }
});

router.post('/reminders', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { eventId, activityId, minutesBefore = 15, method = 'Popup', message } = req.body;
    if (!eventId && !activityId) return res.status(400).json({ error: 'eventId or activityId required' });

    let triggerAt;
    if (eventId) {
      // A reminder hands back its event's title, place and link (/reminders/due).
      const ev = await findEvent(prisma, eventId, visibleEventWhere(req.user));
      if (!ev) return res.status(404).json({ error: 'Event not found' });
      triggerAt = new Date(new Date(ev.startAt).getTime() - minutesBefore * 60000);
    }
    if (activityId) {
      // Any activity id went, with no activities permission, and its trigger
      // time gave the due date away. Checked with an event or without, since
      // both are stored.
      if (!permits(req, 'activities', 'read')) return res.status(403).json({ error: 'Insufficient permissions for activities' });
      const act = await prisma.activity.findFirst({ where: await reachableWhere(req, 'activities', 'activity', { id: String(activityId) }) });
      if (!act) return res.status(404).json({ error: 'Activity not found' });
      if (!eventId) triggerAt = new Date(new Date(act.dueDate || act.date).getTime() - minutesBefore * 60000);
    }

    const reminder = await prisma.reminder.create({
      data: { eventId: eventId || null, activityId: activityId || null, userId: req.user.id, method, minutesBefore, triggerAt, message },
    });
    res.status(201).json(reminder);
  } catch (err) { next(err); }
});

router.post('/reminders/:id/dismiss', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rem = await prisma.reminder.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!rem) return res.status(404).json({ error: 'Reminder not found' });
    const updated = await prisma.reminder.update({ where: { id: rem.id }, data: { status: 'Dismissed', dismissedAt: new Date() } });
    res.json((await remindersSeenBy(req, [updated]))[0]);
  } catch (err) { next(err); }
});

router.post('/reminders/:id/snooze', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const minutes = parseInt(req.body.minutes, 10) || 5;
    const rem = await prisma.reminder.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!rem) return res.status(404).json({ error: 'Reminder not found' });
    const updated = await prisma.reminder.update({
      where: { id: rem.id },
      data: { status: 'Snoozed', snoozedUntil: new Date(Date.now() + minutes * 60000) },
    });
    res.json((await remindersSeenBy(req, [updated]))[0]);
  } catch (err) { next(err); }
});

router.post('/reminders/dismiss-all', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const result = await prisma.reminder.updateMany({
      where: { userId: req.user.id, status: { in: ['Pending', 'Snoozed'] }, triggerAt: { lte: new Date() } },
      data: { status: 'Dismissed', dismissedAt: new Date() },
    });
    res.json({ dismissed: result.count });
  } catch (err) { next(err); }
});

// ── RESOURCES ─────────────────────────────────────────────────────────

router.get('/resources', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { resourceType, active } = req.query;
    const where = { deletedAt: null };
    if (resourceType) where.resourceType = resourceType;
    if (active !== undefined) where.active = active === 'true';
    const resources = await prisma.calendarResource.findMany({ where, orderBy: { name: 'asc' } });
    res.json(resources);
  } catch (err) { next(err); }
});

router.post('/resources', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, resourceType, description, location, capacity, requiresApproval, approverId, costPerHour } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const resource = await prisma.calendarResource.create({
      data: { name, resourceType: resourceType || 'Room', description, location, capacity: capacity ? +capacity : null, requiresApproval: !!requiresApproval, approverId, costPerHour: costPerHour ? +costPerHour : null },
    });
    await req.audit({ action: 'create', module: 'calendar', recordId: resource.id, details: `Resource created: ${name}` });
    res.status(201).json(resource);
  } catch (err) { next(err); }
});

router.put('/resources/:id', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // The resource's own columns. The body went to the update whole, so
    // `bookings` was a nested write into anyone's bookings; deletedAt is
    // DELETE's to set, at admin full.
    const data = columnsFrom('calendarResource', req.body);
    delete data.deletedAt;
    const resource = await prisma.calendarResource.update({ where: { id: req.params.id }, data });
    res.json(resource);
  } catch (err) { next(err); }
});

router.delete('/resources/:id', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.calendarResource.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), active: false } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// Resource schedule
router.get('/resources/:id/schedule', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rangeStart = parseRangeDate(req.query.start) || new Date();
    const rangeEnd = parseRangeDate(req.query.end, true) || new Date(rangeStart.getTime() + 7 * 86400000);
    const bookings = await prisma.resourceBooking.findMany({
      where: { resourceId: req.params.id, status: { in: ['Pending', 'Confirmed'] }, startAt: { lt: rangeEnd }, endAt: { gt: rangeStart } },
      include: { event: { select: { id: true, title: true, ownerId: true } } },
      orderBy: { startAt: 'asc' },
    });
    const totalMs = bookings.reduce((s, b) => s + (new Date(b.endAt) - new Date(b.startAt)), 0);
    const windowMs = rangeEnd - rangeStart;
    // Every booking named its event's title for anyone signed in; one for an
    // event the caller cannot see is now busy time only.
    res.json({ resourceId: req.params.id, rangeStart, rangeEnd, bookings: await bookingsSeenBy(req, bookings), utilizationPercent: windowMs > 0 ? +((totalMs / windowMs) * 100).toFixed(1) : 0 });
  } catch (err) { next(err); }
});

// Which resources are free for a window
router.post('/resources/available', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { startAt, endAt, resourceType, minCapacity } = req.body;
    if (!startAt || !endAt) return res.status(400).json({ error: 'startAt and endAt required' });
    const s = new Date(startAt), e = new Date(endAt);

    const where = { deletedAt: null, active: true };
    if (resourceType) where.resourceType = resourceType;
    if (minCapacity) where.capacity = { gte: +minCapacity };
    const resources = await prisma.calendarResource.findMany({ where, orderBy: { name: 'asc' } });

    const conflicts = await prisma.resourceBooking.findMany({
      where: { resourceId: { in: resources.map(r => r.id) }, status: { in: ['Pending', 'Confirmed'] }, startAt: { lt: e }, endAt: { gt: s } },
      select: { resourceId: true },
    });
    const busyIds = new Set(conflicts.map(c => c.resourceId));

    res.json({
      window: { startAt: s, endAt: e },
      available: resources.filter(r => !busyIds.has(r.id)),
      unavailable: resources.filter(r => busyIds.has(r.id)).map(r => ({ id: r.id, name: r.name })),
    });
  } catch (err) { next(err); }
});

router.post('/resources/:id/book', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { startAt, endAt, eventId, purpose } = req.body;
    if (!startAt || !endAt) return res.status(400).json({ error: 'startAt and endAt required' });
    const s = new Date(startAt), e = new Date(endAt);
    if (e <= s) return res.status(400).json({ error: 'endAt must be after startAt' });

    const resource = await prisma.calendarResource.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!resource) return res.status(404).json({ error: 'Resource not found' });
    if (!resource.active) return res.status(400).json({ error: 'Resource is inactive' });
    // Any event id was taken, so a booking went on anyone's event. A booking
    // shows with its event, and moves and is cancelled with it, so the event
    // must be one the caller may change, not merely one they are invited to.
    if (eventId && !(await findEvent(prisma, eventId, editableEventWhere(req.user), { select: { id: true } }))) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const clash = await prisma.resourceBooking.findFirst({
      where: { resourceId: resource.id, status: { in: ['Pending', 'Confirmed'] }, startAt: { lt: e }, endAt: { gt: s } },
    });
    if (clash) return res.status(409).json({ error: 'Resource already booked for that window', conflictStart: clash.startAt, conflictEnd: clash.endAt });

    const booking = await prisma.resourceBooking.create({
      data: { resourceId: resource.id, eventId: eventId || null, bookedById: req.user.id, startAt: s, endAt: e, purpose, status: resource.requiresApproval ? 'Pending' : 'Confirmed' },
    });
    await req.audit({ action: 'create', module: 'calendar', recordId: booking.id, details: `Booked ${resource.name}` });
    res.status(201).json(booking);
  } catch (err) { next(err); }
});

router.post('/bookings/:id/cancel', authenticate, requirePermission('activities', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // The booker's to cancel, or the organizer's of the event it is for; this
    // cancelled anyone's booking with a session alone.
    const whose = isAdmin(req.user) ? {} : { OR: [{ bookedById: req.user.id }, { event: { is: editableEventWhere(req.user) } }] };
    const found = await prisma.resourceBooking.findFirst({ where: { id: req.params.id, ...whose }, select: { id: true } });
    if (!found) return res.status(404).json({ error: 'Booking not found' });
    const booking = await prisma.resourceBooking.update({ where: { id: found.id }, data: { status: 'Cancelled' } });
    // An admin cancelling a private event's booking read its title back.
    res.json((await bookingsSeenBy(req, [booking]))[0]);
  } catch (err) { next(err); }
});

router.post('/bookings/:id/approve', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { approve } = req.body;
    const booking = await prisma.resourceBooking.update({
      where: { id: req.params.id },
      data: { status: approve === false ? 'Rejected' : 'Confirmed', approvedById: req.user.id, approvedAt: new Date() },
    });
    // As in the schedule: the purpose of an event the approver cannot see stays hidden.
    res.json((await bookingsSeenBy(req, [booking]))[0]);
  } catch (err) { next(err); }
});

// ── WORKING HOURS ─────────────────────────────────────────────────────

router.get('/working-hours', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const userId = req.query.userId || req.user.id;
    let hours = await prisma.workingHours.findMany({ where: { userId }, orderBy: { dayOfWeek: 'asc' } });
    if (!hours.length) hours = await prisma.workingHours.findMany({ where: { userId: null }, orderBy: { dayOfWeek: 'asc' } });
    if (!hours.length) {
      hours = [0, 1, 2, 3, 4, 5, 6].map(d => ({ dayOfWeek: d, startMinute: 540, endMinute: 1020, isWorkingDay: d >= 1 && d <= 5, timezone: 'UTC' }));
    }
    res.json(hours);
  } catch (err) { next(err); }
});

router.put('/working-hours', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { schedule, userId } = req.body;
    if (!Array.isArray(schedule)) return res.status(400).json({ error: 'schedule array required' });
    // req.user.role is the Role record, never 'admin', so no admin could set anyone else's.
    const target = userId && isAdmin(req.user) ? userId : req.user.id;

    const saved = [];
    for (const day of schedule) {
      if (day.dayOfWeek === undefined) continue;
      const data = {
        startMinute: day.startMinute ?? 540, endMinute: day.endMinute ?? 1020,
        isWorkingDay: day.isWorkingDay !== false, timezone: day.timezone || 'UTC',
      };
      const existing = await prisma.workingHours.findFirst({ where: { userId: target, dayOfWeek: day.dayOfWeek } });
      saved.push(existing
        ? await prisma.workingHours.update({ where: { id: existing.id }, data })
        : await prisma.workingHours.create({ data: { ...data, userId: target, dayOfWeek: day.dayOfWeek } }));
    }
    res.json({ saved: saved.length, schedule: saved });
  } catch (err) { next(err); }
});

// ── iCAL FEED (public, token-authenticated) ───────────────────────────

router.get('/feeds', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const feeds = await prisma.calendarFeed.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' } });
    const base = `${req.protocol}://${req.get('host')}/api/calendar/feed`;
    res.json(feeds.map(f => ({ ...f, url: `${base}/${f.token}.ics` })));
  } catch (err) { next(err); }
});

router.post('/feeds', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, eventTypes, includeDeclined } = req.body;
    const token = crypto.randomBytes(24).toString('hex');
    const feed = await prisma.calendarFeed.create({
      data: { userId: req.user.id, token, name: name || 'My Calendar', eventTypes: eventTypes || null, includeDeclined: !!includeDeclined },
    });
    await req.audit({ action: 'create', module: 'calendar', recordId: feed.id, details: 'Calendar feed created' });
    res.status(201).json({ ...feed, url: `${req.protocol}://${req.get('host')}/api/calendar/feed/${token}.ics` });
  } catch (err) { next(err); }
});

router.delete('/feeds/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.calendarFeed.deleteMany({ where: { id: req.params.id, userId: req.user.id } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// Public subscription endpoint. Token is the credential, so no authenticate.
router.get('/feed/:token.ics', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const token = req.params.token;
    const feed = await prisma.calendarFeed.findFirst({ where: { token, active: true } });
    if (!feed) return res.status(404).type('text/plain').send('Calendar feed not found');

    await prisma.calendarFeed.update({ where: { id: feed.id }, data: { lastAccessAt: new Date(), accessCount: { increment: 1 } } });

    const rangeStart = new Date(Date.now() - 90 * 86400000);
    const rangeEnd = new Date(Date.now() + 365 * 86400000);
    const where = { ownerId: feed.userId };
    const types = Array.isArray(feed.eventTypes) ? feed.eventTypes : null;
    if (types?.length) where.eventType = { in: types };

    // Publish masters with their RRULE so clients expand natively
    const events = await prisma.calendarEvent.findMany({
      where: { ...where, deletedAt: null, isException: false, OR: [{ isRecurring: true }, { startAt: { lte: rangeEnd }, endAt: { gte: rangeStart } }] },
      include: { invitees: true, reminders: true },
      orderBy: { startAt: 'asc' },
      take: 2000,
    });

    const ics = buildICalendar(events, { name: feed.name, domain: req.get('host') || 'salesnebula.local' });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${feed.name.replace(/[^a-z0-9]/gi, '_')}.ics"`);
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.send(ics);
  } catch (err) { next(err); }
});

// One-off export of a single event
router.get('/events/:id/export.ics', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [baseId] = req.params.id.split('::');
    // The same event GET /events/:id would show, and no other.
    const event = await findEvent(prisma, baseId, visibleEventWhere(req.user), {
      include: { invitees: true, reminders: true },
    });
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const ics = buildICalendar([event], { name: event.title, domain: req.get('host') });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="event.ics"`);
    res.send(ics);
  } catch (err) { next(err); }
});

// Import an .ics payload
router.post('/import', authenticate, requirePermission('activities', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { icalData, skipDuplicates = true } = req.body;
    if (!icalData) return res.status(400).json({ error: 'icalData required' });

    const parsed = parseICalendar(icalData);
    if (!parsed.length) return res.status(400).json({ error: 'No valid VEVENT blocks found' });

    const imported = [], skipped = [];
    for (const ev of parsed.slice(0, 500)) {
      if (skipDuplicates && ev.externalUid) {
        const dupe = await prisma.calendarEvent.findFirst({ where: { externalUid: ev.externalUid } });
        if (dupe) { skipped.push({ title: ev.title, reason: 'duplicate uid' }); continue; }
      }
      const created = await prisma.calendarEvent.create({
        data: {
          title: ev.title, description: ev.description, location: ev.location, meetingUrl: ev.meetingUrl,
          startAt: ev.startAt, endAt: ev.endAt || new Date(new Date(ev.startAt).getTime() + 3600000),
          allDay: !!ev.allDay, isRecurring: !!ev.rrule, rrule: ev.rrule || null,
          status: ev.status || 'Planned', visibility: ev.visibility || 'Default',
          eventType: 'Meeting', ownerId: req.user.id,
          externalUid: ev.externalUid || crypto.randomUUID(),
        },
      });
      if (ev.invitees?.length) {
        await prisma.eventInvitee.createMany({
          data: ev.invitees.map(i => ({ eventId: created.id, email: i.email, name: i.name, role: i.role || 'Required', isOrganizer: !!i.isOrganizer, responseStatus: 'NeedsAction' })),
        });
      }
      imported.push({ id: created.id, title: created.title });
    }

    await req.audit({ action: 'create', module: 'calendar', recordId: 'import', details: `Imported ${imported.length} events from iCal` });
    res.json({ parsed: parsed.length, imported: imported.length, skipped: skipped.length, events: imported, skippedDetail: skipped });
  } catch (err) { next(err); }
});

// ── ANALYTICS ─────────────────────────────────────────────────────────

router.get('/analytics/summary', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const days = parseInt(req.query.days, 10) || 30;
    const rangeStart = new Date(Date.now() - days * 86400000);
    const rangeEnd = new Date();

    const events = await expandEventsInRange(prisma, { ownerId: req.user.id }, rangeStart, rangeEnd, { include: { invitees: true } });
    const totalMs = events.reduce((s, e) => s + (new Date(e.endAt) - new Date(e.startAt)), 0);

    const byType = {}, byStatus = {}, byDayOfWeek = {};
    for (const e of events) {
      byType[e.eventType] = (byType[e.eventType] || 0) + 1;
      byStatus[e.status] = (byStatus[e.status] || 0) + 1;
      const d = new Date(e.startAt).getDay();
      byDayOfWeek[d] = (byDayOfWeek[d] || 0) + 1;
    }

    const withOthers = events.filter(e => (e.invitees || []).length > 1);
    const declined = await prisma.eventInvitee.count({ where: { userId: req.user.id, responseStatus: 'Declined', event: { startAt: { gte: rangeStart } } } });

    res.json({
      periodDays: days,
      totalEvents: events.length,
      totalHours: +(totalMs / 3600000).toFixed(1),
      avgDurationMinutes: events.length ? Math.round(totalMs / events.length / 60000) : 0,
      avgPerWeek: +((events.length / days) * 7).toFixed(1),
      meetingsWithOthers: withOthers.length,
      soloBlocks: events.length - withOthers.length,
      declinedInvitations: declined,
      byType, byStatus, byDayOfWeek,
    });
  } catch (err) { next(err); }
});

// Meeting load per user, for managers
router.get('/analytics/team-load', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const days = parseInt(req.query.days, 10) || 7;
    const rangeStart = new Date();
    const rangeEnd = new Date(Date.now() + days * 86400000);

    const users = await prisma.user.findMany({ where: { active: true }, select: { id: true, firstName: true, lastName: true }, take: 50 });
    const load = [];
    for (const u of users) {
      const events = await expandEventsInRange(prisma, { ownerId: u.id, status: { not: 'Cancelled' } }, rangeStart, rangeEnd);
      const ms = events.reduce((s, e) => s + (new Date(e.endAt) - new Date(e.startAt)), 0);
      const hours = +(ms / 3600000).toFixed(1);
      load.push({ userId: u.id, name: `${u.firstName || ''} ${u.lastName || ''}`.trim(), meetings: events.length, hours, loadPercent: +((hours / (days * 8)) * 100).toFixed(0) });
    }
    load.sort((a, b) => b.hours - a.hours);
    res.json({ periodDays: days, users: load });
  } catch (err) { next(err); }
});

module.exports = router;
