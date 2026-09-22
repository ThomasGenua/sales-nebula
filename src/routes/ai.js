const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { buildAccessFilter, applyAccessFilter } = require('../middleware/rowSecurity');
const { complete, aiModel, isConfigured } = require('../services/claude');
const { limiters } = require('../middleware/rateLimit');
const { currencyContext } = require('../utils/currency');

const router = Router();
router.use(authenticate);

/** Deals the caller may read, live ones only, merged into `where`. */
async function visibleDeals(req, where = {}) {
  const prisma = req.app.locals.prisma;
  const filter = await buildAccessFilter(prisma, req.user, 'deals', { modelName: 'deal' });
  return applyAccessFilter({ ...where, deletedAt: null }, filter);
}

// POST /api/ai/chat - General AI with CRM context
router.post('/chat', limiters.ai, async (req, res, next) => {
  try {
    const { systemPrompt, userPrompt, context } = req.body;
    if (!userPrompt?.trim()) return res.status(400).json({ error: 'userPrompt required' });
    // `context` was accepted and then dropped; it now reaches the model.
    const content = context ? `${userPrompt}\n\nContext:\n${typeof context === 'string' ? context : JSON.stringify(context)}` : userPrompt;
    const { text, truncated } = await complete({ system: systemPrompt, messages: [{ role: 'user', content }] });
    res.json({ response: text, truncated });
  } catch (err) { next(err); }
});

// POST /api/ai/deal-coach
// Sent a deal's account, contact, activities and emails to the model for any
// signed-in user, whatever the deal's sharing; now only for deals they can read.
router.post('/deal-coach', limiters.ai, requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { dealId } = req.body;
    if (!dealId) return res.status(400).json({ error: 'dealId required' });

    const deal = await prisma.deal.findFirst({
      where: await visibleDeals(req, { id: dealId }),
      include: {
        account: true,
        contact: true,
        activities: { where: { deletedAt: null }, take: 5, orderBy: { date: 'desc' } },
        emails: { take: 3, orderBy: { createdAt: 'desc' } },
        cases: { where: { status: { not: 'Closed' }, deletedAt: null } },
      },
    });
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const context = `Deal: ${deal.name}\nStage: ${deal.stage}\nValue: $${deal.value}\nProbability: ${deal.probability}%\nClose Date: ${deal.closeDate || 'TBD'}\nAccount: ${deal.account?.name || '-'} (${deal.account?.industry || '-'})\nContact: ${deal.contact ? `${deal.contact.firstName} ${deal.contact.lastName}` : '-'}\nRecent Activities: ${deal.activities.map(a => `${a.type}: ${a.subject} [${a.status}]`).join('; ')}\nEmails: ${deal.emails.map(e => `${e.subject} [${e.opened ? 'Opened' : 'Unopened'}]`).join('; ')}\nOpen Cases: ${deal.cases.length}`;

    const { text, truncated } = await complete({
      system: 'You are an expert B2B sales coach. Analyze the deal and provide: 1) Health assessment, 2) Top 3 next actions, 3) Key risks, 4) Talking points. Be specific.',
      messages: [{ role: 'user', content: context }],
    });
    res.json({ response: text, truncated });
  } catch (err) { next(err); }
});

// POST /api/ai/pipeline-forecast
// Forecasts over the deals the caller can see. It used to send every deal,
// deleted ones included, to the model for anyone who asked.
router.post('/pipeline-forecast', limiters.ai, requirePermission('deals', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const deals = await prisma.deal.findMany({ where: await visibleDeals(req), include: { account: true } });
    // One currency for the model to reason in: the default.
    const ctx = await currencyContext(prisma);
    deals.forEach(d => { d.value = Math.round(ctx.toBase(d.value, d.currency)); });
    const open = deals.filter(d => d.stage !== 'Closed Won' && d.stage !== 'Closed Lost');
    const won = deals.filter(d => d.stage === 'Closed Won');
    const lost = deals.filter(d => d.stage === 'Closed Lost');

    const context = `Pipeline (amounts in ${ctx.base}):\nOpen: ${open.length} deals, ${open.reduce((s, d) => s + d.value, 0)}\nWon: ${won.length}, ${won.reduce((s, d) => s + d.value, 0)}\nLost: ${lost.length}\nWin Rate: ${(won.length + lost.length) > 0 ? Math.round(won.length / (won.length + lost.length) * 100) : 0}%\n\nDeals:\n${open.map(d => `${d.name}: ${d.value} [${d.stage}] ${d.probability}% close ${d.closeDate || 'TBD'}`).join('\n')}`;

    const { text, truncated } = await complete({
      system: 'You are a sales forecasting analyst. Provide: 1) 90-day forecast (conservative/expected/optimistic), 2) Stage conversion analysis, 3) Deals likely to close, 4) At-risk deals, 5) Recommendations.',
      messages: [{ role: 'user', content: context }],
    });
    res.json({ response: text, truncated });
  } catch (err) { next(err); }
});

module.exports = router;

// Prediction history
router.get('/predictions/history', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, limit = 20 } = req.query;
    const where = {};
    if (module) where.module = module;
    const predictions = await prisma.aiPrediction.findMany({ where, orderBy: { createdAt: 'desc' }, take: +limit }).catch(() => []);
    res.json(predictions);
  } catch (err) { next(err); }
});

// Batch lead scoring
router.post('/leads/batch-score', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { leadIds } = req.body;
    const where = leadIds?.length ? { id: { in: leadIds }, deletedAt: null } : { deletedAt: null, score: null };
    const leads = await prisma.lead.findMany({ where, take: 100 });
    const results = [];
    for (const lead of leads) {
      let score = 50;
      if (lead.email?.includes('.com')) score += 10;
      if (lead.company) score += 15;
      if (lead.phone) score += 10;
      if (lead.title?.match(/CEO|CTO|VP|Director|Head/i)) score += 20;
      if (lead.source === 'Referral') score += 15;
      score = Math.min(score, 100);
      await prisma.lead.update({ where: { id: lead.id }, data: { score } });
      results.push({ id: lead.id, score });
    }
    res.json({ scored: results.length, results });
  } catch (err) { next(err); }
});

// AI model config
router.get('/config', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  res.json({
    models: { leadScoring: { type: 'rule-based', version: '2.0', features: ['email','company','title','phone','source'] }, dealPrediction: { type: 'rule-based', version: '1.5', features: ['value','stage','age','activities'] }, caseClassification: { type: 'keyword', version: '1.0' } },
    settings: { autoScore: true, scoreThreshold: 70, predictionConfidenceMin: 0.6 },
    // The model behind the chat, deal-coach, forecast and copilot endpoints.
    generative: { provider: 'anthropic', model: aiModel(), configured: isConfigured() },
  });
});

// Deal win probability
router.post('/deals/predict', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { dealId } = req.body;
    const deal = await prisma.deal.findUnique({ where: { id: dealId }, include: { activities: { where: { deletedAt: null } } } });
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    const stageWeights = { Qualification: 10, Discovery: 25, Proposal: 50, Negotiation: 75, 'Closed Won': 100, 'Closed Lost': 0 };
    let probability = stageWeights[deal.stage] || 20;
    if (deal.activities?.length > 5) probability = Math.min(probability + 10, 95);
    if (deal.value > 100000) probability = Math.max(probability - 5, 5);
    const daysOpen = deal.createdAt ? Math.floor((Date.now() - new Date(deal.createdAt)) / 86400000) : 0;
    if (daysOpen > 90) probability = Math.max(probability - 15, 5);
    res.json({ dealId, probability, confidence: 0.72, factors: { stage: deal.stage, activityCount: deal.activities?.length || 0, daysOpen, value: deal.value } });
  } catch (err) { next(err); }
});
