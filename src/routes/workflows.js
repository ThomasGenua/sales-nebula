const { Router } = require('express');
const { runWorkflows } = require('../services/workflowEngine');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

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
    const workflow = await prisma.workflow.create({ data: req.body });
    await req.audit({ action: 'create', module: 'workflows', recordId: workflow.id });
    res.status(201).json(workflow);
  } catch (err) { next(err); }
});

// UPDATE
router.put('/:id', requirePermission('workflows', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { id, createdAt, updatedAt, logs, ...data } = req.body;
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
router.post('/execute', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, trigger, record, oldRecord } = req.body || {};
    if (!module || !trigger || !record?.id) {
      return res.status(400).json({ error: 'module, trigger and record.id are required' });
    }

    const results = await runWorkflows(prisma, {
      module, trigger, record, oldRecord, userId: req.userId,
    });
    res.json({ executed: results.length, results });
  } catch (err) { next(err); }
});

module.exports = router;
