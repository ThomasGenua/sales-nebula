const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { reachableWhere } = require('../middleware/access');
const { queryWithIncludes } = require('../utils/modelFields');

const router = Router();
router.use(authenticate);

/** The ids, of those given, of records the caller may read: the module's read permission and row reach. */
async function readableIds(req, module, model, ids) {
  const wanted = [...new Set(ids.filter(Boolean).map(String))];
  if (!wanted.length || !permits(req, module, 'read')) return new Set();
  const rows = await req.app.locals.prisma[model].findMany({ where: await reachableWhere(req, module, model, { id: { in: wanted } }), select: { id: true } });
  return new Set(rows.map(r => r.id));
}

/**
 * The influences on deals and campaigns the caller may read, as notes.js
 * does for notes. An influence's revenue gives away its deal's value, and
 * the reports name the campaign; both went to anyone signed in.
 */
async function readableInfluences(req, influences) {
  const deals = await readableIds(req, 'deals', 'deal', influences.map(i => i.dealId));
  const campaigns = await readableIds(req, 'campaigns', 'campaign', influences.map(i => i.campaignId));
  return influences.filter(i => deals.has(i.dealId) && campaigns.has(i.campaignId));
}

// GET /campaign-influence/deal/:dealId
// On a deal the caller can see: any deal id listed its influences, and with
// them the deal's value, to anyone signed in.
router.get('/deal/:dealId', requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const deal = await prisma.deal.findFirst({ where: await reachableWhere(req, 'deals', 'deal', { id: String(req.params.dealId) }), select: { id: true } });
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    const influences = await prisma.campaignInfluence.findMany({
      where: { dealId: deal.id },
      orderBy: { influence: 'desc' },
    });
    res.json({ data: influences });
  } catch (err) { next(err); }
});

// GET /campaign-influence/campaign/:campaignId
// On a campaign the caller can see, and only its influences on deals they
// can see: any campaign id listed every deal it touched, with its revenue.
router.get('/campaign/:campaignId', requirePermission('campaigns', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const campaign = await prisma.campaign.findFirst({ where: await reachableWhere(req, 'campaigns', 'campaign', { id: String(req.params.campaignId) }), select: { id: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const influences = await readableInfluences(req, await prisma.campaignInfluence.findMany({
      where: { campaignId: campaign.id },
      orderBy: { revenue: 'desc' },
    }));
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
    if (!campaignId || !dealId) return res.status(400).json({ error: 'campaignId and dealId required' });
    // A campaign the caller can edit, credited with a deal and contact they
    // can see. CampaignInfluence keeps all three as plain columns, which
    // linkRefusal cannot check; they were taken as sent, and the reply's
    // revenue gave away the value of any deal.
    const campaign = await prisma.campaign.findFirst({ where: await reachableWhere(req, 'campaigns', 'campaign', { id: String(campaignId) }, 'Edit'), select: { id: true } });
    if (!campaign) return res.status(404).json({ error: 'Not found' });
    const deal = permits(req, 'deals', 'read') && await prisma.deal.findFirst({ where: await reachableWhere(req, 'deals', 'deal', { id: String(dealId) }) });
    if (!deal) return res.status(400).json({ error: 'dealId does not name a deal you can see', code: 'LINK_NOT_VISIBLE' });
    const contact = !contactId || (permits(req, 'contacts', 'read') && await prisma.contact.findFirst({ where: await reachableWhere(req, 'contacts', 'contact', { id: String(contactId) }), select: { id: true } }));
    if (!contact) return res.status(400).json({ error: 'contactId does not name a contact you can see', code: 'LINK_NOT_VISIBLE' });
    const revenue = deal.value * (influence || 0) / 100;

    const ci = await prisma.campaignInfluence.upsert({
      where: { campaignId_dealId_model: { campaignId, dealId, model: model || 'FirstTouch' } },
      update: { influence, revenue, contactId, isPrimary },
      create: { campaignId, dealId, model: model || 'FirstTouch', influence: influence || 0, revenue, contactId, isPrimary: isPrimary || false, touchDate: touchDate ? new Date(touchDate) : new Date() },
    });
    res.json(ci);
  } catch (err) { next(err); }
});

// POST /campaign-influence/calculate/:dealId - Auto-calculate attribution
// On a deal the caller can see: any deal id was taken, and the reply's
// revenue gave away its value.
router.post('/calculate/:dealId', requirePermission('campaigns', 'edit'), requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { model = 'Linear' } = req.body;
    const deal = await prisma.deal.findFirst({ where: await reachableWhere(req, 'deals', 'deal', { id: String(req.params.dealId) }) });
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
// Campaigns and deals read, and only the deals and campaigns the caller can
// see: it summed every deal's value, by campaign name, for anyone signed in.
router.get('/attribution', authenticate, requirePermission('campaigns', 'read'), requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { model = 'linear', period = '90' } = req.query;
    const since = new Date(Date.now() - (+period) * 86400000);
    const influences = await readableInfluences(req, await queryWithIncludes(prisma, 'campaignInfluence', 'findMany', {
      where: { createdAt: { gte: since } },
      include: { campaign: { select: { name: true, type: true } }, deal: { select: { value: true, stage: true } } },
    }).catch(() => []));
    const byCampaign = {};
    influences.forEach(inf => {
      const key = inf.campaignId;
      if (!byCampaign[key]) byCampaign[key] = { campaignId: key, name: inf.campaign?.name, type: inf.campaign?.type, touches: 0, revenue: 0, deals: 0 };
      byCampaign[key].touches++;
      // The share is `influence`, a percentage; `influencePercentage` is no
      // column, so each touch was credited with the whole deal.
      if (inf.deal?.stage === 'Closed Won') { byCampaign[key].revenue += (inf.deal.value || 0) * inf.influence / 100; byCampaign[key].deals++; }
    });
    const report = Object.values(byCampaign).sort((a, b) => b.revenue - a.revenue);
    res.json({ model, period: +period, campaigns: report });
  } catch (err) { next(err); }
});

// ROI by campaign
// The campaigns the caller can see, credited only with deals they can see:
// every campaign's cost, and every deal's value, went to anyone signed in.
// A second /roi, registered after this one, never answered and is gone. It
// read the share as a percentage, which `influence` is, and that is kept.
router.get('/roi', authenticate, requirePermission('campaigns', 'read'), requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const campaigns = await prisma.campaign.findMany({ where: await reachableWhere(req, 'campaigns', 'campaign'), select: { id: true, name: true, budget: true, actualCost: true } });
    const influences = await readableInfluences(req, await queryWithIncludes(prisma, 'campaignInfluence', 'findMany', { where: { campaignId: { in: campaigns.map(c => c.id) } }, include: { deal: { select: { value: true, stage: true } } } }).catch(() => []));
    const result = [];
    for (const c of campaigns) {
      const influenced = influences.filter(i => i.campaignId === c.id);
      const revenue = influenced.filter(i => i.deal?.stage === 'Closed Won').reduce((s, i) => s + ((i.deal?.value || 0) * i.influence / 100), 0);
      const cost = c.actualCost || c.budget || 0;
      result.push({ campaignId: c.id, name: c.name, cost, attributedRevenue: revenue, roi: cost ? Math.round((revenue - cost) / cost * 100) : 0, deals: influenced.length });
    }
    result.sort((a, b) => b.roi - a.roi);
    res.json(result);
  } catch (err) { next(err); }
});

// Attribution model comparison
// On the deals and campaigns the caller can see, as /attribution.
router.get('/attribution-models', authenticate, requirePermission('campaigns', 'read'), requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const influences = await readableInfluences(req, await queryWithIncludes(prisma, 'campaignInfluence', 'findMany', { include: { campaign: { select: { name: true } }, deal: { select: { name: true, value: true, stage: true } } } }));
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
      // A touch's date is touchDate; there is no influenceDate.
      group.sort((a, b) => new Date(a.touchDate || a.createdAt) - new Date(b.touchDate || b.createdAt));
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
