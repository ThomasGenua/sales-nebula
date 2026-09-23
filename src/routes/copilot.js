const { Router } = require('express');
const { authenticate, permits } = require('../middleware/auth');
const { canReach } = require('../middleware/access');
const { crudModelFor } = require('../utils/crud');
const { complete, isConfigured, AiError } = require('../services/claude');
// The tighter limit meant for model calls was defined and attached to nothing.
const { limiters } = require('../middleware/rateLimit');

const router = Router();

// The module each action writes, whose edit permission it takes. These ran for
// anyone signed in, and update_deal_stage moved any deal by id.
const ACTION_MODULES = { create_task: 'activities', log_call: 'activities', update_deal_stage: 'deals' };

// Ask copilot
router.post('/ask', authenticate, limiters.ai, async (req, res, next) => {
  try {
    const { question, context } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });
    const prisma = req.app.locals.prisma;
    // Gather context if not provided
    let enrichedContext = context || {};
    if (!context) {
      const [dealCount, openCases, activities] = await Promise.all([
        prisma.deal.count({ where: { ownerId: req.user.id, stage: { not: 'Closed Won' }, deletedAt: null } }),
        prisma.case.count({ where: { ownerId: req.user.id, status: { not: 'Closed' }, deletedAt: null } }),
        prisma.activity.count({ where: { ownerId: req.user.id, createdAt: { gte: new Date(Date.now() - 7 * 86400000) } } }),
      ]);
      enrichedContext = { openDeals: dealCount, openCases, weeklyActivities: activities };
    }
    // With a key configured, ask the model. If it cannot answer (outage,
    // rate limit, refusal) the rule-based reply below still helps.
    if (isConfigured()) {
      try {
        const { text } = await complete({
          system: `You are a CRM copilot assistant. User context: ${JSON.stringify(enrichedContext)}. Be concise and actionable.`,
          messages: [{ role: 'user', content: question }],
        });
        if (text) return res.json({ answer: text, context: enrichedContext, model: 'ai' });
      } catch (e) {
        if (!(e instanceof AiError)) throw e;
      }
    }
    // Rule-based fallback
    const lowerQ = question.toLowerCase();
    let answer = 'I can help you with deal management, case tracking, reporting, and more. Could you be more specific?';
    if (lowerQ.includes('deal') || lowerQ.includes('pipeline')) answer = `You have ${enrichedContext.openDeals || 0} open deals in your pipeline. Focus on deals closest to their close date.`;
    else if (lowerQ.includes('case') || lowerQ.includes('support')) answer = `You have ${enrichedContext.openCases || 0} open cases. Prioritize high-severity cases first.`;
    else if (lowerQ.includes('activity') || lowerQ.includes('task')) answer = `You logged ${enrichedContext.weeklyActivities || 0} activities this week. Keep up your engagement!`;
    res.json({ answer, context: enrichedContext, model: 'rule-based' });
  } catch (err) { next(err); }
});

// Chat (conversational with history)
router.post('/chat', authenticate, limiters.ai, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { message, threadId } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    // Create or continue thread
    let thread;
    if (threadId) {
      thread = await prisma.copilotThread.findUnique({ where: { id: threadId } });
      // Another user's thread reads as missing, as it does in GET /threads/:id.
      if (!thread || thread.userId !== req.user.id) return res.status(404).json({ error: 'Thread not found' });
    } else {
      thread = await prisma.copilotThread.create({ data: { userId: req.user.id, title: message.substring(0, 100) } });
    }
    // Save user message
    await prisma.copilotMessage.create({ data: { threadId: thread.id, role: 'user', content: message } });
    // This used to answer every message with the same canned sentence,
    // claiming to use CRM data it never read. It now sends the thread to the
    // model, or says plainly that no model is configured.
    const history = await prisma.copilotMessage.findMany({ where: { threadId: thread.id }, orderBy: { createdAt: 'asc' }, take: 50 });
    const { text } = await complete({
      system: 'You are a CRM copilot assistant. Be concise and actionable.',
      messages: history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    });
    await prisma.copilotMessage.create({ data: { threadId: thread.id, role: 'assistant', content: text } });
    res.json({ threadId: thread.id, response: text });
  } catch (err) { next(err); }
});

// List threads
router.get('/threads', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const threads = await prisma.copilotThread.findMany({
      where: { userId: req.user.id }, orderBy: { updatedAt: 'desc' }, take: 50,
      include: { _count: { select: { messages: true } } },
    });
    res.json(threads);
  } catch (err) { next(err); }
});

// Get thread messages
router.get('/threads/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const thread = await prisma.copilotThread.findUnique({
      where: { id: req.params.id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!thread || thread.userId !== req.user.id) return res.status(404).json({ error: 'Thread not found' });
    res.json(thread);
  } catch (err) { next(err); }
});

router.delete('/threads/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Any user could delete anyone's thread by id.
    const thread = await prisma.copilotThread.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!thread || thread.userId !== req.user.id) return res.status(404).json({ error: 'Thread not found' });
    await prisma.copilotMessage.deleteMany({ where: { threadId: req.params.id } });
    await prisma.copilotThread.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Execute action (copilot can trigger CRM actions)
router.post('/actions', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { action, params } = req.body;
    if (!action) return res.status(400).json({ error: 'action required' });
    const actions = {
      'create_task': async () => {
        const task = await prisma.activity.create({ data: { type: 'Task', subject: params.subject || 'New Task', status: 'Open', ownerId: req.user.id, dueDate: params.dueDate ? new Date(params.dueDate) : null } });
        return { message: 'Task created', task };
      },
      'log_call': async () => {
        const call = await prisma.activity.create({ data: { type: 'Call', subject: params.subject || 'Phone Call', status: 'Completed', ownerId: req.user.id, duration: params.duration || 0, description: params.notes } });
        return { message: 'Call logged', activity: call };
      },
      'update_deal_stage': async () => {
        if (!params.dealId || !params.stage) return { error: 'dealId and stage required' };
        const deal = await prisma.deal.update({ where: { id: params.dealId }, data: { stage: params.stage } });
        return { message: `Deal moved to ${params.stage}`, deal };
      },
    };
    const handler = actions[action];
    if (!handler) return res.status(400).json({ error: `Unknown action. Available: ${Object.keys(actions).join(', ')}` });
    const module = ACTION_MODULES[action];
    if (!permits(req, module, 'edit')) return res.status(403).json({ error: `Insufficient permissions for ${module}` });
    // A deal the caller may change, as the deals router would require.
    if (action === 'update_deal_stage' && params?.dealId && !(await canReach(req, 'deals', 'deal', params.dealId, 'Edit'))) {
      return res.status(404).json({ error: 'Deal not found' });
    }
    const result = await handler();
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;

// Record insights
// Read any record by id for anyone signed in; now one the caller may read.
router.get('/insights/:module/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, id } = req.params;
    const modelName = crudModelFor(module);
    if (!modelName) return res.status(400).json({ error: `No insights for ${module}` });
    if (!permits(req, module, 'read')) return res.status(403).json({ error: `Insufficient permissions for ${module}` });
    if (!(await canReach(req, module, modelName, id))) return res.status(404).json({ error: 'Not found' });
    const insights = [];
    if (module === 'deals') {
      const deal = await prisma.deal.findUnique({ where: { id }, include: { account: true } });
      if (deal) {
        if (deal.probability < 30) insights.push({ type: 'warning', text: 'Low win probability. Consider adding more stakeholders.' });
        if (deal.closeDate && new Date(deal.closeDate) < new Date()) insights.push({ type: 'alert', text: 'Close date has passed. Update the timeline or close the deal.' });
        const activities = await prisma.activity.count({ where: { dealId: id, createdAt: { gte: new Date(Date.now() - 14 * 86400000) } } });
        if (activities === 0) insights.push({ type: 'warning', text: 'No activities in 14 days. This deal may be stalling.' });
        const contacts = await prisma.dealContactRole.count({ where: { dealId: id } }).catch(() => 0);
        if (contacts < 2) insights.push({ type: 'tip', text: 'Add more contact roles to improve deal visibility.' });
      }
    } else if (module === 'accounts') {
      const casesOpen = await prisma.case.count({ where: { accountId: id, status: { not: 'Closed' }, deletedAt: null } });
      if (casesOpen > 3) insights.push({ type: 'alert', text: `${casesOpen} open cases. Customer satisfaction may be at risk.` });
      const lastActivity = await prisma.activity.findFirst({ where: { accountId: id }, orderBy: { createdAt: 'desc' } });
      if (!lastActivity || new Date(lastActivity.createdAt) < new Date(Date.now() - 30 * 86400000)) {
        insights.push({ type: 'warning', text: 'No recent engagement. Schedule a check-in.' });
      }
    } else if (module === 'contacts') {
      const contact = await prisma.contact.findUnique({ where: { id } });
      if (contact && !contact.phone && !contact.mobilePhone) insights.push({ type: 'tip', text: 'No phone number on file. Add one for faster outreach.' });
    }
    res.json({ module, recordId: id, insights, generatedAt: new Date() });
  } catch (err) { next(err); }
});

// Suggested next actions
router.get('/suggestions', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const userId = req.user.id;
    const suggestions = [];
    const overdueTasks = await prisma.activity.count({ where: { ownerId: userId, status: { in: ['Open', 'InProgress'] }, dueDate: { lt: new Date() }, deletedAt: null } });
    if (overdueTasks > 0) suggestions.push({ priority: 'high', action: 'Complete overdue tasks', details: `${overdueTasks} tasks are past due`, link: '/activities' });
    const stalledDeals = await prisma.deal.findMany({ where: { ownerId: userId, stage: { notIn: ['Closed Won', 'Closed Lost'] }, updatedAt: { lt: new Date(Date.now() - 7 * 86400000) }, deletedAt: null }, take: 5 });
    stalledDeals.forEach(d => suggestions.push({ priority: 'medium', action: `Follow up on "${d.name}"`, details: `No updates in ${Math.floor((Date.now() - new Date(d.updatedAt)) / 86400000)} days`, link: `/deals/${d.id}` }));
    // Approvers are named on the steps, not on the request.
    const pendingApprovals = await prisma.approvalStep.count({ where: { approverId: userId, status: 'Pending', request: { status: 'Pending' } } });
    if (pendingApprovals > 0) suggestions.push({ priority: 'high', action: 'Review pending approvals', details: `${pendingApprovals} awaiting your approval`, link: '/approvals' });
    const newLeads = await prisma.lead.count({ where: { ownerId: userId, status: 'New', deletedAt: null } });
    if (newLeads > 0) suggestions.push({ priority: 'medium', action: 'Qualify new leads', details: `${newLeads} uncontacted leads`, link: '/leads' });
    res.json({ suggestions: suggestions.sort((a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1)) });
  } catch (err) { next(err); }
});
