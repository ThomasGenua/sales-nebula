const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere } = require('../middleware/access');
const { createCrudRouter } = require('../utils/crud');
const { queryWithIncludes } = require('../utils/modelFields');
const { WORK_ORDER_NUMBER } = require('../utils/numbering');
const { statusRoutes } = require('../utils/moduleStatus');

const router = createCrudRouter('workOrder', 'fieldService', {
  include: {
    account: { select: { id: true, name: true } },
    contact: { select: { id: true, firstName: true, lastName: true } },
    assignedTo: { select: { id: true, firstName: true, lastName: true } },
    asset: { select: { id: true, name: true, serialNumber: true } },
  },
  searchFilter: (q) => ({
    OR: [
      { subject: { contains: q, mode: 'insensitive' } },
      { workOrderNumber: { contains: q, mode: 'insensitive' } },
    ],
  }),
  validate: (data) => {
    const errors = {};
    if (!data.subject?.trim()) errors.subject = 'Subject required';
    return { valid: Object.keys(errors).length === 0, errors };
  },
  numbering: WORK_ORDER_NUMBER,
});

// Schedule work order
router.post('/:id/schedule', authenticate, requirePermission('fieldService', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { assignedToId, startDate, endDate, notes } = req.body;
    if (!startDate) return res.status(400).json({ error: 'startDate required' });
    const wo = await prisma.workOrder.update({
      where: { id: req.params.id },
      data: { assignedToId, startDate: new Date(startDate), endDate: endDate ? new Date(endDate) : null, status: 'Scheduled', schedulingNotes: notes },
    });
    await req.audit({ action: 'update', module: 'fieldService', recordId: wo.id, details: 'Work order scheduled' });
    res.json(wo);
  } catch (err) { next(err); }
});

// Dispatch
router.post('/:id/dispatch', authenticate, requirePermission('fieldService', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const wo = await prisma.workOrder.update({
      where: { id: req.params.id },
      data: { status: 'Dispatched', dispatchedAt: new Date() },
    });
    // app.locals.emit is the socket helper object, not a function, so this
    // threw into the catch and no dispatch was ever announced. It goes to the
    // technician it was dispatched to.
    try { if (wo.assignedToId) req.app.locals.emit?.toUser?.(wo.assignedToId, 'fieldService:dispatched', { workOrderId: wo.id }); } catch (e) {}
    res.json(wo);
  } catch (err) { next(err); }
});

// Complete with service report
router.post('/:id/complete', authenticate, requirePermission('fieldService', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { resolution, partsUsed, laborHours, signature } = req.body;
    const wo = await prisma.workOrder.update({
      where: { id: req.params.id },
      data: {
        status: 'Completed', completedAt: new Date(),
        resolution, partsUsed: partsUsed || [], laborHours: laborHours || 0,
        customerSignature: signature || null,
      },
    });
    await req.audit({ action: 'update', module: 'fieldService', recordId: wo.id, details: 'Work order completed' });
    res.json(wo);
  } catch (err) { next(err); }
});

// Cancel
router.post('/:id/cancel', authenticate, requirePermission('fieldService', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const wo = await prisma.workOrder.update({
      where: { id: req.params.id },
      data: { status: 'Cancelled', cancelReason: req.body.reason },
    });
    res.json(wo);
  } catch (err) { next(err); }
});

// Technician route optimization (simple nearest-neighbor)
router.get('/route/optimize', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { userId, date } = req.query;
    const targetDate = date ? new Date(date) : new Date();
    const dayStart = new Date(targetDate); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(targetDate); dayEnd.setHours(23, 59, 59, 999);
    // Only work orders row security lets the caller see, as the list does.
    const workOrders = await queryWithIncludes(prisma, 'workOrder', 'findMany', {
      where: await reachableWhere(req, 'fieldService', 'workOrder', {
        assignedToId: userId || req.user.id,
        status: { in: ['Scheduled', 'Dispatched'] },
        startDate: { gte: dayStart, lte: dayEnd },
      }),
      orderBy: { startDate: 'asc' },
      include: { account: { select: { name: true } } },
    });
    res.json({ date: targetDate.toISOString().split('T')[0], workOrders, count: workOrders.length });
  } catch (err) { next(err); }
});

// Work order stats
router.get('/stats/overview', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [total, open, completed, avgCompletion] = await Promise.all([
      prisma.workOrder.count(),
      prisma.workOrder.count({ where: { status: { in: ['New', 'Scheduled', 'Dispatched', 'InProgress'] } } }),
      prisma.workOrder.count({ where: { status: 'Completed' } }),
      prisma.workOrder.findMany({ where: { status: 'Completed', completedAt: { not: null } }, select: { createdAt: true, completedAt: true } }),
    ]);
    const avgDays = avgCompletion.length ? (avgCompletion.reduce((s, w) => s + (new Date(w.completedAt) - new Date(w.createdAt)), 0) / avgCompletion.length / 86400000).toFixed(1) : null;
    res.json({ total, open, completed, completionRate: total ? ((completed / total) * 100).toFixed(1) : 0, avgCompletionDays: avgDays });
  } catch (err) { next(err); }
});

module.exports = router;

// Record count, health and summary, answered from the module's own table.
statusRoutes(router, { module: 'fieldService', model: 'workOrder', analytics: true });

module.exports = router;

// Technician utilization report
router.get('/reports/utilization', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Every active technician with work orders; this took the first twenty
    // active users, in no particular order, and skipped everyone after them.
    const assigned = await prisma.workOrder.groupBy({ by: ['assignedToId'], where: { assignedToId: { not: null } } });
    const users = await prisma.user.findMany({
      where: { active: true, id: { in: assigned.map(a => a.assignedToId) } },
      select: { id: true, firstName: true, lastName: true },
    });
    const utilization = [];
    for (const u of users) {
      const completed = await prisma.workOrder.count({ where: { assignedToId: u.id, status: 'Completed' } }).catch(() => 0);
      const open = await prisma.workOrder.count({ where: { assignedToId: u.id, status: { notIn: ['Completed', 'Cancelled'] } } }).catch(() => 0);
      if (completed > 0 || open > 0) {
        utilization.push({ userId: u.id, name: `${u.firstName} ${u.lastName}`, completed, open, total: completed + open, completionRate: completed + open > 0 ? ((completed / (completed + open)) * 100).toFixed(1) + '%' : '0%' });
      }
    }
    utilization.sort((a, b) => b.total - a.total);
    res.json(utilization);
  } catch (err) { next(err); }
});
