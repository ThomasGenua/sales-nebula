const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { createCrudRouter } = require('../utils/crud');

const router = createCrudRouter('entitlement', 'entitlements', {
  include: {
    account: { select: { id: true, name: true } },
    contact: { select: { id: true, firstName: true, lastName: true } },
  },
  searchFilter: (q) => ({ name: { contains: q, mode: 'insensitive' } }),
});

// Check entitlement for account
router.get('/check/:accountId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const now = new Date();
    const entitlements = await prisma.entitlement.findMany({
      where: { accountId: req.params.accountId, status: 'Active', startDate: { lte: now }, endDate: { gte: now }, deletedAt: null },
    });
    const hasEntitlement = entitlements.length > 0;
    // Check remaining cases for each entitlement
    const enriched = await Promise.all(entitlements.map(async (e) => {
      const usedCases = await prisma.case.count({ where: { entitlementId: e.id } });
      return { ...e, usedCases, remainingCases: e.casesPerEntitlement ? Math.max(0, e.casesPerEntitlement - usedCases) : 'Unlimited' };
    }));
    res.json({ accountId: req.params.accountId, entitled: hasEntitlement, entitlements: enriched });
  } catch (err) { next(err); }
});

// Consume entitlement (decrement remaining)
router.post('/:id/consume', authenticate, requirePermission('entitlements', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const entitlement = await prisma.entitlement.findUnique({ where: { id: req.params.id } });
    if (!entitlement || entitlement.status !== 'Active') return res.status(400).json({ error: 'Entitlement not active' });
    const usedCases = await prisma.case.count({ where: { entitlementId: req.params.id } });
    if (entitlement.casesPerEntitlement && usedCases >= entitlement.casesPerEntitlement) return res.status(400).json({ error: 'Entitlement exhausted', used: usedCases, limit: entitlement.casesPerEntitlement });
    res.json({ success: true, remaining: entitlement.casesPerEntitlement ? entitlement.casesPerEntitlement - usedCases - 1 : 'Unlimited' });
  } catch (err) { next(err); }
});

// Renew entitlement
router.post('/:id/renew', authenticate, requirePermission('entitlements', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { months = 12 } = req.body;
    const entitlement = await prisma.entitlement.findUnique({ where: { id: req.params.id } });
    if (!entitlement) return res.status(404).json({ error: 'Entitlement not found' });
    const newEnd = new Date(entitlement.endDate || Date.now());
    newEnd.setMonth(newEnd.getMonth() + months);
    const updated = await prisma.entitlement.update({ where: { id: req.params.id }, data: { endDate: newEnd, status: 'Active' } });
    await req.audit({ action: 'update', module: 'entitlements', recordId: req.params.id, details: `Renewed for ${months} months` });
    res.json(updated);
  } catch (err) { next(err); }
});

// Entitlement usage report
router.get('/:id/usage', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const entitlement = await prisma.entitlement.findUnique({ where: { id: req.params.id } });
    if (!entitlement) return res.status(404).json({ error: 'Not found' });
    const cases = await prisma.case.findMany({
      where: { entitlementId: req.params.id },
      select: { id: true, caseNumber: true, subject: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      entitlementId: entitlement.id, name: entitlement.name,
      limit: entitlement.casesPerEntitlement || 'Unlimited',
      used: cases.length, remaining: entitlement.casesPerEntitlement ? Math.max(0, entitlement.casesPerEntitlement - cases.length) : 'Unlimited',
      utilizationRate: entitlement.casesPerEntitlement ? ((cases.length / entitlement.casesPerEntitlement) * 100).toFixed(1) : null,
      cases,
    });
  } catch (err) { next(err); }
});

module.exports = router;

// Entitlement process management
router.get('/processes', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const processes = await prisma.entitlementProcess.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' }, include: { milestones: true } });
    res.json(processes);
  } catch (err) { next(err); }
});

router.post('/processes', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, milestones } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const process = await prisma.entitlementProcess.create({
      data: { name, description, milestones: milestones?.length ? { create: milestones.map((m, i) => ({ name: m.name, triggerMinutes: m.triggerMinutes || 60, actions: m.actions || {}, order: i })) } : undefined },
      include: { milestones: true },
    });
    res.status(201).json(process);
  } catch (err) { next(err); }
});

// SLA tracking per entitlement
router.get('/:id/sla', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const ent = await prisma.entitlement.findUnique({ where: { id: req.params.id } });
    if (!ent) return res.status(404).json({ error: 'Not found' });
    const cases = await prisma.case.findMany({ where: { entitlementId: ent.id, deletedAt: null }, select: { id: true, status: true, priority: true, createdAt: true, closedAt: true } });
    const resolved = cases.filter(c => c.closedAt);
    const avgResolutionHours = resolved.length ? resolved.reduce((s, c) => s + (new Date(c.closedAt) - new Date(c.createdAt)) / 3600000, 0) / resolved.length : 0;
    const breached = resolved.filter(c => {
      const hours = (new Date(c.closedAt) - new Date(c.createdAt)) / 3600000;
      const limit = { Critical: 4, High: 8, Medium: 24, Low: 72 }[c.priority] || 24;
      return hours > limit;
    });
    res.json({ entitlementId: ent.id, totalCases: cases.length, resolvedCases: resolved.length, avgResolutionHours: Math.round(avgResolutionHours * 10) / 10, slaBreaches: breached.length, slaComplianceRate: resolved.length ? Math.round((1 - breached.length / resolved.length) * 100) : 100, byPriority: ['Critical', 'High', 'Medium', 'Low'].map(p => ({ priority: p, total: cases.filter(c => c.priority === p).length, resolved: resolved.filter(c => c.priority === p).length })) });
  } catch (err) { next(err); }
});

// Bulk create entitlements
router.post('/bulk', authenticate, requirePermission('entitlements', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { entitlements } = req.body;
    if (!entitlements?.length) return res.status(400).json({ error: 'entitlements array required' });
    const results = [];
    for (const e of entitlements.slice(0, 100)) {
      try {
        const ent = await prisma.entitlement.create({ data: { ...e, createdById: req.user.id } });
        results.push({ id: ent.id, status: 'created' });
      } catch (err) { results.push({ data: e, status: 'error', error: err.message }); }
    }
    res.json({ processed: results.length, results });
  } catch (err) { next(err); }
});

// Transfer entitlement between accounts
router.post('/:id/transfer', authenticate, requirePermission('entitlements', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { targetAccountId, reason } = req.body;
    if (!targetAccountId) return res.status(400).json({ error: 'targetAccountId required' });
    const ent = await prisma.entitlement.findUnique({ where: { id: req.params.id } });
    if (!ent) return res.status(404).json({ error: 'Not found' });
    const previousAccountId = ent.accountId;
    const updated = await prisma.entitlement.update({ where: { id: req.params.id }, data: { accountId: targetAccountId } });
    await req.audit({ action: 'update', module: 'entitlements', recordId: ent.id, details: `Transferred from account ${previousAccountId} to ${targetAccountId}. Reason: ${reason || 'N/A'}` });
    res.json(updated);
  } catch (err) { next(err); }
});

module.exports = router;
