const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = Router();
router.use(authenticate);

// GET /campaign-influence/deal/:dealId
router.get('/deal/:dealId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const influences = await prisma.campaignInfluence.findMany({
      where: { dealId: req.params.dealId },
      orderBy: { influence: 'desc' },
    });
    res.json({ data: influences });
  } catch (err) { next(err); }
});

// GET /campaign-influence/campaign/:campaignId
router.get('/campaign/:campaignId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const influences = await prisma.campaignInfluence.findMany({
      where: { campaignId: req.params.campaignId },
      orderBy: { revenue: 'desc' },
    });
    const totalRevenue = influences.reduce((s, i) => s + i.revenue, 0);
    const totalDeals = new Set(influences.map(i => i.dealId)).size;
    res.json({ data: influences, summary: { totalRevenue, totalDeals, avgInfluence: influences.length > 0 ? Math.round(influences.reduce((s, i) => s + i.influence, 0) / influences.length) : 0 } });
  } catch (err) { next(err); }
});

// POST /campaign-influence - Create/update influence
router.post('/', requirePermission('campaigns', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { campaignId, dealId, model, influence, contactId, isPrimary, touchDate } = req.body;
    const deal = await prisma.deal.findUnique({ where: { id: dealId } });
    const revenue = deal ? (deal.value * (influence || 0) / 100) : 0;

    const ci = await prisma.campaignInfluence.upsert({
      where: { campaignId_dealId_model: { campaignId, dealId, model: model || 'FirstTouch' } },
      update: { influence, revenue, contactId, isPrimary },
      create: { campaignId, dealId, model: model || 'FirstTouch', influence: influence || 0, revenue, contactId, isPrimary: isPrimary || false, touchDate: touchDate ? new Date(touchDate) : new Date() },
    });
    res.json(ci);
  } catch (err) { next(err); }
});

// POST /campaign-influence/calculate/:dealId - Auto-calculate attribution
router.post('/calculate/:dealId', requirePermission('campaigns', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { model = 'Linear' } = req.body;
    const deal = await prisma.deal.findUnique({ where: { id: req.params.dealId } });
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const existing = await prisma.campaignInfluence.findMany({ where: { dealId: req.params.dealId } });
    if (existing.length === 0) return res.json({ message: 'No campaign touches found' });

    if (model === 'Linear') {
      const share = 100 / existing.length;
      for (const ci of existing) {
        await prisma.campaignInfluence.update({
          where: { id: ci.id },
          data: { influence: share, revenue: deal.value * share / 100, model: 'Linear' },
        });
      }
    } else if (model === 'FirstTouch') {
      const sorted = existing.sort((a, b) => new Date(a.touchDate) - new Date(b.touchDate));
      for (let i = 0; i < sorted.length; i++) {
        await prisma.campaignInfluence.update({
          where: { id: sorted[i].id },
          data: { influence: i === 0 ? 100 : 0, revenue: i === 0 ? deal.value : 0, model: 'FirstTouch', isPrimary: i === 0 },
        });
      }
    } else if (model === 'LastTouch') {
      const sorted = existing.sort((a, b) => new Date(b.touchDate) - new Date(a.touchDate));
      for (let i = 0; i < sorted.length; i++) {
        await prisma.campaignInfluence.update({
          where: { id: sorted[i].id },
          data: { influence: i === 0 ? 100 : 0, revenue: i === 0 ? deal.value : 0, model: 'LastTouch', isPrimary: i === 0 },
        });
      }
    }

    const updated = await prisma.campaignInfluence.findMany({ where: { dealId: req.params.dealId } });
    res.json({ data: updated, model });
  } catch (err) { next(err); }
});

module.exports = router;

// Multi-touch attribution report
router.get('/attribution', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { model = 'linear', period = '90' } = req.query;
    const since = new Date(Date.now() - (+period) * 86400000);
    const influences = await prisma.campaignInfluence.findMany({
      where: { createdAt: { gte: since } },
      include: { campaign: { select: { name: true, type: true } }, deal: { select: { value: true, stage: true } } },
    }).catch(() => []);
    const byCampaign = {};
    influences.forEach(inf => {
      const key = inf.campaignId;
      if (!byCampaign[key]) byCampaign[key] = { campaignId: key, name: inf.campaign?.name, type: inf.campaign?.type, touches: 0, revenue: 0, deals: 0 };
      byCampaign[key].touches++;
      if (inf.deal?.stage === 'Closed Won') { byCampaign[key].revenue += (inf.deal.value || 0) * (inf.influencePercentage || 1); byCampaign[key].deals++; }
    });
    const report = Object.values(byCampaign).sort((a, b) => b.revenue - a.revenue);
    res.json({ model, period: +period, campaigns: report });
  } catch (err) { next(err); }
});

// ROI by campaign
router.get('/roi', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const campaigns = await prisma.campaign.findMany({ where: { deletedAt: null }, select: { id: true, name: true, budgetedCost: true, actualCost: true } });
    const result = [];
    for (const c of campaigns) {
      const influenced = await prisma.campaignInfluence.findMany({ where: { campaignId: c.id }, include: { deal: { select: { value: true, stage: true } } } }).catch(() => []);
      const revenue = influenced.filter(i => i.deal?.stage === 'Closed Won').reduce((s, i) => s + ((i.deal?.value || 0) * (i.influencePercentage || 1)), 0);
      const cost = c.actualCost || c.budgetedCost || 0;
      result.push({ campaignId: c.id, name: c.name, cost, attributedRevenue: revenue, roi: cost ? Math.round((revenue - cost) / cost * 100) : 0, deals: influenced.length });
    }
    result.sort((a, b) => b.roi - a.roi);
    res.json(result);
  } catch (err) { next(err); }
});

// Attribution model comparison
router.get('/attribution-models', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const influences = await prisma.campaignInfluence.findMany({ include: { campaign: { select: { name: true } }, deal: { select: { name: true, value: true, stage: true } } } });
    const wonInfluences = influences.filter(i => i.deal?.stage === 'Closed Won');
    // First-touch attribution
    const firstTouch = {};
    // Last-touch attribution
    const lastTouch = {};
    // Linear attribution
    const linear = {};
    const dealGroups = {};
    wonInfluences.forEach(i => {
      const key = i.dealId;
      if (!dealGroups[key]) dealGroups[key] = [];
      dealGroups[key].push(i);
    });
    Object.values(dealGroups).forEach(group => {
      group.sort((a, b) => new Date(a.influenceDate || a.createdAt) - new Date(b.influenceDate || b.createdAt));
      const dealValue = group[0].deal?.value || 0;
      if (group.length > 0) {
        const first = group[0].campaign?.name || 'Unknown';
        firstTouch[first] = (firstTouch[first] || 0) + dealValue;
        const last = group[group.length - 1].campaign?.name || 'Unknown';
        lastTouch[last] = (lastTouch[last] || 0) + dealValue;
        const share = dealValue / group.length;
        group.forEach(g => { const n = g.campaign?.name || 'Unknown'; linear[n] = (linear[n] || 0) + share; });
      }
    });
    res.json({ models: { firstTouch, lastTouch, linear }, totalInfluencedRevenue: wonInfluences.reduce((s, i) => s + (i.deal?.value || 0), 0), totalInfluences: influences.length, wonInfluences: wonInfluences.length });
  } catch (err) { next(err); }
});

// Campaign ROI
router.get('/roi', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const campaigns = await prisma.campaign.findMany({ where: { deletedAt: null }, select: { id: true, name: true, budgetedCost: true, actualCost: true, expectedRevenue: true } });
    const results = [];
    for (const c of campaigns) {
      const influences = await prisma.campaignInfluence.findMany({ where: { campaignId: c.id }, include: { deal: { select: { value: true, stage: true } } } });
      const wonRevenue = influences.filter(i => i.deal?.stage === 'Closed Won').reduce((s, i) => s + (i.influencePercentage || 100) / 100 * (i.deal?.value || 0), 0);
      const cost = c.actualCost || c.budgetedCost || 0;
      results.push({ campaignId: c.id, name: c.name, cost, wonRevenue: Math.round(wonRevenue), roi: cost > 0 ? ((wonRevenue - cost) / cost * 100).toFixed(1) + '%' : 'N/A', touchpoints: influences.length });
    }
    results.sort((a, b) => b.wonRevenue - a.wonRevenue);
    res.json(results);
  } catch (err) { next(err); }
});
