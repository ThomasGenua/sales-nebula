const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { queryWithIncludes } = require('../utils/modelFields');
const { moduleAccess, recordAccess } = require('../middleware/access');

const router = Router();

// Mounted at /api/deals behind the deals CRUD router. Every route here names
// a deal, which must be one the caller can see (or change, for a write);
// these took any deal id with authenticate() alone.
router.use(authenticate, moduleAccess('deals'));
router.param('id', recordAccess('deals', 'deal'));

// Deal contact roles
router.get('/:id/contact-roles', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const roles = await queryWithIncludes(prisma, 'dealContactRole', 'findMany', {
      where: { dealId: req.params.id },
      include: { contact: { select: { id: true, firstName: true, lastName: true, email: true, title: true, phone: true } } },
    });
    res.json(roles);
  } catch (err) { next(err); }
});

router.post('/:id/contact-roles', authenticate, requirePermission('deals', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { contactId, role, isPrimary } = req.body;
    if (!contactId || !role) return res.status(400).json({ error: 'contactId and role required' });
    if (isPrimary) await prisma.dealContactRole.updateMany({ where: { dealId: req.params.id }, data: { isPrimary: false } });
    const dcr = await prisma.dealContactRole.create({ data: { dealId: req.params.id, contactId, role, isPrimary: isPrimary || false } });
    res.status(201).json(dcr);
  } catch (err) { next(err); }
});

router.delete('/:id/contact-roles/:roleId', authenticate, requirePermission('deals', 'edit'), async (req, res, next) => {
  try {
    // A role on this deal: any role on any deal went by id.
    const { count } = await req.app.locals.prisma.dealContactRole.deleteMany({ where: { id: req.params.roleId, dealId: req.params.id } });
    if (!count) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Deal products (line items with more detail)
router.get('/:id/products', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const items = await prisma.dealLineItem.findMany({
      where: { dealId: req.params.id },
      include: { product: { select: { id: true, name: true, sku: true } } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    // A line's amount is `total`; there is no totalPrice, so this summed to 0.
    const total = items.reduce((s, i) => s + (parseFloat(i.total) || 0), 0);
    res.json({ items, total, count: items.length });
  } catch (err) { next(err); }
});

// Deal stage history
router.get('/:id/stage-history', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const history = await queryWithIncludes(prisma, 'dealStageHistory', 'findMany', {
      where: { dealId: req.params.id }, orderBy: { createdAt: 'asc' },
      include: { changedBy: { select: { id: true, firstName: true, lastName: true } } },
    });
    // Calculate time in each stage. A row's timestamp is createdAt; callers
    // still read it as changedAt.
    const enriched = history.map((h, i) => {
      const next = history[i + 1];
      const daysInStage = next ? Math.round((new Date(next.createdAt) - new Date(h.createdAt)) / 86400000) : null;
      return { ...h, changedAt: h.createdAt, daysInStage };
    });
    res.json(enriched);
  } catch (err) { next(err); }
});

// Deal score/health
router.get('/:id/health', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const deal = await prisma.deal.findUnique({ where: { id: req.params.id } });
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    let score = 50;
    const factors = [];
    // Has close date
    if (deal.closeDate) { const daysOut = Math.ceil((new Date(deal.closeDate) - new Date()) / 86400000); if (daysOut > 0 && daysOut < 90) { score += 10; factors.push('Close date within 90 days'); } else if (daysOut < 0) { score -= 20; factors.push('Close date is past due'); } }
    // Has value
    if (parseFloat(deal.value) > 0) { score += 10; factors.push('Has monetary value'); }
    // Has activities recently
    const recentActivities = await prisma.activity.count({ where: { dealId: req.params.id, createdAt: { gte: new Date(Date.now() - 7 * 86400000) } } });
    if (recentActivities > 0) { score += 15; factors.push(`${recentActivities} activities in last 7 days`); } else { score -= 15; factors.push('No recent activity'); }
    // Has contact roles
    const contactRoles = await prisma.dealContactRole.count({ where: { dealId: req.params.id } });
    if (contactRoles > 0) { score += 10; factors.push(`${contactRoles} contact roles defined`); } else { score -= 10; factors.push('No contact roles'); }
    // Probability
    if (deal.probability >= 70) { score += 10; factors.push('High probability'); }
    res.json({ dealId: deal.id, healthScore: Math.max(0, Math.min(100, score)), factors });
  } catch (err) { next(err); }
});

// Similar/related deals
router.get('/:id/similar', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const deal = await prisma.deal.findUnique({ where: { id: req.params.id } });
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    const similar = await prisma.deal.findMany({
      where: {
        id: { not: deal.id }, deletedAt: null,
        OR: [
          ...(deal.accountId ? [{ accountId: deal.accountId }] : []),
          { stage: deal.stage },
        ],
      },
      take: 10, orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, stage: true, value: true, probability: true, closeDate: true },
    });
    res.json(similar);
  } catch (err) { next(err); }
});

module.exports = router;

// Deal competitors
router.get('/:id/competitors', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const competitors = await prisma.dealCompetitor.findMany({ where: { dealId: req.params.id } }).catch(() => []);
    res.json(competitors);
  } catch (err) { next(err); }
});

router.post('/:id/competitors', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, strengths, weaknesses, position } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const comp = await prisma.dealCompetitor.create({ data: { dealId: req.params.id, name, strengths, weaknesses, position } });
    res.status(201).json(comp);
  } catch (err) { next(err); }
});

// Win/loss analysis
router.get('/:id/analysis', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const deal = await prisma.deal.findUnique({ where: { id: req.params.id }, include: { activities: { where: { deletedAt: null } }, contactRoles: { select: { role: true } } } });
    if (!deal) return res.status(404).json({ error: 'Not found' });
    const daysInPipeline = deal.createdAt ? Math.floor((Date.now() - new Date(deal.createdAt)) / 86400000) : 0;
    res.json({ dealId: deal.id, stage: deal.stage, daysInPipeline, activityCount: deal.activities?.length || 0, contactRoles: deal.contactRoles?.length || 0, hasDecisionMaker: (deal.contactRoles || []).some(c => c.role === 'Decision Maker'), recommendedActions: daysInPipeline > 60 ? ['Schedule follow-up','Engage executive sponsor'] : ['Continue nurturing'] });
  } catch (err) { next(err); }
});

// Deal win probability analysis
router.get('/:id/win-analysis', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const deal = await prisma.deal.findUnique({ where: { id: req.params.id } });
    if (!deal) return res.status(404).json({ error: 'Not found' });
    const activities = await prisma.activity.count({ where: { dealId: deal.id, createdAt: { gte: new Date(Date.now() - 30 * 86400000) } } });
    const contacts = await prisma.dealContactRole.count({ where: { dealId: deal.id } }).catch(() => 0);
    const daysSinceUpdate = Math.floor((Date.now() - new Date(deal.updatedAt)) / 86400000);
    const factors = {
      hasActivities: { score: activities > 0 ? 15 : -10, detail: `${activities} activities in 30d` },
      hasContacts: { score: contacts >= 2 ? 10 : contacts === 1 ? 5 : -10, detail: `${contacts} contact roles` },
      recentlyUpdated: { score: daysSinceUpdate < 7 ? 10 : daysSinceUpdate < 14 ? 5 : -15, detail: `Updated ${daysSinceUpdate}d ago` },
      hasValue: { score: deal.value > 0 ? 10 : -5, detail: `$${(deal.value || 0).toLocaleString()}` },
      hasCloseDate: { score: deal.closeDate ? 10 : -10, detail: deal.closeDate ? new Date(deal.closeDate).toLocaleDateString() : 'Not set' },
    };
    const totalScore = Math.max(0, Math.min(100, 50 + Object.values(factors).reduce((s, f) => s + f.score, 0)));
    res.json({ dealId: deal.id, winScore: totalScore, factors });
  } catch (err) { next(err); }
});
