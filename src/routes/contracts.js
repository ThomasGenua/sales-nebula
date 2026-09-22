const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { createCrudRouter } = require('../utils/crud');
const { createNumbered, CONTRACT_NUMBER } = require('../utils/numbering');

const router = createCrudRouter('contract', 'contracts', {
  include: {
    account: { select: { id: true, name: true } },
    deal: { select: { id: true, name: true } },
  },
  searchFilter: (q) => ({
    OR: [
      { contractNumber: { contains: q, mode: 'insensitive' } },
      { name: { contains: q, mode: 'insensitive' } },
    ],
  }),
  numbering: CONTRACT_NUMBER,
});

// Activate contract
router.post('/:id/activate', authenticate, requirePermission('contracts', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const contract = await prisma.contract.update({
      where: { id: req.params.id },
      data: { status: 'Activated', activatedAt: new Date(), activatedById: req.user.id },
    });
    await req.audit({ action: 'update', module: 'contracts', recordId: contract.id, details: 'Contract activated' });
    res.json(contract);
  } catch (err) { next(err); }
});

// Terminate
router.post('/:id/terminate', authenticate, requirePermission('contracts', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const contract = await prisma.contract.update({
      where: { id: req.params.id },
      data: { status: 'Terminated', terminationDate: new Date(), terminationReason: req.body.reason },
    });
    await req.audit({ action: 'update', module: 'contracts', recordId: contract.id, details: `Terminated: ${req.body.reason || 'No reason'}` });
    res.json(contract);
  } catch (err) { next(err); }
});

// Amend contract (create new version)
router.post('/:id/amend', authenticate, requirePermission('contracts', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const original = await prisma.contract.findUnique({ where: { id: req.params.id } });
    if (!original) return res.status(404).json({ error: 'Contract not found' });
    const { id, createdAt, updatedAt, contractNumber, ...contractData } = original;
    const amendment = await createNumbered(prisma, 'contract', CONTRACT_NUMBER, {
      data: {
        ...contractData, ...req.body,
        name: `${original.name} (Amendment)`,
        status: 'Draft', parentContractId: original.id,
        version: (original.version || 1) + 1,
      },
    });
    await req.audit({ action: 'create', module: 'contracts', recordId: amendment.id, details: `Amendment of contract ${original.id}` });
    res.status(201).json(amendment);
  } catch (err) { next(err); }
});

// Renew
router.post('/:id/renew', authenticate, requirePermission('contracts', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const original = await prisma.contract.findUnique({ where: { id: req.params.id } });
    if (!original) return res.status(404).json({ error: 'Contract not found' });
    const { months = 12, priceAdjustment } = req.body;
    const newStart = original.endDate ? new Date(original.endDate) : new Date();
    const newEnd = new Date(newStart); newEnd.setMonth(newEnd.getMonth() + months);
    const renewed = await createNumbered(prisma, 'contract', CONTRACT_NUMBER, {
      data: {
        name: `${original.name} (Renewal)`, accountId: original.accountId, dealId: original.dealId,
        startDate: newStart, endDate: newEnd, status: 'Draft', parentContractId: original.id,
        value: priceAdjustment || original.value,
      },
    });
    await req.audit({ action: 'create', module: 'contracts', recordId: renewed.id, details: `Renewal of contract ${original.id}` });
    res.status(201).json(renewed);
  } catch (err) { next(err); }
});

// Contract compliance check
router.get('/:id/compliance', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const contract = await prisma.contract.findUnique({ where: { id: req.params.id } });
    if (!contract) return res.status(404).json({ error: 'Not found' });
    const issues = [];
    if (!contract.startDate) issues.push({ field: 'startDate', severity: 'error', message: 'Missing start date' });
    if (!contract.endDate) issues.push({ field: 'endDate', severity: 'error', message: 'Missing end date' });
    if (contract.endDate && new Date(contract.endDate) < new Date()) issues.push({ field: 'endDate', severity: 'warning', message: 'Contract has expired' });
    if (!contract.value) issues.push({ field: 'value', severity: 'warning', message: 'No value specified' });
    if (contract.endDate) {
      const daysRemaining = Math.ceil((new Date(contract.endDate) - new Date()) / 86400000);
      if (daysRemaining > 0 && daysRemaining < 30) issues.push({ severity: 'warning', message: `Contract expires in ${daysRemaining} days` });
    }
    res.json({ contractId: contract.id, compliant: !issues.some(i => i.severity === 'error'), issues });
  } catch (err) { next(err); }
});

module.exports = router;

// Contract milestones
router.get('/:id/milestones', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const milestones = await prisma.contractMilestone.findMany({ where: { contractId: req.params.id }, orderBy: { dueDate: 'asc' } }).catch(() => []);
    res.json(milestones);
  } catch (err) { next(err); }
});

router.post('/:id/milestones', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, dueDate, description, amount } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const ms = await prisma.contractMilestone.create({ data: { contractId: req.params.id, name, dueDate: dueDate ? new Date(dueDate) : null, description, amount } });
    res.status(201).json(ms);
  } catch (err) { next(err); }
});

// Renewal forecast
router.get('/renewals/forecast', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { months = 6 } = req.query;
    const now = new Date();
    const forecast = [];
    for (let i = 0; i < +months; i++) {
      const start = new Date(now); start.setMonth(start.getMonth() + i); start.setDate(1);
      const end = new Date(start); end.setMonth(end.getMonth() + 1);
      const expiring = await prisma.contract.findMany({ where: { endDate: { gte: start, lt: end }, status: { not: 'Terminated' }, deletedAt: null }, select: { id: true, name: true, value: true, endDate: true } });
      forecast.push({ month: start.toISOString().substring(0, 7), count: expiring.length, value: expiring.reduce((s, c) => s + (c.value || 0), 0), contracts: expiring });
    }
    res.json(forecast);
  } catch (err) { next(err); }
});

module.exports = router;

// Analytics / Stats
router.get('/analytics/summary', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const thirtyDays = new Date(Date.now() - 30 * 86400000);
    const modelName = 'Contracts';
    // Generic stats endpoint
    const stats = {
      module: 'contracts',
      generatedAt: new Date(),
      environment: process.env.NODE_ENV || 'development',
    };
    res.json(stats);
  } catch (err) { next(err); }
});

// Bulk status update
router.post('/bulk/status', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { ids, status } = req.body;
    if (!ids?.length || !status) return res.status(400).json({ error: 'ids and status required' });
    const updated = await Promise.all(ids.slice(0, 100).map(async (id) => {
      try { return await prisma.$executeRaw`UPDATE "contracts" SET status = ${status} WHERE id = ${id}`; }
      catch (e) { return null; }
    }));
    await req.audit({ action: 'bulk_update', module: 'contracts', details: `Bulk status update: ${ids.length} records to ${status}` });
    res.json({ updated: updated.filter(Boolean).length, requested: ids.length });
  } catch (err) { next(err); }
});
