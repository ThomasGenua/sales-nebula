const { Router } = require('express');
const { Prisma } = require('@prisma/client');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const {
  APPROVER_TYPES, APPROVAL_MODELS, buildApprovalSteps, notifyApprovers, settleStep, closeOpenSteps,
  finalActionProblem, runFinalAction, findVisibleRecord, canSeeAllRequests,
  entryConditionsProblem, meetsEntryConditions,
} = require('../services/approvals');

const router = Router();
router.use(authenticate, auditMiddleware);

// ─── PROCESSES (templates) ───

router.get('/processes', requirePermission('workflows', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const processes = await prisma.approvalProcess.findMany({
      include: { steps: { orderBy: { stepOrder: 'asc' } }, _count: { select: { requests: true } } },
      orderBy: { name: 'asc' },
    });
    res.json({ data: processes });
  } catch (err) { next(err); }
});

/** A process step's approver must be one the request can resolve. */
function invalidStep(steps) {
  if (steps !== undefined && !Array.isArray(steps)) return 'steps must be a list';
  for (const step of steps || []) {
    const type = String(step.approverType || 'user').toLowerCase();
    if (!APPROVER_TYPES.includes(type)) return `approverType must be one of: ${APPROVER_TYPES.join(', ')}`;
    if (type !== 'manager' && !step.approverId) return `Step "${step.name || '?'}" needs an approverId for approverType ${type}`;
  }
  return null;
}

/** Step rows as stored, in the order given unless each says otherwise. */
const stepRows = steps => steps.map((step, i) => ({
  name: String(step.name || `Step ${i + 1}`),
  approverType: String(step.approverType || 'user').toLowerCase(),
  approverId: step.approverId ? String(step.approverId) : null,
  stepOrder: Number.isInteger(step.stepOrder) ? step.stepOrder : i + 1,
}));

/**
 * The process fields a request may set. The body used to go to Prisma whole,
 * so it could also carry nested writes, such as ready-approved requests.
 */
function processFields(body) {
  const b = body || {};
  const data = {};
  for (const key of ['name', 'description', 'module', 'finalRejectionAction']) {
    if (b[key] !== undefined) data[key] = b[key] === null ? null : String(b[key]);
  }
  if (b.finalApprovalAction !== undefined) data.finalApprovalAction = b.finalApprovalAction ? String(b.finalApprovalAction) : 'none';
  if (b.active !== undefined) data.active = !!b.active;
  for (const key of ['entryConditions', 'finalApprovalConfig', 'finalRejectionConfig']) {
    if (b[key] !== undefined) data[key] = b[key] === null ? Prisma.DbNull : b[key];
  }
  return data;
}

/** The merged process, for checking it before it is saved. */
const asSaved = (current, data) => {
  const merged = { ...current, ...data };
  for (const key of ['entryConditions', 'finalApprovalConfig', 'finalRejectionConfig']) {
    if (merged[key] === Prisma.DbNull) merged[key] = null;
  }
  return merged;
};

/** Why a process as it would be saved could not work, or null. */
const processProblem = (process, steps) =>
  invalidStep(steps)
  || entryConditionsProblem(process.module, process.entryConditions)
  || finalActionProblem(process);

router.post('/processes', requirePermission('workflows', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { steps } = req.body || {};
    const data = processFields(req.body);
    if (!data.name || !data.module) return res.status(400).json({ error: 'name and module are required' });
    const problem = processProblem(asSaved({}, data), steps);
    if (problem) return res.status(400).json({ error: problem });
    const process = await prisma.approvalProcess.create({
      data: { ...data, steps: { create: stepRows(steps || []) } },
      include: { steps: true },
    });
    await req.audit({ action: 'create', module: 'approvals', recordId: process.id, details: `Created approval process: ${process.name}` });
    res.status(201).json(process);
  } catch (err) { next(err); }
});

router.put('/processes/:id', requirePermission('workflows', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const current = await prisma.approvalProcess.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ error: 'Not found' });
    const { steps } = req.body || {};
    const data = processFields(req.body);
    const problem = processProblem(asSaved(current, data), steps);
    if (problem) return res.status(400).json({ error: problem });
    // New steps replace the old in one transaction: a failed update used to
    // leave the process with none.
    const writes = [];
    if (steps) writes.push(prisma.approvalProcessStep.deleteMany({ where: { processId: req.params.id } }));
    writes.push(prisma.approvalProcess.update({
      where: { id: req.params.id },
      data: { ...data, ...(steps && { steps: { create: stepRows(steps) } }) },
      include: { steps: true },
    }));
    const process = (await prisma.$transaction(writes)).pop();
    await req.audit({ action: 'update', module: 'approvals', recordId: process.id, details: `Updated approval process: ${process.name}` });
    res.json(process);
  } catch (err) { next(err); }
});

router.delete('/processes/:id', requirePermission('workflows', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Requests keep a required link to their process, so deleting one that
    // had been used failed with a 500. They are the approval record, so the
    // process stays; switching it off stops new requests.
    const requests = await prisma.approvalRequest.count({ where: { processId: req.params.id } });
    if (requests) return res.status(409).json({ error: `This process has ${requests} approval request(s). Deactivate it instead.` });
    await prisma.approvalProcess.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── REQUESTS (instances) ───

const requestInclude = {
  process: { select: { id: true, name: true } },
  submittedBy: { select: { id: true, firstName: true, lastName: true } },
  steps: { include: { approver: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { stepOrder: 'asc' } },
  deal: { select: { id: true, name: true, value: true } },
};

// Every request for administrators; otherwise the caller's own, submitted or
// awaiting their decision. This listed the whole organisation's requests,
// with deal names and values, to anyone signed in.
router.get('/requests', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { status, module: mod, limit } = req.query;
    const where = {};
    if (status) where.status = String(status);
    if (mod) where.module = String(mod);
    if (!canSeeAllRequests(req.user)) {
      where.OR = [{ submittedById: req.userId }, { steps: { some: { approverId: req.userId } } }];
    }
    const requests = await prisma.approvalRequest.findMany({
      where,
      include: requestInclude,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500),
    });
    res.json({ data: requests });
  } catch (err) { next(err); }
});

// My pending approvals
router.get('/requests/pending', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const pending = await prisma.approvalStep.findMany({
      // Only steps whose turn has come, on requests still open.
      where: { approverId: req.userId, status: 'Pending', request: { status: 'Pending' } },
      include: {
        request: {
          include: {
            process: { select: { name: true } },
            submittedBy: { select: { firstName: true, lastName: true } },
            deal: { select: { name: true, value: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: pending });
  } catch (err) { next(err); }
});

// SUBMIT for approval
router.post('/requests', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { processId, recordId, comments } = req.body || {};

    const process = processId ? await prisma.approvalProcess.findUnique({
      where: { id: String(processId) },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    }) : null;
    if (!process || !process.active) return res.status(400).json({ error: 'Process not found or inactive' });
    if (!process.steps.length) return res.status(400).json({ error: 'Process has no steps' });
    if (!recordId) return res.status(400).json({ error: 'recordId is required' });

    // The record must be one the submitter can see, in the process's own
    // module. Any id used to be taken, with whatever module and deal the
    // body named, and then shown, deal value included, to every approver.
    const known = !!APPROVAL_MODELS[process.module];
    const record = known ? await findVisibleRecord(req, process.module, recordId) : null;
    if (known && !record) return res.status(404).json({ error: 'Record not found' });
    if (!meetsEntryConditions(process, record)) {
      return res.status(400).json({ error: `This record does not meet the entry conditions of "${process.name}"` });
    }
    const open = await prisma.approvalRequest.findFirst({ where: { processId: process.id, recordId: String(recordId), status: 'Pending' } });
    if (open) return res.status(409).json({ error: 'This record is already awaiting approval', requestId: open.id });

    // Every candidate for every step, never the submitter (services/approvals).
    const rows = await buildApprovalSteps(prisma, process.steps, req.user);

    const request = await prisma.approvalRequest.create({
      data: {
        processId: process.id,
        module: process.module,
        recordId: String(recordId),
        dealId: process.module === 'deals' ? String(recordId) : null,
        submittedById: req.userId,
        comments: comments == null ? null : String(comments),
        currentStep: 1,
        steps: { create: rows },
      },
      include: {
        steps: { include: { approver: { select: { id: true, firstName: true, lastName: true } } } },
        process: true,
      },
    });

    await notifyApprovers(prisma, request, 1, 'Approval Required', `${process.name}: Submitted by ${req.user.firstName}`);

    await req.audit({ action: 'create', module: 'approvals', recordId: request.id, details: `Submitted for approval: ${process.name}` });
    res.status(201).json(request);
  } catch (err) { next(err); }
});

/**
 * Move a pending request on from the step it is at, or to its outcome. Only
 * one decision can win: two approvers of the same step used to both
 * succeed, and on the last step both ran the final action.
 */
async function claimStep(prisma, request, data) {
  const { count } = await prisma.approvalRequest.updateMany({
    where: { id: request.id, status: 'Pending', currentStep: request.currentStep },
    data,
  });
  return count === 1;
}

const alreadyDecided = res => res.status(409).json({ error: 'This step has already been decided' });

// APPROVE a step
router.post('/requests/:id/approve', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { comments } = req.body || {};

    const request = await prisma.approvalRequest.findUnique({
      where: { id: req.params.id },
      include: { steps: { orderBy: { stepOrder: 'asc' } }, process: true },
    });
    if (!request || request.status !== 'Pending') return res.status(400).json({ error: 'Invalid request' });

    const currentStep = request.steps.find(s => s.stepOrder === request.currentStep && s.approverId === req.userId && s.status === 'Pending');
    if (!currentStep) return res.status(403).json({ error: 'Not your turn to approve' });

    const nextStepNum = request.currentStep + 1;
    const hasNextStep = request.steps.some(s => s.stepOrder === nextStepNum);
    const claimed = await claimStep(prisma, request, hasNextStep
      ? { currentStep: nextStepNum }
      : { status: 'Approved', completedAt: new Date() });
    if (!claimed) return alreadyDecided(res);

    // Approve this step; the other candidates for it are done.
    await settleStep(prisma, request, currentStep, 'Approved', comments);

    let finalAction = null;
    if (hasNextStep) {
      await prisma.approvalStep.updateMany({ where: { requestId: request.id, stepOrder: nextStepNum, status: 'Waiting' }, data: { status: 'Pending' } });
      await notifyApprovers(prisma, request, nextStepNum, `Approval Required (Step ${nextStepNum})`, request.process.name);
    } else {
      // The submitter only ever heard about rejections.
      await prisma.notification.create({
        data: { title: 'Approval Granted', message: comments || `${request.process.name} was approved`, userId: request.submittedById, recordModule: request.module, recordId: request.recordId },
      });
      finalAction = await runFinalAction(prisma, request, request.process, 'Approved');
    }

    await req.audit({
      action: 'update', module: 'approvals', recordId: req.params.id,
      details: `Step ${request.currentStep} approved${finalAction ? `; final action ${finalAction.action} ${finalAction.ok ? 'ran' : `failed: ${finalAction.error}`}` : ''}`,
    });
    const updated = await prisma.approvalRequest.findUnique({ where: { id: req.params.id }, include: { steps: { include: { approver: { select: { id: true, firstName: true, lastName: true } } } }, process: true } });
    res.json({ ...updated, finalAction });
  } catch (err) { next(err); }
});

// REJECT
router.post('/requests/:id/reject', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { comments } = req.body || {};
    const request = await prisma.approvalRequest.findUnique({ where: { id: req.params.id }, include: { steps: true, process: true } });
    // A decided request stays decided: this used to let an approver reject
    // one that had already been approved.
    if (!request || request.status !== 'Pending') return res.status(400).json({ error: 'Invalid request' });
    const currentStep = request.steps.find(s => s.stepOrder === request.currentStep && s.approverId === req.userId && s.status === 'Pending');
    if (!currentStep) return res.status(403).json({ error: 'Not authorized' });

    if (!(await claimStep(prisma, request, { status: 'Rejected', completedAt: new Date() }))) return alreadyDecided(res);
    await settleStep(prisma, request, currentStep, 'Rejected', comments);
    await closeOpenSteps(prisma, request.id);

    await prisma.notification.create({
      data: { title: 'Approval Rejected', message: comments || 'Your request was rejected', userId: request.submittedById, recordModule: request.module, recordId: request.recordId },
    });
    const finalAction = await runFinalAction(prisma, request, request.process, 'Rejected');

    await req.audit({
      action: 'update', module: 'approvals', recordId: req.params.id,
      details: `Rejected${finalAction ? `; final action ${finalAction.action} ${finalAction.ok ? 'ran' : `failed: ${finalAction.error}`}` : ''}`,
    });
    res.json({ success: true, status: 'Rejected', finalAction });
  } catch (err) { next(err); }
});

// RECALL (submitter pulls back)
router.post('/requests/:id/recall', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const request = await prisma.approvalRequest.findUnique({ where: { id: req.params.id } });
    if (request?.submittedById !== req.userId) return res.status(403).json({ error: 'Only submitter can recall' });
    if (request.status !== 'Pending') return res.status(400).json({ error: 'Can only recall pending requests' });

    const { count } = await prisma.approvalRequest.updateMany({ where: { id: request.id, status: 'Pending' }, data: { status: 'Recalled', completedAt: new Date() } });
    if (count !== 1) return res.status(409).json({ error: 'This request has already been decided' });
    await closeOpenSteps(prisma, request.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
