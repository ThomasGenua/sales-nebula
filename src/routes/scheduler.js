const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere } = require('../middleware/access');
const { queryWithIncludes, editableFields } = require('../utils/modelFields');
const { statusRoutes } = require('../utils/moduleStatus');
const { isAdmin } = require('../middleware/rowSecurity');

const router = Router();

// An appointment keeps contactId and accountId as plain columns, which
// linkRefusal cannot check, so linkProblem below checks them the same way.
const LINKS = { contactId: ['contacts', 'contact'], accountId: ['accounts', 'account'] };

/**
 * Why `data` may not file an appointment on the records it names, or null.
 * They were stored as sent, so a meeting could sit on anyone's contact or
 * account, and the list's contact include read back the contact's name. A
 * key that keeps its value in `current` is not a new link.
 */
async function linkProblem(req, data, current = {}) {
  for (const [key, [module, model]] of Object.entries(LINKS)) {
    const value = data[key];
    if (value === undefined || value === null || value === '' || value === current[key]) continue;
    const found = permits(req, module, 'read') && await req.app.locals.prisma[model].findFirst({
      where: await reachableWhere(req, module, model, { id: String(value) }),
      select: { id: true },
    });
    if (!found) return `${key} does not name a ${model} you can see`;
  }
  return null;
}

/**
 * The appointments a user may see and change: those they host (assignedToId)
 * or own, or any for an admin. These routes listed, rewrote and cancelled
 * anyone's appointments with a session alone.
 */
function ownAppointments(req) {
  if (isAdmin(req.user)) return {};
  return { OR: [{ assignedToId: req.user.id }, { ownerId: req.user.id }] };
}

const mayRead = (req, apt) => isAdmin(req.user) || apt.assignedToId === req.user.id || apt.ownerId === req.user.id;

// List appointments
router.get('/', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50, userId, from, to, status } = req.query;
    // A page of at most 200; a limit that is not a number made the query fail.
    const take = Math.min(parseInt(limit, 10) || 50, 200);
    const current = Math.max(parseInt(page, 10) || 1, 1);
    // userId narrows the caller's own appointments; an admin may name anyone.
    const where = { deletedAt: null, ...ownAppointments(req) };
    if (userId) where.assignedToId = userId;
    if (status) where.status = status;
    if (from || to) { where.startTime = {}; if (from) where.startTime.gte = new Date(from); if (to) where.startTime.lte = new Date(to); }
    const [data, total] = await Promise.all([
      queryWithIncludes(prisma, 'appointment', 'findMany', { where, orderBy: { startTime: 'asc' }, take, skip: (current - 1) * take, include: { assignedTo: { select: { id: true, firstName: true, lastName: true } }, contact: { select: { id: true, firstName: true, lastName: true } } } }),
      prisma.appointment.count({ where }),
    ]);
    res.json({ data, total, page: current, pages: Math.ceil(total / take) });
  } catch (err) { next(err); }
});

// Create appointment
router.post('/', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { subject, startTime, endTime, contactId, accountId, type, location, notes } = req.body;
    if (!subject || !startTime || !endTime) return res.status(400).json({ error: 'subject, startTime, endTime required' });
    // An unreadable date failed in the database (500), and an end before the
    // start was booked, and then never clashed with anything.
    const s = new Date(startTime), e = new Date(endTime);
    if (isNaN(s) || isNaN(e)) return res.status(400).json({ error: 'Invalid date format' });
    if (e <= s) return res.status(400).json({ error: 'endTime must be after startTime' });
    // Only on a contact and account the caller can see (see linkProblem).
    const refusal = await linkProblem(req, { contactId, accountId });
    if (refusal) return res.status(400).json({ error: refusal, code: 'LINK_NOT_VISIBLE' });
    // Conflict check
    const conflicts = await prisma.appointment.findMany({
      where: {
        assignedToId: req.body.assignedToId || req.user.id, status: { not: 'Cancelled' }, deletedAt: null,
        OR: [
          { startTime: { lt: e }, endTime: { gt: s } },
        ],
      },
    });
    // Someone else's appointment shows as busy time; booking against a
    // colleague returned their subjects.
    if (conflicts.length) return res.status(409).json({ error: 'Time conflict with existing appointment', conflicts: conflicts.map(c => ({ id: c.id, subject: mayRead(req, c) ? c.subject : 'Busy', startTime: c.startTime, endTime: c.endTime })) });
    // The booker owns it, so booking for a colleague does not lose it.
    const apt = await prisma.appointment.create({
      data: { subject, startTime: s, endTime: e, assignedToId: req.body.assignedToId || req.user.id, ownerId: req.user.id, contactId, accountId, type: type || 'Meeting', location, notes, status: 'Scheduled' },
    });
    await req.audit({ action: 'create', module: 'scheduler', recordId: apt.id, details: `Appointment: ${subject}` });
    res.status(201).json(apt);
  } catch (err) { next(err); }
});

// Update appointment
router.put('/:id', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const found = await prisma.appointment.findFirst({ where: { id: req.params.id, deletedAt: null, ...ownAppointments(req) }, select: { id: true, contactId: true, accountId: true } });
    if (!found) return res.status(404).json({ error: 'Appointment not found' });
    // Its own columns, not whose it is: the body went to Prisma whole.
    const data = editableFields('appointment', req.body);
    delete data.assignedToId;
    // And a new contact or account only one the caller can see, as on create.
    const refusal = await linkProblem(req, data, found);
    if (refusal) return res.status(400).json({ error: refusal, code: 'LINK_NOT_VISIBLE' });
    const apt = await prisma.appointment.update({ where: { id: found.id }, data });
    res.json(apt);
  } catch (err) { next(err); }
});

// Cancel appointment
router.post('/:id/cancel', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const found = await prisma.appointment.findFirst({ where: { id: req.params.id, deletedAt: null, ...ownAppointments(req) }, select: { id: true } });
    if (!found) return res.status(404).json({ error: 'Appointment not found' });
    const apt = await prisma.appointment.update({ where: { id: found.id }, data: { status: 'Cancelled', cancelReason: req.body.reason } });
    await req.audit({ action: 'update', module: 'scheduler', recordId: apt.id, details: 'Appointment cancelled' });
    res.json(apt);
  } catch (err) { next(err); }
});

// Get available slots for a user
router.get('/slots', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { userId, date, duration = 60 } = req.query;
    const targetUserId = userId || req.user.id;
    const targetDate = date ? new Date(date) : new Date();
    const dayStart = new Date(targetDate); dayStart.setHours(9, 0, 0, 0);
    const dayEnd = new Date(targetDate); dayEnd.setHours(17, 0, 0, 0);

    // Everything overlapping the working day: one that began before 9:00 and
    // ran into it was left out, and its time offered as free.
    const existing = await prisma.appointment.findMany({
      where: {
        assignedToId: targetUserId, status: { not: 'Cancelled' }, deletedAt: null,
        startTime: { lt: dayEnd }, endTime: { gt: dayStart },
      },
      orderBy: { startTime: 'asc' },
    });

    // Calculate free slots
    const slots = [];
    let cursor = dayStart;
    const durationMs = +duration * 60000;
    for (const apt of existing) {
      const aptStart = new Date(apt.startTime);
      if (aptStart - cursor >= durationMs) {
        slots.push({ start: new Date(cursor), end: new Date(Math.min(cursor.getTime() + durationMs, aptStart.getTime())) });
      }
      cursor = new Date(Math.max(cursor.getTime(), new Date(apt.endTime).getTime()));
    }
    if (dayEnd - cursor >= durationMs) slots.push({ start: new Date(cursor), end: new Date(cursor.getTime() + durationMs) });
    res.json({ date: targetDate.toISOString().split('T')[0], userId: targetUserId, durationMinutes: +duration, availableSlots: slots });
  } catch (err) { next(err); }
});

// Agent availability (for service routing)
router.get('/availability', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const now = new Date();
    const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
    // Everyone's (or ?userId=) is an admin's view; anyone else gets their own.
    // This listed every user with what they were in the middle of.
    const who = isAdmin(req.user) ? (req.query.userId ? { id: String(req.query.userId) } : {}) : { id: req.user.id };
    const agents = await prisma.user.findMany({ where: { active: true, ...who }, select: { id: true, firstName: true, lastName: true } });
    const availability = await Promise.all(agents.map(async (agent) => {
      const aptsToday = await prisma.appointment.count({
        where: { assignedToId: agent.id, status: { not: 'Cancelled' }, startTime: { gte: now, lte: endOfDay } },
      });
      const currentApt = await prisma.appointment.findFirst({
        where: { assignedToId: agent.id, status: 'Scheduled', startTime: { lte: now }, endTime: { gt: now } },
      });
      return { ...agent, busy: !!currentApt, remainingAppointments: aptsToday, currentAppointment: currentApt?.subject || null };
    }));
    res.json({ availability, timestamp: now });
  } catch (err) { next(err); }
});

module.exports = router;

// Record count and summary of the appointments the caller may see, as the list
// shows them (ownAppointments; an admin's are everyone's). The shared routes
// counted every user's, having no way to narrow them to the caller.
router.get('/count', authenticate, async (req, res, next) => {
  try {
    const count = await req.app.locals.prisma.appointment.count({ where: { deletedAt: null, ...ownAppointments(req) } });
    res.json({ count, module: 'scheduler' });
  } catch (err) { next(err); }
});

router.get('/analytics/summary', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const base = { deletedAt: null, ...ownAppointments(req) };
    const since = new Date(Date.now() - 30 * 86400000);
    const [total, recent] = await Promise.all([
      prisma.appointment.count({ where: base }),
      prisma.appointment.count({ where: { AND: [base, { createdAt: { gte: since } }] } }),
    ]);
    res.json({ module: 'scheduler', total, createdLast30Days: recent, checkedAt: new Date() });
  } catch (err) { next(err); }
});

// Health, from the shared route; without a model it checks the database connection.
statusRoutes(router, { module: 'scheduler' });

