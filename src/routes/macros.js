const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();

router.get('/', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const macros = await prisma.macro.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } });
    res.json(macros);
  } catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const m = await prisma.macro.findUnique({ where: { id: req.params.id } }); if (!m) return res.status(404).json({ error: 'Not found' }); res.json(m); } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, module, actions } = req.body;
    if (!name || !actions?.length) return res.status(400).json({ error: 'name and actions required' });
    const macro = await prisma.macro.create({ data: { name, description, module: module || 'cases', actions, active: true, createdById: req.user.id } });
    res.status(201).json(macro);
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const m = await prisma.macro.update({ where: { id: req.params.id }, data: req.body }); res.json(m); } catch (err) { next(err); }
});

router.delete('/:id', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try { await req.app.locals.prisma.macro.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } }); res.json({ success: true }); } catch (err) { next(err); }
});

// Execute macro on a record
router.post('/:id/execute', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const macro = await prisma.macro.findUnique({ where: { id: req.params.id } });
    if (!macro || !macro.active) return res.status(404).json({ error: 'Macro not found or inactive' });
    const { recordId } = req.body;
    if (!recordId) return res.status(400).json({ error: 'recordId required' });
    const results = [];
    for (const action of macro.actions) {
      try {
        if (action.type === 'updateField') {
          await prisma[macro.module === 'cases' ? 'case' : macro.module].update({ where: { id: recordId }, data: { [action.field]: action.value } });
          results.push({ action: 'updateField', field: action.field, success: true });
        } else if (action.type === 'addComment') {
          await prisma.caseComment.create({ data: { caseId: recordId, text: action.value, isPublic: action.isPublic || false, authorId: req.user.id } });
          results.push({ action: 'addComment', success: true });
        } else if (action.type === 'sendEmail') {
          results.push({ action: 'sendEmail', success: true, note: 'Email queued' });
        }
      } catch (e) { results.push({ action: action.type, success: false, error: e.message }); }
    }
    await prisma.macro.update({ where: { id: req.params.id }, data: { executionCount: { increment: 1 }, lastExecutedAt: new Date() } });
    await req.audit({ action: 'execute', module: 'macros', recordId: req.params.id, details: `Executed on ${recordId}` });
    res.json({ macroId: macro.id, recordId, results, executedActions: results.filter(r => r.success).length });
  } catch (err) { next(err); }
});

// Bulk execute macro
router.post('/:id/execute/bulk', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const macro = await prisma.macro.findUnique({ where: { id: req.params.id } });
    if (!macro) return res.status(404).json({ error: 'Macro not found' });
    const { recordIds } = req.body;
    if (!recordIds?.length) return res.status(400).json({ error: 'recordIds required' });
    let successCount = 0;
    for (const recordId of recordIds) {
      try {
        for (const action of macro.actions) {
          if (action.type === 'updateField') {
            await prisma[macro.module === 'cases' ? 'case' : macro.module].update({ where: { id: recordId }, data: { [action.field]: action.value } });
          }
        }
        successCount++;
      } catch (e) { /* skip failed records */ }
    }
    res.json({ macroId: macro.id, totalRecords: recordIds.length, successCount, failedCount: recordIds.length - successCount });
  } catch (err) { next(err); }
});

module.exports = router;

// Macro templates (pre-built macros)
router.get('/templates', authenticate, async (req, res, next) => {
  const templates = [
    { name: 'Close Case', description: 'Set case status to Closed and add comment', actions: [{ type: 'updateField', field: 'status', value: 'Closed' }, { type: 'addComment', body: 'Case resolved and closed.' }] },
    { name: 'Escalate Case', description: 'Set priority to Critical and reassign', actions: [{ type: 'updateField', field: 'priority', value: 'Critical' }, { type: 'updateField', field: 'status', value: 'Escalated' }] },
    { name: 'Follow Up Reminder', description: 'Create a follow-up task', actions: [{ type: 'createTask', subject: 'Follow up', dueInDays: 3 }] },
    { name: 'Log Outbound Call', description: 'Create call activity', actions: [{ type: 'logActivity', type: 'Call', direction: 'Outbound' }] },
    { name: 'Send Thank You', description: 'Send thank you email', actions: [{ type: 'sendEmail', template: 'thank_you' }] },
  ];
  res.json(templates);
});

// Macro execution history
router.get('/:id/history', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const history = await prisma.macroExecution.findMany({
      where: { macroId: req.params.id }, orderBy: { executedAt: 'desc' }, take: 50,
      select: { id: true, recordId: true, recordModule: true, status: true, executedAt: true, executedById: true, error: true },
    });
    res.json(history);
  } catch (err) { next(err); }
});

// Macro scheduling
router.post('/:id/schedule', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { schedule, targetQuery, module } = req.body;
    if (!schedule || !module) return res.status(400).json({ error: 'schedule and module required' });
    const macro = await prisma.macro.update({ where: { id: req.params.id }, data: { scheduled: true, scheduleCron: schedule, scheduleTargetQuery: targetQuery, scheduleModule: module } });
    res.json({ macroId: macro.id, scheduled: true, schedule, message: 'Macro scheduled' });
  } catch (err) { next(err); }
});

// Macro categories
router.get('/categories', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const macros = await prisma.macro.findMany({ where: { deletedAt: null }, select: { category: true } });
    const cats = [...new Set(macros.map(m => m.category).filter(Boolean))];
    res.json(cats.length ? cats : ['General', 'Sales', 'Service', 'Marketing', 'Admin']);
  } catch (err) { next(err); }
});

// Macro stats
router.get('/:id/stats', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [total, success, failed] = await Promise.all([
      prisma.macroExecution.count({ where: { macroId: req.params.id } }),
      prisma.macroExecution.count({ where: { macroId: req.params.id, status: 'Success' } }),
      prisma.macroExecution.count({ where: { macroId: req.params.id, status: 'Failed' } }),
    ]);
    res.json({ macroId: req.params.id, totalExecutions: total, successful: success, failed, successRate: total ? Math.round(success / total * 100) : 0 });
  } catch (err) { next(err); }
});

// Macro usage analytics
router.get('/analytics', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const macros = await prisma.macro.findMany({ where: { deletedAt: null }, select: { id: true, name: true, module: true, executionCount: true } });
    const sorted = macros.sort((a, b) => (b.executionCount || 0) - (a.executionCount || 0));
    const totalExecutions = macros.reduce((s, m) => s + (m.executionCount || 0), 0);
    res.json({ totalMacros: macros.length, totalExecutions, topMacros: sorted.slice(0, 10), byModule: macros.reduce((acc, m) => { acc[m.module] = (acc[m.module] || 0) + 1; return acc; }, {}) });
  } catch (err) { next(err); }
});
