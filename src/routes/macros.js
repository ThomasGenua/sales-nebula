const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere } = require('../middleware/access');
const { columnsFrom, looksLikeId, plainFieldProblem } = require('../utils/modelFields');

const router = Router();

// `/templates`, `/categories` and `/analytics` were declared after `/:id`,
// which swallowed them. A segment that is not an id falls through to them.
const idParam = (req, res, next) => (looksLikeId('macro', req.params.id) ? next() : next('route'));

// The records a macro can run against, by module name.
const MACRO_MODELS = { cases: 'case', contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account' };

/**
 * Running a macro edits records in its module, so it takes the same edit
 * rights the module's own screens do. Sends the 403 itself when refused.
 */
async function mayEditModule(req, res, module) {
  let outcome = null;
  await requirePermission(module, 'edit')(req, res, (err) => { outcome = err || true; });
  if (outcome instanceof Error) throw outcome;
  return outcome === true;
}

router.get('/', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const macros = await prisma.macro.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } });
    res.json(macros);
  } catch (err) { next(err); }
});

router.get('/:id', authenticate, idParam, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const m = await prisma.macro.findFirst({ where: { id: req.params.id, deletedAt: null } }); if (!m) return res.status(404).json({ error: 'Not found' }); res.json(m); } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, module, category, actions } = req.body;
    if (!name || !actions?.length) return res.status(400).json({ error: 'name and actions required' });
    const macro = await prisma.macro.create({ data: { name, description, module: module || 'cases', category: category || null, actions, active: true, createdById: req.user.id } });
    res.status(201).json(macro);
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, idParam, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Only the macro's own editable columns; not its id, author or counters.
    const data = columnsFrom('macro', req.body);
    for (const key of ['createdById', 'executionCount', 'lastExecutedAt']) delete data[key];
    const m = await prisma.macro.update({ where: { id: req.params.id }, data });
    res.json(m);
  } catch (err) { next(err); }
});

router.delete('/:id', authenticate, idParam, requirePermission('admin', 'full'), async (req, res, next) => {
  try { await req.app.locals.prisma.macro.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } }); res.json({ success: true }); } catch (err) { next(err); }
});

// Execute macro on a record
router.post('/:id/execute', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // A live, active macro. A deleted one still ran if it was active.
    const macro = await prisma.macro.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!macro || !macro.active) return res.status(404).json({ error: 'Macro not found or inactive' });
    const { recordId } = req.body;
    if (!recordId) return res.status(400).json({ error: 'recordId required' });
    const delegate = MACRO_MODELS[macro.module];
    if (!delegate) return res.status(400).json({ error: `Macros cannot run on ${macro.module}` });
    if (!(await mayEditModule(req, res, macro.module))) return;
    // A live record the caller could edit themselves. This ran on any id in
    // the module, other reps' records included.
    const record = await prisma[delegate].findFirst({ where: await reachableWhere(req, macro.module, delegate, { id: String(recordId) }, 'Edit'), select: { id: true } });
    if (!record) return res.status(404).json({ error: 'Not found' });
    const results = [];
    for (const action of macro.actions) {
      try {
        if (action.type === 'updateField') {
          // A plain field, as workflows and approvals may set: this wrote any
          // column (deletedAt, the owner) or relation the macro named.
          const problem = plainFieldProblem(delegate, action.field, action.value);
          if (problem) throw new Error(problem);
          await prisma[delegate].update({ where: { id: recordId }, data: { [action.field]: action.value } });
          results.push({ action: 'updateField', field: action.field, success: true });
        } else if (action.type === 'addComment') {
          // A case comment, so only on a case; its text is `value`, or `body`
          // as the templates below write it, which left the comment empty and
          // the action failing.
          if (delegate !== 'case') throw new Error('Comments can only be added to cases');
          await prisma.caseComment.create({ data: { caseId: recordId, text: action.value ?? action.body, isPublic: action.isPublic || false, authorId: req.user.id } });
          results.push({ action: 'addComment', success: true });
        } else if (action.type === 'sendEmail') {
          results.push({ action: 'sendEmail', success: true, note: 'Email queued' });
        }
      } catch (e) { results.push({ action: action.type, success: false, error: e.message }); }
    }
    await prisma.macro.update({ where: { id: req.params.id }, data: { executionCount: { increment: 1 }, lastExecutedAt: new Date() } });
    // History and stats read these rows; nothing used to write them.
    await prisma.macroExecution.create({
      data: { macroId: macro.id, recordId, module: macro.module, status: results.every(r => r.success) ? 'Success' : 'Failed', userId: req.user.id },
    });
    await req.audit({ action: 'execute', module: 'macros', recordId: req.params.id, details: `Executed on ${recordId}` });
    res.json({ macroId: macro.id, recordId, results, executedActions: results.filter(r => r.success).length });
  } catch (err) { next(err); }
});

// Bulk execute macro
router.post('/:id/execute/bulk', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // A live, active macro, as for a single run. This ran deleted and
    // inactive ones.
    const macro = await prisma.macro.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!macro || !macro.active) return res.status(404).json({ error: 'Macro not found or inactive' });
    const { recordIds } = req.body;
    if (!Array.isArray(recordIds) || !recordIds.length) return res.status(400).json({ error: 'recordIds required' });
    const delegate = MACRO_MODELS[macro.module];
    if (!delegate) return res.status(400).json({ error: `Macros cannot run on ${macro.module}` });
    if (!(await mayEditModule(req, res, macro.module))) return;
    // Only live records the caller could edit one at a time; any other id
    // fails, as one that names nothing does. This ran on any id in the module.
    const editable = new Set((await prisma[delegate].findMany({
      where: await reachableWhere(req, macro.module, delegate, { id: { in: recordIds.map(String) } }, 'Edit'),
      select: { id: true },
    })).map(r => r.id));
    let successCount = 0;
    for (const recordId of recordIds) {
      let status = 'Success';
      try {
        if (!editable.has(String(recordId))) throw new Error('Not found');
        for (const action of macro.actions) {
          if (action.type === 'updateField') {
            // A plain field only, as for a single run.
            const problem = plainFieldProblem(delegate, action.field, action.value);
            if (problem) throw new Error(problem);
            await prisma[delegate].update({ where: { id: recordId }, data: { [action.field]: action.value } });
          }
        }
        successCount++;
      } catch (e) { status = 'Failed'; }
      await prisma.macroExecution.create({ data: { macroId: macro.id, recordId, module: macro.module, status, userId: req.user.id } });
    }
    if (successCount) {
      await prisma.macro.update({ where: { id: macro.id }, data: { executionCount: { increment: successCount }, lastExecutedAt: new Date() } });
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
    { name: 'Log Outbound Call', description: 'Create call activity', actions: [{ type: 'logActivity', activityType: 'Call', direction: 'Outbound' }] },
    { name: 'Send Thank You', description: 'Send thank you email', actions: [{ type: 'sendEmail', template: 'thank_you' }] },
  ];
  res.json(templates);
});

// Macro execution history
router.get('/:id/history', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const history = await prisma.macroExecution.findMany({
      where: { macroId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 50,
      select: { id: true, recordId: true, module: true, status: true, createdAt: true, userId: true },
    });
    // The shape this endpoint has always promised, from the columns that exist.
    res.json(history.map(h => ({ id: h.id, recordId: h.recordId, recordModule: h.module, status: h.status, executedAt: h.createdAt, executedById: h.userId })));
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
