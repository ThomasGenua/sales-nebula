const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { createCrudRouter } = require('../utils/crud');

const router = createCrudRouter('partner', 'partners', {
  include: {
    account: { select: { id: true, name: true } },
  },
  searchFilter: (q) => ({
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      { type: { contains: q, mode: 'insensitive' } },
    ],
  }),
  validate: (data) => {
    const errors = {};
    if (!data.name?.trim()) errors.name = 'Partner name required';
    return { valid: Object.keys(errors).length === 0, errors };
  },
});

// Partner tiers and performance
router.get('/:id/performance', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const partner = await prisma.partner.findUnique({ where: { id: req.params.id } });
    if (!partner) return res.status(404).json({ error: 'Partner not found' });
    const deals = await prisma.deal.findMany({ where: { partnerId: req.params.id } });
    const won = deals.filter(d => d.stage === 'Closed Won');
    const totalRevenue = won.reduce((sum, d) => sum + (parseFloat(d.value) || 0), 0);
    const pipeline = deals.filter(d => !['Closed Won', 'Closed Lost'].includes(d.stage));
    res.json({
      partnerId: partner.id, name: partner.name, tier: partner.tier,
      totalDeals: deals.length, wonDeals: won.length,
      winRate: deals.length ? ((won.length / deals.length) * 100).toFixed(1) : 0,
      totalRevenue, pipelineValue: pipeline.reduce((s, d) => s + (parseFloat(d.value) || 0), 0),
      pipelineCount: pipeline.length,
    });
  } catch (err) { next(err); }
});

// Certifications
router.post('/:id/certifications', authenticate, requirePermission('partners', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const partner = await prisma.partner.findUnique({ where: { id: req.params.id } });
    if (!partner) return res.status(404).json({ error: 'Partner not found' });
    const certs = Array.isArray(partner.certifications) ? partner.certifications : [];
    certs.push({ name: req.body.name, issuedAt: new Date(), expiresAt: req.body.expiresAt || null });
    const updated = await prisma.partner.update({ where: { id: req.params.id }, data: { certifications: certs } });
    res.json(updated);
  } catch (err) { next(err); }
});

// Deal registration
router.post('/:id/register-deal', authenticate, requirePermission('partners', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { dealName, value, accountId, notes } = req.body;
    if (!dealName) return res.status(400).json({ error: 'dealName required' });
    const deal = await prisma.deal.create({
      data: {
        name: `[Partner] ${dealName}`, value: value || 0, stage: 'Qualification',
        partnerId: req.params.id, source: 'Partner Referral',
        ...(accountId && { accountId }), description: notes || '',
      },
    });
    await req.audit({ action: 'create', module: 'deals', recordId: deal.id, details: 'Partner deal registration' });
    res.status(201).json(deal);
  } catch (err) { next(err); }
});

// Tier evaluation
router.post('/:id/evaluate-tier', authenticate, requirePermission('partners', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const partner = await prisma.partner.findUnique({ where: { id: req.params.id } });
    if (!partner) return res.status(404).json({ error: 'Partner not found' });
    const deals = await prisma.deal.findMany({ where: { partnerId: req.params.id, stage: 'Closed Won' } });
    const revenue = deals.reduce((s, d) => s + (parseFloat(d.value) || 0), 0);
    let newTier = 'Registered';
    if (revenue >= 500000 || deals.length >= 20) newTier = 'Platinum';
    else if (revenue >= 200000 || deals.length >= 10) newTier = 'Gold';
    else if (revenue >= 50000 || deals.length >= 5) newTier = 'Silver';
    const updated = await prisma.partner.update({ where: { id: req.params.id }, data: { tier: newTier } });
    await req.audit({ action: 'update', module: 'partners', recordId: partner.id, details: `Tier changed to ${newTier}` });
    res.json({ previousTier: partner.tier, newTier, revenue, dealCount: deals.length });
  } catch (err) { next(err); }
});

module.exports = router;

// Partner pipeline
router.get('/:id/pipeline', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const deals = await prisma.deal.findMany({ where: { partnerId: req.params.id, deletedAt: null, stage: { notIn: ['Closed Won','Closed Lost'] } }, select: { id: true, name: true, value: true, stage: true, closeDate: true } });
    res.json({ partnerId: req.params.id, pipeline: deals, totalValue: deals.reduce((s, d) => s + (d.value || 0), 0), dealCount: deals.length });
  } catch (err) { next(err); }
});

// Partner commission
router.get('/:id/commissions', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const partner = await prisma.partner.findUnique({ where: { id: req.params.id } });
    if (!partner) return res.status(404).json({ error: 'Not found' });
    // A won deal's closeDate is when it closed; there is no closedAt.
    const wonDeals = await prisma.deal.findMany({ where: { partnerId: req.params.id, stage: 'Closed Won', deletedAt: null }, select: { id: true, name: true, value: true, closeDate: true } });
    const rate = partner.commissionRate || 0.10;
    const commissions = wonDeals.map(d => ({ dealId: d.id, dealName: d.name, value: d.value, commission: Math.round((d.value || 0) * rate), closedAt: d.closeDate }));
    res.json({ partnerId: partner.id, commissionRate: rate, totalCommission: commissions.reduce((s, c) => s + c.commission, 0), commissions });
  } catch (err) { next(err); }
});

// Bulk status check
router.get('/status/health', authenticate, async (req, res, next) => {
  try { res.json({ module: 'partners', healthy: true, timestamp: new Date(), version: '4.1.0' }); } catch (err) { next(err); }
});

// Count endpoint
router.get('/count', authenticate, async (req, res, next) => {
  try { res.json({ count: 0, module: 'partners' }); } catch (err) { next(err); }
});

// Partner activities
router.get('/:id/activities', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Activities carry no partner; a partner's activities are those on the
    // deals the partner brought in.
    const activities = await prisma.activity.findMany({ where: { deal: { partnerId: req.params.id }, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 20 });
    res.json(activities);
  } catch (err) { next(err); }
});

// Partner score card
router.get('/:id/scorecard', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const partner = await prisma.partner.findUnique({ where: { id: req.params.id } });
    if (!partner) return res.status(404).json({ error: 'Not found' });
    const deals = await prisma.deal.findMany({ where: { partnerId: partner.id, deletedAt: null } });
    const won = deals.filter(d => d.stage === 'Closed Won');
    res.json({ partnerId: partner.id, tier: partner.tier, totalDeals: deals.length, wonDeals: won.length, winRate: deals.length ? Math.round(won.length / deals.length * 100) : 0, totalRevenue: won.reduce((s, d) => s + (d.value || 0), 0), avgDealSize: won.length ? Math.round(won.reduce((s, d) => s + (d.value || 0), 0) / won.length) : 0 });
  } catch (err) { next(err); }
});

module.exports = router;

// Analytics / Stats
router.get('/analytics/summary', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const thirtyDays = new Date(Date.now() - 30 * 86400000);
    const modelName = 'Partners';
    // Generic stats endpoint
    const stats = {
      module: 'partners',
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
      try { return await prisma.$executeRaw`UPDATE "partners" SET status = ${status} WHERE id = ${id}`; }
      catch (e) { return null; }
    }));
    await req.audit({ action: 'bulk_update', module: 'partners', details: `Bulk status update: ${ids.length} records to ${status}` });
    res.json({ updated: updated.filter(Boolean).length, requested: ids.length });
  } catch (err) { next(err); }
});
