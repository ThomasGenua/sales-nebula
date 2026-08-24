const { Router } = require('express');
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
router.post('/execute', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, trigger, record, oldRecord } = req.body;

    const workflows = await prisma.workflow.findMany({ where: { module, trigger, active: true } });
    const results = [];

    for (const wf of workflows) {
      try {
        // Evaluate conditions
        const conditions = wf.conditions || [];
        const allMatch = conditions.every(cond => {
          const val = record[cond.field];
          const target = cond.value;
          switch (cond.operator) {
            case 'equals': return String(val) === String(target);
            case 'notEquals': return String(val) !== String(target);
            case 'contains': return String(val || '').includes(target);
            case 'greaterThan': return Number(val) > Number(target);
            case 'lessThan': return Number(val) < Number(target);
            case 'isEmpty': return !val || String(val).trim() === '';
            case 'isNotEmpty': return val && String(val).trim() !== '';
            default: return true;
          }
        });

        if (!allMatch) continue;

        // Execute actions
        const actions = wf.actions || [];
        const actionsRun = [];

        for (const action of actions) {
          switch (action.type) {
            case 'updateField':
              await prisma[module.slice(0, -1)].update({
                where: { id: record.id },
                data: { [action.config.field]: action.config.value },
              });
              actionsRun.push(`Updated ${action.config.field}`);
              break;
            case 'createActivity':
              await prisma.activity.create({
                data: {
                  type: action.config.actType || 'Task',
                  subject: action.config.subject || `Auto: ${wf.name}`,
                  date: new Date(),
                  priority: action.config.priority || 'Medium',
                  status: 'Scheduled',
                },
              });
              actionsRun.push('Created activity');
              break;
            case 'createNotification':
              await prisma.notification.create({
                data: {
                  title: action.config.title || wf.name,
                  message: action.config.message || 'Workflow triggered',
                  userId: req.userId,
                  recordModule: module,
                  recordId: record.id,
                },
              });
              actionsRun.push('Sent notification');
              break;
          }
        }

        // Log execution
        await prisma.workflowLog.create({
          data: { workflowId: wf.id, workflowName: wf.name, module, trigger, recordId: record.id, actionsRun, success: true },
        });
        await prisma.workflow.update({ where: { id: wf.id }, data: { runCount: { increment: 1 } } });
        results.push({ workflow: wf.name, actionsRun, success: true });
      } catch (err) {
        await prisma.workflowLog.create({
          data: { workflowId: wf.id, workflowName: wf.name, module, trigger, recordId: record.id, actionsRun: [], success: false, error: err.message },
        });
        results.push({ workflow: wf.name, success: false, error: err.message });
      }
    }

    res.json({ executed: results.length, results });
  } catch (err) { next(err); }
});

module.exports = router;
