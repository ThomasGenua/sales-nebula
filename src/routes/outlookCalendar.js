const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { linkRefusal } = require('../middleware/access');
const calendar = require('../services/outlookCalendar');
const { acquireLease, releaseLease } = require('../utils/lease');
const router = Router();
router.use(authenticate, requirePermission('emails', 'edit'), requirePermission('activities', 'edit'), auditMiddleware);
router.param('id', async (req, res, next, id) => {
  try { req.calendarAccount = await req.app.locals.prisma.inboundEmailAccount.findFirst({ where: { id, ownerId: req.userId, deletedAt: null } }); if (!req.calendarAccount) return res.sendStatus(404); next(); } catch (e) { next(e); }
});
router.get('/:id/events', async (req, res, next) => {
  try {
    const db = req.app.locals.prisma, page = Math.max(1, parseInt(req.query.page) || 1);
    const where = { ownerId: req.userId, deletedAt: null, startAt: { gte: new Date(Date.now() - 30 * 86400000), lte: new Date(Date.now() + 180 * 86400000) } };
    const [rows, total] = await Promise.all([db.calendarEvent.findMany({ where, include: calendar.include, orderBy: [{ startAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * 25, take: 25 }), db.calendarEvent.count({ where })]);
    const links = await db.outlookEventLink.findMany({ where: { accountId: req.params.id, eventId: { in: rows.map(r => r.id) } } });
    res.json({ data: rows.map(e => { const link = links.find(l => l.eventId === e.id); return { ...e, outlook: link ? { conflict: link.conflict, organizer: link.remoteOrganizer, recurring: link.remoteRecurring, syncedAt: link.syncedAt } : null }; }), total, page });
  } catch (e) { next(e); }
});
router.post('/:id/sync', async (req, res, next) => {
  try { res.json(await calendar.sync(req.app.locals.prisma, req.calendarAccount)); } catch (e) { next(e); }
});
router.post('/:id/disable', async (req, res, next) => {
  try { await req.app.locals.prisma.inboundEmailAccount.update({ where: { id: req.params.id }, data: { calendarEnabled: false, calendarCursor: null, calendarWindowEnd: null } }); res.json({ disabled: true }); } catch (e) { next(e); }
});
router.post('/:id/publish/:eventId', async (req, res, next) => {
  try {
    const db = req.app.locals.prisma, event = await db.calendarEvent.findFirst({ where: { id: req.params.eventId, ownerId: req.userId, deletedAt: null }, include: calendar.include });
    if (!event) return res.sendStatus(404);
    const result = await calendar.publish(db, req.calendarAccount, event);
    await req.audit({ action: 'update', module: 'calendar', recordId: event.id, details: result.cancelled ? 'Cancelled meeting in Outlook' : 'Published meeting and invitations to Outlook' });
    res.json(result);
  } catch (e) { next(e); }
});
router.put('/:id/events/:eventId', async (req, res, next) => {
  try {
    const db = req.app.locals.prisma, event = await db.calendarEvent.findFirst({ where: { id: req.params.eventId, ownerId: req.userId, deletedAt: null } });
    if (!event) return res.sendStatus(404);
    const body = req.body, startAt = new Date(body.startAt), endAt = new Date(body.endAt);
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 500 || !Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || startAt >= endAt) return res.status(400).json({ error: 'Provide a title and valid start and end times.' });
    if (!Array.isArray(body.attendees) || body.attendees.length > 500 || body.attendees.some(email => typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return res.status(400).json({ error: 'Use valid attendee email addresses.' });
    if (!Number.isInteger(body.reminderMinutes) || body.reminderMinutes < 0 || body.reminderMinutes > 40320) return res.status(400).json({ error: 'Reminder must be from 0 to 40,320 minutes.' });
    if (body.version !== event.updatedAt.toISOString()) return res.status(409).json({ error: 'Meeting changed. Reload it before saving.' });
    const link = await db.outlookEventLink.findUnique({ where: { eventId: event.id } });
    if (event.isRecurring || event.parentEventId || link && (link.accountId !== req.params.id || !link.remoteOrganizer || link.remoteRecurring || link.conflict)) return res.status(409).json({ error: 'Resolve conflicts or manage this meeting in Outlook.' });
    const fields = { title: body.title.trim(), startAt, endAt, description: String(body.description || '').slice(0, 50000), location: String(body.location || '').slice(0, 1000), dealId: body.dealId || null, status: body.cancelled ? 'Cancelled' : 'Planned', isCancelled: !!body.cancelled };
    const problem = await linkRefusal(req, 'calendarEvent', fields, event); if (problem) return res.status(400).json({ error: problem });
    await db.$transaction(async tx => {
      await tx.calendarEvent.update({ where: { id: event.id, updatedAt: event.updatedAt }, data: fields });
      await tx.eventInvitee.deleteMany({ where: { eventId: event.id, isOrganizer: false } });
      const emails = [...new Set(body.attendees.map(e => e.toLowerCase()))];
      if (emails.length) await tx.eventInvitee.createMany({ data: emails.map(email => ({ eventId: event.id, email })) });
      await tx.reminder.deleteMany({ where: { eventId: event.id, userId: req.userId, method: 'Popup' } });
      if (!body.cancelled) await tx.reminder.create({ data: { eventId: event.id, userId: req.userId, method: 'Popup', minutesBefore: body.reminderMinutes, triggerAt: new Date(startAt.getTime() - body.reminderMinutes * 60000) } });
    });
    await req.audit({ action: 'update', module: 'calendar', recordId: event.id, details: 'Updated meeting for Outlook publication' });
    res.json(await db.calendarEvent.findUnique({ where: { id: event.id }, include: calendar.include }));
  } catch (e) { if (e.code === 'P2025') { e.status = 409; e.message = 'Meeting changed. Reload before saving.'; } next(e); }
});
router.put('/:id/links/:eventId', async (req, res, next) => {
  try {
    const db = req.app.locals.prisma, event = await db.calendarEvent.findFirst({ where: { id: req.params.eventId, ownerId: req.userId, deletedAt: null } });
    if (!event) return res.sendStatus(404);
    const data = { dealId: req.body.dealId || null, contactId: req.body.contactId || null };
    const problem = await linkRefusal(req, 'calendarEvent', data, event);
    if (problem) return res.status(400).json({ error: problem });
    const updated = await db.calendarEvent.update({ where: { id: event.id }, data });
    res.json({ linked: true, updatedAt: updated.updatedAt });
  } catch (e) { next(e); }
});
router.post('/:id/use-outlook/:eventId', async (req, res, next) => {
  const db = req.app.locals.prisma, key = 'outlook-calendar:' + req.params.id;
  let lease;
  try {
    const event = await db.calendarEvent.findFirst({ where: { id: req.params.eventId, ownerId: req.userId, deletedAt: null } });
    const link = event && await db.outlookEventLink.findFirst({ where: { eventId: event.id, accountId: req.params.id } });
    if (!link) return res.sendStatus(404);
    if (!req.calendarAccount.active || !req.calendarAccount.calendarEnabled) return res.status(409).json({ error: 'Reconnect this calendar first.' });
    lease = await acquireLease(db, key, 5 * 60000); if (!lease) return res.status(409).json({ error: 'Calendar synchronization is already running.' });
    let incoming; try { incoming = await calendar.remoteEvent(db, req.calendarAccount, link.remoteId); } catch (e) { if (e.status !== 404) throw e; incoming = { id: link.remoteId, deleted: true }; }
    await calendar.importEvent(db, req.calendarAccount, incoming, { force: true });
    await req.audit({ action: 'update', module: 'calendar', recordId: event.id, details: 'Resolved calendar conflict using the Outlook version' });
    res.json({ resolved: true });
  } catch (e) { next(e); } finally { if (lease) await releaseLease(db, key, lease); }
});
module.exports = router;
