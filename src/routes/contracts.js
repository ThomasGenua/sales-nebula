const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere, linkRefusal } = require('../middleware/access');
const { createCrudRouter } = require('../utils/crud');
const { createNumbered, CONTRACT_NUMBER } = require('../utils/numbering');
const { summaryRoute } = require('../utils/moduleStatus');
const { editableFields } = require('../utils/modelFields');

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
  // A contract must have an account and its dates; without them the create
  // answered 500.
  validate: (data) => {
    const errors = {};
    for (const field of ['accountId', 'startDate', 'endDate']) if (!data[field]) errors[field] = 'Required';
    return { valid: Object.keys(errors).length === 0, errors };
  },
});

// A contract's value: `value`, which the page and these routes write, or
// `totalValue`, where only that was set (the seed's contract).
const contractValue = c => c.value ?? c.totalValue ?? 0;

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
    const original = await prisma.contract.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!original) return res.status(404).json({ error: 'Contract not found' });
    // A new draft: it took the original's deleted marker, activation,
    // signature and termination with the rest.
    const {
      id, createdAt, updatedAt, contractNumber, deletedAt,
      activatedAt, activatedById, signedDate, terminationDate, terminationReason,
      ...contractData
    } = original;
    // The amendment's own columns from the body: relation keys were nested
    // writes into the account and its deals. Not its owner or deleted
    // marker, and links only to records the caller can see, as on a create.
    const changes = editableFields('contract', req.body);
    const linkProblem = await linkRefusal(req, 'contract', changes, original);
    if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
    const amendment = await createNumbered(prisma, 'contract', CONTRACT_NUMBER, {
      data: {
        ...contractData, ...changes,
        name: `${original.name || original.contractNumber} (Amendment)`,
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
    const original = await prisma.contract.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!original) return res.status(404).json({ error: 'Contract not found' });
    const { priceAdjustment } = req.body;
    // A number of months: sent as text it was appended to the month, so
    // "12" renewed a contract for decades.
    const months = parseInt(req.body.months) || 12;
    const newStart = original.endDate ? new Date(original.endDate) : new Date();
    const newEnd = new Date(newStart); newEnd.setMonth(newEnd.getMonth() + months);
    // The renewal is the caller's, as a contract they create is, with the
    // original's contact and terms; with no owner, a Private default hid it.
    const renewed = await createNumbered(prisma, 'contract', CONTRACT_NUMBER, {
      data: {
        name: `${original.name || original.contractNumber} (Renewal)`, accountId: original.accountId, dealId: original.dealId,
        contactId: original.contactId, billingFrequency: original.billingFrequency, autoRenew: original.autoRenew,
        startDate: newStart, endDate: newEnd, contractTerm: months, status: 'Draft', parentContractId: original.id,
        value: Number(priceAdjustment) || contractValue(original), ownerId: req.userId,
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
    if (!contractValue(contract)) issues.push({ field: 'value', severity: 'warning', message: 'No value specified' });
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
    // Dates and amounts as the columns take them: text or a bad date was a 500.
    if (dueDate && Number.isNaN(new Date(dueDate).getTime())) return res.status(400).json({ error: 'dueDate must be a date' });
    const value = amount === undefined || amount === null || amount === '' ? null : Number(amount);
    if (Number.isNaN(value)) return res.status(400).json({ error: 'amount must be a number' });
    const ms = await prisma.contractMilestone.create({ data: { contractId: req.params.id, name, dueDate: dueDate ? new Date(dueDate) : null, description, amount: value } });
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
      // The contracts the caller may see; this listed everyone's.
      const expiring = await prisma.contract.findMany({ where: await reachableWhere(req, 'contracts', 'contract', { endDate: { gte: start, lt: end }, status: { not: 'Terminated' } }), select: { id: true, name: true, value: true, totalValue: true, endDate: true } });
      forecast.push({ month: start.toISOString().substring(0, 7), count: expiring.length, value: expiring.reduce((s, c) => s + contractValue(c), 0), contracts: expiring });
    }
    res.json(forecast);
  } catch (err) { next(err); }
});

module.exports = router;

// Totals from the module's own table.
summaryRoute(router, { module: 'contracts', model: 'contract' });
