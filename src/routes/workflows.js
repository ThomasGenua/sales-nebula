const { Router } = require('express');
const { runWorkflows, resolveModel, workflowProblem } = require('../services/workflowEngine');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { visibleWhere } = require('../middleware/rowSecurity');

/**
 * The fields a workflow is saved with. The body went to Prisma whole, so it
 * could set run counts or write logs, and actions were never looked at.
 */
function workflowFields(body) {
  const b = body || {};
  const data = {};
  for (const key of ['name', 'description', 'module', 'trigger']) {
    if (b[key] !== undefined) data[key] = b[key] === null ? null : String(b[key]);
  }
  for (const key of ['conditions', 'actions']) {
    if (b[key] !== undefined) data[key] = b[key];
  }
  if (b.active !== undefined) data.active = !!b.active;
  return data;
}

const router = Router();
router.use(authenticate, auditMiddleware);

// LIST
router.get('/', requirePermission('workflows', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const workflows = await prisma.workflow.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ data: workflows });
  } catch (err) { next(err); }
});

// GET ONE with logs
router.get('/:id', requirePermission('workflows', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const workflow = await prisma.workflow.findUnique({
      where: { id: req.params.id },
      include: { logs: { orderBy: { createdAt: 'desc' }, take: 50 } },
    });
    if (!workflow) return res.status(404).json({ error: 'Not found' });
    res.json(workflow);
  } catch (err) { next(err); }
});

// CREATE
router.post('/', requirePermission('workflows', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const data = workflowFields(req.body);
    if (!data.name || !data.module || !data.trigger) return res.status(400).json({ error: 'name, module and trigger are required' });
    const problem = workflowProblem(data);
    if (problem) return res.status(400).json({ error: problem });
    const workflow = await prisma.workflow.create({ data });
    await req.audit({ action: 'create', module: 'workflows', recordId: workflow.id });
    res.status(201).json(workflow);
  } catch (err) { next(err); }
});

// UPDATE
router.put('/:id', requirePermission('workflows', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const current = await prisma.workflow.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ error: 'Not found' });
    const data = workflowFields(req.body);
    const problem = workflowProblem({ ...current, ...data });
    if (problem) return res.status(400).json({ error: problem });
    const workflow = await prisma.workflow.update({ where: { id: req.params.id }, data });
    res.json(workflow);
  } catch (err) { next(err); }
});

// TOGGLE active
router.post('/:id/toggle', requirePermission('workflows', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const wf = await prisma.workflow.findUnique({ where: { id: req.params.id } });
    const updated = await prisma.workflow.update({ where: { id: req.params.id }, data: { active: !wf.active } });
    res.json(updated);
  } catch (err) { next(err); }
});

// DUPLICATE
router.post('/:id/duplicate', requirePermission('workflows', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const wf = await prisma.workflow.findUnique({ where: { id: req.params.id } });
    if (!wf) return res.status(404).json({ error: 'Not found' });
    const { id, createdAt, updatedAt, runCount, ...data } = wf;
    const copy = await prisma.workflow.create({ data: { ...data, name: `${data.name} (Copy)`, runCount: 0 } });
    res.status(201).json(copy);
  } catch (err) { next(err); }
});

// DELETE
router.delete('/:id', requirePermission('workflows', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.workflow.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET LOGS
router.get('/logs/all', requirePermission('workflows', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const logs = await prisma.workflowLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    res.json({ data: logs });
  } catch (err) { next(err); }
});

// POST /api/workflows/execute - Run matching workflows for a trigger event
/**
 * Run the rules for a record on demand.
 *
 * The engine used to live inline here and this was its only caller — which
 * nothing called. It now shares src/services/workflowEngine.js with the write
 * paths and the scheduler, so a rule behaves the same however it is reached.
 */
router.post('/execute', requirePermission('workflows', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, trigger, record: given, oldRecord } = req.body || {};
    if (!module || !trigger || !given?.id) {
      return res.status(400).json({ error: 'module, trigger and record.id are required' });
    }
    // The record as stored, and only one the caller can see. Anyone signed
    // in could run every rule against a record they described themselves:
    // any id, with whatever fields made the conditions match.
    const modelName = resolveModel(module);
    const record = modelName && await prisma[modelName].findFirst({
      where: await visibleWhere(req, String(module), modelName, { id: String(given.id) }),
    });
    if (!record) return res.status(404).json({ error: 'Record not found' });

    const results = await runWorkflows(prisma, {
      module: String(module), trigger, record, oldRecord, userId: req.userId,
    });
    res.json({ executed: results.length, results });
  } catch (err) { next(err); }
});

module.exports = router;
