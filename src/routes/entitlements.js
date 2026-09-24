const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere, linkRefusal } = require('../middleware/access');
const { createCrudRouter } = require('../utils/crud');
const { editableFields } = require('../utils/modelFields');

const router = createCrudRouter('entitlement', 'entitlements', {
  include: {
    account: { select: { id: true, name: true } },
    contact: { select: { id: true, firstName: true, lastName: true } },
  },
  searchFilter: (q) => ({ name: { contains: q, mode: 'insensitive' } }),
  // An entitlement must have an account and its dates; without them the
  // create answered 500.
  validate: (data) => {
    const errors = {};
    for (const field of ['accountId', 'startDate', 'endDate']) if (!data[field]) errors[field] = 'Required';
    return { valid: Object.keys(errors).length === 0, errors };
  },
});

// How many cases an entitlement covers: casesPerEntitlement, which the page
// and these routes use, or casesAllowed where only that was set (the seed's).
// Null is unlimited. Cases counted against it are its live ones.
const caseLimit = e => e.casesPerEntitlement ?? e.casesAllowed ?? null;
const liveCases = entitlementId => ({ entitlementId, deletedAt: null });

// Check entitlement for account
router.get('/check/:accountId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const now = new Date();
    // The entitlements the caller may see; any account id listed everyone's.
    const entitlements = await prisma.entitlement.findMany({
      where: await reachableWhere(req, 'entitlements', 'entitlement', { accountId: String(req.params.accountId), status: 'Active', startDate: { lte: now }, endDate: { gte: now } }),
    });
    const hasEntitlement = entitlements.length > 0;
    // Check remaining cases for each entitlement
    const enriched = await Promise.all(entitlements.map(async (e) => {
      const usedCases = await prisma.case.count({ where: liveCases(e.id) });
      return { ...e, usedCases, remainingCases: caseLimit(e) ? Math.max(0, caseLimit(e) - usedCases) : 'Unlimited' };
    }));
    res.json({ accountId: req.params.accountId, entitled: hasEntitlement, entitlements: enriched });
  } catch (err) { next(err); }
});

// Consume entitlement (decrement remaining)
router.post('/:id/consume', authenticate, requirePermission('entitlements', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const entitlement = await prisma.entitlement.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!entitlement) return res.status(404).json({ error: 'Not found' });
    if (entitlement.status !== 'Active') return res.status(400).json({ error: 'Entitlement not active' });
    const usedCases = await prisma.case.count({ where: liveCases(entitlement.id) });
    const limit = caseLimit(entitlement);
    if (limit && usedCases >= limit) return res.status(400).json({ error: 'Entitlement exhausted', used: usedCases, limit });
    res.json({ success: true, remaining: limit ? limit - usedCases - 1 : 'Unlimited' });
  } catch (err) { next(err); }
});

// Renew entitlement
router.post('/:id/renew', authenticate, requirePermission('entitlements', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // A number of months: sent as text it was appended to the month.
    const months = parseInt(req.body.months) || 12;
    const entitlement = await prisma.entitlement.findFirst({ where: { id: req.params.id, deletedAt: null } });
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
    const entitlement = await prisma.entitlement.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!entitlement) return res.status(404).json({ error: 'Not found' });
    // Usage counts every live case on it; the list shows the ones the caller
    // may see. Deleted cases counted, and every case's subject was listed.
    const used = await prisma.case.count({ where: liveCases(entitlement.id) });
    const cases = permits(req, 'cases', 'read') ? await prisma.case.findMany({
      where: await reachableWhere(req, 'cases', 'case', { entitlementId: entitlement.id }),
      select: { id: true, caseNumber: true, subject: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }) : [];
    const limit = caseLimit(entitlement);
    res.json({
      entitlementId: entitlement.id, name: entitlement.name,
      limit: limit || 'Unlimited',
      used, remaining: limit ? Math.max(0, limit - used) : 'Unlimited',
      utilizationRate: limit ? ((used / limit) * 100).toFixed(1) : null,
      cases,
    });
  } catch (err) { next(err); }
});

module.exports = router;

// Entitlement process management
router.get('/processes', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const processes = await prisma.entitlementProcess.findMany({ orderBy: { name: 'asc' } });
    // A process keeps its milestones in `steps`; callers read them as milestones.
    res.json(processes.map(p => ({ ...p, milestones: p.steps || [] })));
  } catch (err) { next(err); }
});

router.post('/processes', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, entitlementId, milestones } = req.body;
    if (!name || !entitlementId) return res.status(400).json({ error: 'name and entitlementId required' });
    const entitlement = await prisma.entitlement.findUnique({ where: { id: entitlementId }, select: { id: true } });
    if (!entitlement) return res.status(404).json({ error: 'Entitlement not found' });
    // There is no milestone table for processes; the ordered steps are stored
    // as JSON on the process itself.
    const steps = (milestones || []).map((m, i) => ({ name: m.name, triggerMinutes: m.triggerMinutes || 60, actions: m.actions || {}, order: i }));
    const process = await prisma.entitlementProcess.create({
      data: { name, description, entitlementId, steps },
    });
    res.status(201).json({ ...process, milestones: steps });
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
    const seen = new Map();
    for (const e of entitlements.slice(0, 100)) {
      try {
        // Each row's own columns, owned by the importer, linked only to
        // records they can see, as a single create is. Rows went to Prisma
        // whole: ids, dates, nested writes into the account, and a date
        // input's "2026-01-01", which Prisma refuses.
        const data = { ...editableFields('entitlement', e), createdById: req.user.id };
        const refusal = await linkRefusal(req, 'entitlement', data, null, seen);
        if (refusal) throw new Error(refusal);
        const ent = await prisma.entitlement.create({ data });
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
    const ent = await prisma.entitlement.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!ent) return res.status(404).json({ error: 'Not found' });
    // To a live account the caller can see: the id was stored as sent.
    const linkProblem = await linkRefusal(req, 'entitlement', { accountId: String(targetAccountId) }, ent);
    if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
    const previousAccountId = ent.accountId;
    const updated = await prisma.entitlement.update({ where: { id: req.params.id }, data: { accountId: targetAccountId } });
    await req.audit({ action: 'update', module: 'entitlements', recordId: ent.id, details: `Transferred from account ${previousAccountId} to ${targetAccountId}. Reason: ${reason || 'N/A'}` });
    res.json(updated);
  } catch (err) { next(err); }
});

module.exports = router;
