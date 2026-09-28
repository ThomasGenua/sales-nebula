const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { linkRefusal, reachableWhere } = require('../middleware/access');
const { createCrudRouter } = require('../utils/crud');
const { currencyContext, sumInBase, resolveDealCurrency } = require('../utils/currency');
const { statusRoutes, summaryRoute } = require('../utils/moduleStatus');

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

/**
 * The partner's live deals matching `where` that the caller may see (deals
 * read and row reach). The partner figures below summed every deal it
 * brought in, deleted ones and other reps' included, in mixed currencies.
 */
async function partnerDeals(req, where, select) {
  if (!permits(req, 'deals', 'read')) return [];
  return req.app.locals.prisma.deal.findMany({ where: await reachableWhere(req, 'deals', 'deal', where), select });
}

// Partner tiers and performance
router.get('/:id/performance', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const partner = await prisma.partner.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!partner) return res.status(404).json({ error: 'Partner not found' });
    const deals = await partnerDeals(req, { partnerId: partner.id }, { stage: true, value: true, currency: true });
    const ctx = await currencyContext(prisma);
    const won = deals.filter(d => d.stage === 'Closed Won');
    const pipeline = deals.filter(d => !['Closed Won', 'Closed Lost'].includes(d.stage));
    res.json({
      partnerId: partner.id, name: partner.name, tier: partner.tier, currency: ctx.base,
      totalDeals: deals.length, wonDeals: won.length,
      winRate: deals.length ? ((won.length / deals.length) * 100).toFixed(1) : 0,
      totalRevenue: sumInBase(won, ctx), pipelineValue: sumInBase(pipeline, ctx),
      pipelineCount: pipeline.length,
    });
  } catch (err) { next(err); }
});

// Certifications
router.post('/:id/certifications', authenticate, requirePermission('partners', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!req.body.name) return res.status(400).json({ error: 'name required' });
    const partner = await prisma.partner.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!partner) return res.status(404).json({ error: 'Partner not found' });
    const certs = Array.isArray(partner.certifications) ? partner.certifications : [];
    certs.push({ name: req.body.name, issuedAt: new Date(), expiresAt: req.body.expiresAt || null });
    const updated = await prisma.partner.update({ where: { id: req.params.id }, data: { certifications: certs } });
    res.json(updated);
  } catch (err) { next(err); }
});

// Deal registration
// It creates a deal, so it takes deals edit, on an account the caller can
// see: partners edit alone filed a deal on any account id.
router.post('/:id/register-deal', authenticate, requirePermission('partners', 'edit'), requirePermission('deals', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { dealName, value, currency, accountId, notes } = req.body;
    if (!dealName) return res.status(400).json({ error: 'dealName required' });
    const linkProblem = await linkRefusal(req, 'deal', { accountId });
    if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
    const deal = await prisma.deal.create({
      data: {
        name: `[Partner] ${dealName}`, value: value || 0, currency: await resolveDealCurrency(prisma, currency), stage: 'Qualification',
        partnerId: req.params.id, source: 'Partner Referral',
        ...(accountId && { accountId }), description: notes || '',
        // Owned by whoever registered it: with no owner, a Private deals
        // default hid it from them. (Deal has no createdById.)
        ownerId: req.user.id,
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
    const partner = await prisma.partner.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!partner) return res.status(404).json({ error: 'Partner not found' });
    // The tier is the partner's, so from every live won deal it brought in,
    // not just those the caller can see; deleted deals counted, and values
    // were added across currencies.
    const deals = await prisma.deal.findMany({ where: { partnerId: req.params.id, stage: 'Closed Won', deletedAt: null }, select: { value: true, currency: true } });
    const revenue = sumInBase(deals, await currencyContext(prisma));
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
    const deals = await partnerDeals(req, { partnerId: req.params.id, stage: { notIn: ['Closed Won','Closed Lost'] } }, { id: true, name: true, value: true, currency: true, stage: true, closeDate: true });
    const ctx = await currencyContext(prisma);
    // Each deal keeps its own currency; the total is in the default.
    res.json({ partnerId: req.params.id, currency: ctx.base, pipeline: deals, totalValue: sumInBase(deals, ctx), dealCount: deals.length });
  } catch (err) { next(err); }
});

// Partner commission
router.get('/:id/commissions', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const partner = await prisma.partner.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!partner) return res.status(404).json({ error: 'Not found' });
    // A won deal's closeDate is when it closed; there is no closedAt.
    const wonDeals = await partnerDeals(req, { partnerId: req.params.id, stage: 'Closed Won' }, { id: true, name: true, value: true, currency: true, closeDate: true });
    const rate = partner.commissionRate || 0.10;
    const ctx = await currencyContext(prisma);
    // A commission is in its deal's currency; the total is in the default.
    const commissions = wonDeals.map(d => ({ dealId: d.id, dealName: d.name, value: d.value, currency: d.currency || ctx.base, commission: Math.round((d.value || 0) * rate), closedAt: d.closeDate }));
    const totalCommission = Math.round(wonDeals.reduce((s, d) => s + ctx.toBase(d.value, d.currency) * rate, 0));
    res.json({ partnerId: partner.id, commissionRate: rate, currency: ctx.base, totalCommission, commissions });
  } catch (err) { next(err); }
});

// Record count, health and summary, answered from the module's own table.
statusRoutes(router, { module: 'partners', model: 'partner' });

// Partner activities
router.get('/:id/activities', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Activities carry no partner; a partner's activities are those on the
    // deals the partner brought in, of the ones the caller may see.
    const activities = permits(req, 'activities', 'read')
      ? await prisma.activity.findMany({ where: await reachableWhere(req, 'activities', 'activity', { deal: { is: { partnerId: req.params.id, deletedAt: null } } }), orderBy: { createdAt: 'desc' }, take: 20 })
      : [];
    res.json(activities);
  } catch (err) { next(err); }
});

// Partner score card
router.get('/:id/scorecard', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const partner = await prisma.partner.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!partner) return res.status(404).json({ error: 'Not found' });
    const deals = await partnerDeals(req, { partnerId: partner.id }, { stage: true, value: true, currency: true });
    const won = deals.filter(d => d.stage === 'Closed Won');
    const ctx = await currencyContext(prisma);
    const revenue = sumInBase(won, ctx);
    res.json({ partnerId: partner.id, tier: partner.tier, currency: ctx.base, totalDeals: deals.length, wonDeals: won.length, winRate: deals.length ? Math.round(won.length / deals.length * 100) : 0, totalRevenue: revenue, avgDealSize: won.length ? Math.round(revenue / won.length) : 0 });
  } catch (err) { next(err); }
});

module.exports = router;

// Totals from the module's own table.
summaryRoute(router, { module: 'partners', model: 'partner' });
