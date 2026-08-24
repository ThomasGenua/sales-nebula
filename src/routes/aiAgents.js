const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();

router.get('/', authenticate, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const agents = await prisma.aiAgent.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } }); res.json(agents); } catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const a = await prisma.aiAgent.findUnique({ where: { id: req.params.id } }); if (!a) return res.status(404).json({ error: 'Not found' }); res.json(a); } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, type, description, systemPrompt, tools, config } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name and type required' });
    const agent = await prisma.aiAgent.create({
      data: { name, type, description, systemPrompt, tools: tools || [], config: config || {}, active: false, createdById: req.user.id },
    });
    res.status(201).json(agent);
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const a = await prisma.aiAgent.update({ where: { id: req.params.id }, data: req.body }); res.json(a); } catch (err) { next(err); }
});

router.delete('/:id', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try { await req.app.locals.prisma.aiAgent.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } }); res.json({ success: true }); } catch (err) { next(err); }
});

// Activate / deactivate
router.post('/:id/activate', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const a = await prisma.aiAgent.update({ where: { id: req.params.id }, data: { active: true } }); res.json(a); } catch (err) { next(err); }
});

router.post('/:id/deactivate', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const a = await prisma.aiAgent.update({ where: { id: req.params.id }, data: { active: false } }); res.json(a); } catch (err) { next(err); }
});

// Run agent
router.post('/:id/run', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const agent = await prisma.aiAgent.findUnique({ where: { id: req.params.id } });
    if (!agent || !agent.active) return res.status(400).json({ error: 'Agent not found or inactive' });
    const { input, context } = req.body;
    const run = await prisma.aiAgentRun.create({
      data: { agentId: req.params.id, input: input || {}, context: context || {}, status: 'Running', startedAt: new Date(), triggeredById: req.user.id },
    });
    // Execute agent logic based on type
    let output = {};
    if (agent.type === 'SDR') {
      const leads = await prisma.lead.findMany({ where: { status: 'New', deletedAt: null }, take: 10, orderBy: { score: 'desc' } });
      output = { action: 'lead_prioritization', leads: leads.map(l => ({ id: l.id, name: `${l.firstName} ${l.lastName}`, score: l.score })), recommendation: `Found ${leads.length} new leads to prioritize` };
    } else if (agent.type === 'DealCoach') {
      const deals = await prisma.deal.findMany({ where: { ownerId: req.user.id, stage: { notIn: ['Closed Won', 'Closed Lost'] }, deletedAt: null }, take: 5, orderBy: { value: 'desc' } });
      output = { action: 'deal_coaching', deals: deals.map(d => ({ id: d.id, name: d.name, stage: d.stage, value: d.value })), recommendation: 'Focus on highest-value deals first' };
    } else if (agent.type === 'ServiceAgent') {
      const cases = await prisma.case.findMany({ where: { status: { in: ['New', 'Open'] }, deletedAt: null }, take: 10, orderBy: { priority: 'asc' } });
      output = { action: 'case_triage', cases: cases.map(c => ({ id: c.id, subject: c.subject, priority: c.priority })), recommendation: `${cases.length} cases need attention` };
    } else {
      output = { action: 'generic', message: 'Agent execution completed' };
    }
    await prisma.aiAgentRun.update({ where: { id: run.id }, data: { status: 'Completed', completedAt: new Date(), output } });
    await prisma.aiAgent.update({ where: { id: req.params.id }, data: { runCount: { increment: 1 }, lastRunAt: new Date() } });
    res.json({ runId: run.id, agentId: agent.id, output });
  } catch (err) { next(err); }
});

// Run history
router.get('/:id/runs', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const runs = await prisma.aiAgentRun.findMany({
      where: { agentId: req.params.id }, orderBy: { startedAt: 'desc' }, take: 50,
      select: { id: true, status: true, startedAt: true, completedAt: true, output: true },
    });
    res.json(runs);
  } catch (err) { next(err); }
});

// Agent performance metrics
router.get('/:id/metrics', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const agent = await prisma.aiAgent.findUnique({ where: { id: req.params.id } });
    if (!agent) return res.status(404).json({ error: 'Not found' });
    const runs = await prisma.aiAgentRun.findMany({ where: { agentId: req.params.id } });
    const completed = runs.filter(r => r.status === 'Completed');
    const avgDuration = completed.length ? completed.reduce((s, r) => s + (new Date(r.completedAt) - new Date(r.startedAt)), 0) / completed.length : 0;
    res.json({
      agentId: agent.id, name: agent.name, type: agent.type,
      totalRuns: runs.length, completedRuns: completed.length,
      failedRuns: runs.filter(r => r.status === 'Failed').length,
      successRate: runs.length ? ((completed.length / runs.length) * 100).toFixed(1) : 0,
      avgDurationMs: Math.round(avgDuration), lastRun: agent.lastRunAt,
    });
  } catch (err) { next(err); }
});

module.exports = router;

// Agent conversations
router.get('/:id/conversations', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const conversations = await prisma.aiAgentConversation.findMany({
      where: { agentId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 20,
    }).catch(() => []);
    res.json(conversations);
  } catch (err) { next(err); }
});

// Agent training data
router.get('/:id/training', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const agent = await prisma.aiAgent.findUnique({ where: { id: req.params.id } });
    if (!agent) return res.status(404).json({ error: 'Not found' });
    res.json({ agentId: agent.id, type: agent.type, trainingData: agent.trainingData || [], lastTrained: agent.lastTrainedAt, examples: agent.examples || [] });
  } catch (err) { next(err); }
});

router.put('/:id/training', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { trainingData, examples } = req.body;
    const updated = await prisma.aiAgent.update({ where: { id: req.params.id }, data: { trainingData, examples, lastTrainedAt: new Date() } });
    res.json(updated);
  } catch (err) { next(err); }
});

// Agent analytics
router.get('/:id/analytics', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { period = '30' } = req.query;
    const since = new Date(Date.now() - (+period) * 86400000);
    const runs = await prisma.aiAgentRun.findMany({ where: { agentId: req.params.id, createdAt: { gte: since } } }).catch(() => []);
    const successful = runs.filter(r => r.status === 'success');
    const avgDuration = runs.length ? Math.round(runs.reduce((s, r) => s + (r.duration || 0), 0) / runs.length) : 0;
    res.json({ period: +period, totalRuns: runs.length, successRate: runs.length ? Math.round(successful.length / runs.length * 100) : 0, avgDurationMs: avgDuration, runsPerDay: Math.round(runs.length / +period * 10) / 10 });
  } catch (err) { next(err); }
});

// Agent templates
router.get('/templates', authenticate, async (req, res, next) => {
  res.json([
    { type: 'SDR', name: 'Sales Development', description: 'Prioritize leads, draft outreach, qualify prospects', defaultConfig: { model: 'gpt-4', maxTokens: 1000 } },
    { type: 'DealCoach', name: 'Deal Coach', description: 'Analyze deals, suggest next steps, identify risks', defaultConfig: { model: 'gpt-4', maxTokens: 2000 } },
    { type: 'ServiceAgent', name: 'Service Agent', description: 'Triage cases, suggest solutions, draft responses', defaultConfig: { model: 'gpt-4', maxTokens: 1500 } },
  ]);
});
