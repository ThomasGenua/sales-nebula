const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { queryWithIncludes, editableFields } = require('../utils/modelFields');
const { statusRoutes } = require('../utils/moduleStatus');
const { isAdmin } = require('../middleware/rowSecurity');

const router = Router();

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
    // userId narrows the caller's own appointments; an admin may name anyone.
    const where = { deletedAt: null, ...ownAppointments(req) };
    if (userId) where.assignedToId = userId;
    if (status) where.status = status;
    if (from || to) { where.startTime = {}; if (from) where.startTime.gte = new Date(from); if (to) where.startTime.lte = new Date(to); }
    const [data, total] = await Promise.all([
      queryWithIncludes(prisma, 'appointment', 'findMany', { where, orderBy: { startTime: 'asc' }, take: +limit, skip: (+page - 1) * +limit, include: { assignedTo: { select: { id: true, firstName: true, lastName: true } }, contact: { select: { id: true, firstName: true, lastName: true } } } }),
      prisma.appointment.count({ where }),
    ]);
    res.json({ data, total, page: +page, pages: Math.ceil(total / +limit) });
  } catch (err) { next(err); }
});

// Create appointment
router.post('/', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { subject, startTime, endTime, contactId, accountId, type, location, notes } = req.body;
    if (!subject || !startTime || !endTime) return res.status(400).json({ error: 'subject, startTime, endTime required' });
    // Conflict check
    const conflicts = await prisma.appointment.findMany({
      where: {
        assignedToId: req.body.assignedToId || req.user.id, status: { not: 'Cancelled' },
        OR: [
          { startTime: { lt: new Date(endTime) }, endTime: { gt: new Date(startTime) } },
        ],
      },
    });
    // Someone else's appointment shows as busy time; booking against a
    // colleague returned their subjects.
    if (conflicts.length) return res.status(409).json({ error: 'Time conflict with existing appointment', conflicts: conflicts.map(c => ({ id: c.id, subject: mayRead(req, c) ? c.subject : 'Busy', startTime: c.startTime, endTime: c.endTime })) });
    // The booker owns it, so booking for a colleague does not lose it.
    const apt = await prisma.appointment.create({
      data: { subject, startTime: new Date(startTime), endTime: new Date(endTime), assignedToId: req.body.assignedToId || req.user.id, ownerId: req.user.id, contactId, accountId, type: type || 'Meeting', location, notes, status: 'Scheduled' },
    });
    await req.audit({ action: 'create', module: 'scheduler', recordId: apt.id, details: `Appointment: ${subject}` });
    res.status(201).json(apt);
  } catch (err) { next(err); }
});

// Update appointment
router.put('/:id', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const found = await prisma.appointment.findFirst({ where: { id: req.params.id, deletedAt: null, ...ownAppointments(req) }, select: { id: true } });
    if (!found) return res.status(404).json({ error: 'Appointment not found' });
    // Its own columns, not whose it is: the body went to Prisma whole.
    const data = editableFields('appointment', req.body);
    delete data.assignedToId;
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

    const existing = await prisma.appointment.findMany({
      where: {
        assignedToId: targetUserId, status: { not: 'Cancelled' },
        startTime: { gte: dayStart, lt: dayEnd },
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

// Record count, health and summary, answered from the module's own table.
statusRoutes(router, { module: 'scheduler', model: 'appointment', analytics: true });

