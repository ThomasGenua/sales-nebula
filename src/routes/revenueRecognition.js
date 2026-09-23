const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { queryWithIncludes } = require('../utils/modelFields');
const { summaryRoute } = require('../utils/moduleStatus');

const router = Router();

// Schedules, recognised and deferred revenue are financial records: reading
// them takes invoices read. They answered anyone signed in; writes were
// already admin edit.

// List revenue schedules
router.get('/schedules', authenticate, requirePermission('invoices', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { contractId, status, page = 1, limit = 50 } = req.query;
    const where = {};
    if (contractId) where.contractId = contractId;
    if (status) where.status = status;
    const [data, total] = await Promise.all([
      prisma.revenueSchedule.findMany({ where, orderBy: { startDate: 'desc' }, take: +limit, skip: (+page - 1) * +limit }),
      prisma.revenueSchedule.count({ where }),
    ]);
    res.json({ data, total, page: +page, pages: Math.ceil(total / +limit) });
  } catch (err) { next(err); }
});

// Create revenue schedule
router.post('/schedules', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { contractId, totalAmount, startDate, endDate, recognitionMethod, periods } = req.body;
    if (!contractId || !totalAmount || !startDate) return res.status(400).json({ error: 'contractId, totalAmount, startDate required' });
    const method = recognitionMethod || 'StraightLine';
    const start = new Date(startDate);
    const end = endDate ? new Date(endDate) : new Date(start.getFullYear() + 1, start.getMonth(), start.getDate());
    const monthsCount = periods || Math.max(1, Math.round((end - start) / (30.44 * 86400000)));
    const monthlyAmount = parseFloat(totalAmount) / monthsCount;
    // One entry per month. Rounding each to the cent leaves the total a few
    // cents out, so the last period takes the remainder.
    const entries = [];
    for (let i = 0; i < monthsCount; i++) {
      const entryDate = new Date(start);
      entryDate.setMonth(entryDate.getMonth() + i);
      entries.push({ period: entryDate, amount: parseFloat(monthlyAmount.toFixed(2)) });
    }
    const allocated = entries.slice(0, -1).reduce((sum, e) => sum + e.amount, 0);
    entries[entries.length - 1].amount = parseFloat((parseFloat(totalAmount) - allocated).toFixed(2));
    const schedule = await prisma.revenueSchedule.create({
      data: {
        contractId, totalAmount: parseFloat(totalAmount), recognizedAmount: 0,
        startDate: start, endDate: end, method, periods: monthsCount, status: 'Active',
        // A schedule's periods are RevenueScheduleEntry rows. Handing Prisma
        // the list as if it were a JSON column failed every create.
        entries: { create: entries },
      },
      include: { entries: { orderBy: { period: 'asc' } } },
    });
    await req.audit({ action: 'create', module: 'revenue', recordId: schedule.id, details: `Revenue schedule: ${monthsCount} periods` });
    res.status(201).json(schedule);
  } catch (err) { next(err); }
});

// Get schedule for contract
router.get('/schedule/:contractId', authenticate, requirePermission('invoices', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const schedules = await prisma.revenueSchedule.findMany({ where: { contractId: req.params.contractId }, orderBy: { startDate: 'desc' }, include: { entries: { orderBy: { period: 'asc' } } } });
    res.json(schedules);
  } catch (err) { next(err); }
});

// Recognize revenue (mark period as recognized)
router.post('/recognize', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { scheduleId, period, entryId } = req.body;
    if (!scheduleId) return res.status(400).json({ error: 'scheduleId required' });
    const schedule = await prisma.revenueSchedule.findUnique({ where: { id: scheduleId }, include: { entries: { orderBy: { period: 'asc' } } } });
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
    // A period is named by entry id, by its 1-based position, or by its date.
    const target = entryId ? schedule.entries.find(e => e.id === entryId)
      : /^\d+$/.test(String(period)) ? schedule.entries[Number(period) - 1]
      : schedule.entries.find(e => e.period.toISOString().slice(0, 10) === String(period).slice(0, 10));
    if (!target) return res.status(404).json({ error: 'Period not found in this schedule' });
    if (target.status !== 'Recognized') {
      await prisma.revenueScheduleEntry.update({ where: { id: target.id }, data: { status: 'Recognized', recognizedAt: new Date() } });
    }
    const [{ _sum }, outstanding] = await Promise.all([
      prisma.revenueScheduleEntry.aggregate({ where: { scheduleId, status: 'Recognized' }, _sum: { amount: true } }),
      prisma.revenueScheduleEntry.count({ where: { scheduleId, status: { not: 'Recognized' } } }),
    ]);
    const recognizedAmount = parseFloat((_sum.amount || 0).toFixed(2));
    const updated = await prisma.revenueSchedule.update({
      where: { id: scheduleId },
      data: { recognizedAmount, ...(outstanding === 0 && { status: 'Completed' }) },
      include: { entries: { orderBy: { period: 'asc' } } },
    });
    await req.audit({ action: 'update', module: 'revenue', recordId: scheduleId, details: `Recognized period ${target.period.toISOString().slice(0, 10)}` });
    res.json({ schedule: updated, recognizedAmount, remainingAmount: parseFloat((schedule.totalAmount - recognizedAmount).toFixed(2)) });
  } catch (err) { next(err); }
});

// Revenue summary
router.get('/summary', authenticate, requirePermission('invoices', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const schedules = await prisma.revenueSchedule.findMany({ where: { status: { not: 'Cancelled' } }, include: { entries: true } });
    const totalScheduled = schedules.reduce((s, r) => s + (parseFloat(r.totalAmount) || 0), 0);
    const totalRecognized = schedules.reduce((s, r) => s + (parseFloat(r.recognizedAmount) || 0), 0);
    const active = schedules.filter(s => s.status === 'Active');
    // Monthly breakdown
    const monthlyRecognition = {};
    active.forEach(s => {
      s.entries.forEach(e => {
        const month = e.period.toISOString().substring(0, 7);
        if (!monthlyRecognition[month]) monthlyRecognition[month] = { scheduled: 0, recognized: 0 };
        monthlyRecognition[month].scheduled += e.amount;
        if (e.status === 'Recognized') monthlyRecognition[month].recognized += e.amount;
      });
    });
    res.json({ totalScheduled, totalRecognized, deferredRevenue: totalScheduled - totalRecognized, activeSchedules: active.length, totalSchedules: schedules.length, recognitionRate: totalScheduled ? ((totalRecognized / totalScheduled) * 100).toFixed(1) : 0, monthlyBreakdown: monthlyRecognition });
  } catch (err) { next(err); }
});

module.exports = router;

// Deferred revenue aging
router.get('/deferred/aging', authenticate, requirePermission('invoices', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const schedules = await prisma.revenueSchedule.findMany({ where: { status: { not: 'Fully Recognized' } }, include: { entries: { where: { recognizedAt: null } } } });
    const aging = { current: 0, thirtyDays: 0, sixtyDays: 0, ninetyPlus: 0 };
    schedules.forEach(s => {
      s.entries.forEach(e => {
        const days = Math.floor((Date.now() - new Date(e.period)) / 86400000);
        const amt = e.amount || 0;
        if (days < 0) aging.current += amt;
        else if (days < 30) aging.thirtyDays += amt;
        else if (days < 60) aging.sixtyDays += amt;
        else aging.ninetyPlus += amt;
      });
    });
    res.json(aging);
  } catch (err) { next(err); }
});

// Revenue by product
router.get('/by-product', authenticate, requirePermission('invoices', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const schedules = await queryWithIncludes(prisma, 'revenueSchedule', 'findMany', { include: { contract: { select: { name: true } }, entries: true } }).catch(() => []);
    const byProduct = {};
    schedules.forEach(s => {
      const key = s.contractId;
      if (!byProduct[key]) byProduct[key] = { contractId: key, name: s.contract?.name, recognized: 0, deferred: 0 };
      s.entries.forEach(e => { if (e.recognized) byProduct[key].recognized += e.amount || 0; else byProduct[key].deferred += e.amount || 0; });
    });
    res.json(Object.values(byProduct));
  } catch (err) { next(err); }
});

// Totals from the module's own table.
summaryRoute(router, { module: 'revenue', model: 'revenueSchedule' });

// Bulk status update
router.post('/bulk/status', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { ids, status } = req.body;
    if (!ids?.length || !status) return res.status(400).json({ error: 'ids and status required' });
    const updated = await Promise.all(ids.slice(0, 100).map(async (id) => {
      try { return await prisma.$executeRaw`UPDATE "revenueRecognition" SET status = ${status} WHERE id = ${id}`; }
      catch (e) { return null; }
    }));
    await req.audit({ action: 'bulk_update', module: 'revenueRecognition', details: `Bulk status update: ${ids.length} records to ${status}` });
    res.json({ updated: updated.filter(Boolean).length, requested: ids.length });
  } catch (err) { next(err); }
});
