const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

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

router.post('/processes', requirePermission('workflows', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { steps, ...data } = req.body;
    const process = await prisma.approvalProcess.create({
      data: { ...data, steps: { create: steps || [] } },
      include: { steps: true },
    });
    await req.audit({ action: 'create', module: 'approvals', recordId: process.id, details: `Created approval process: ${process.name}` });
    res.status(201).json(process);
  } catch (err) { next(err); }
});

router.put('/processes/:id', requirePermission('workflows', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { steps, id, createdAt, updatedAt, requests, _count, ...data } = req.body;
    if (steps) await prisma.approvalProcessStep.deleteMany({ where: { processId: req.params.id } });
    const process = await prisma.approvalProcess.update({
      where: { id: req.params.id },
      data: { ...data, ...(steps && { steps: { create: steps } }) },
      include: { steps: true },
    });
    res.json(process);
  } catch (err) { next(err); }
});

router.delete('/processes/:id', requirePermission('workflows', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.approvalProcess.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── REQUESTS (instances) ───

router.get('/requests', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { status, module: mod } = req.query;
    let where = {};
    if (status) where.status = status;
    if (mod) where.module = mod;
    const requests = await prisma.approvalRequest.findMany({
      where,
      include: {
        process: { select: { id: true, name: true } },
        submittedBy: { select: { id: true, firstName: true, lastName: true } },
        steps: { include: { approver: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { stepOrder: 'asc' } },
        deal: { select: { id: true, name: true, value: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: requests });
  } catch (err) { next(err); }
});

// My pending approvals
router.get('/requests/pending', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const pending = await prisma.approvalStep.findMany({
      where: { approverId: req.userId, status: 'Pending' },
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
    const { processId, module, recordId, dealId, comments } = req.body;

    const process = await prisma.approvalProcess.findUnique({
      where: { id: processId },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
    if (!process || !process.active) return res.status(400).json({ error: 'Process not found or inactive' });
    // A step with no named approver used to fall back to the submitter, who
    // could then approve their own request. Role, manager and queue approvers
    // are not resolved yet, so such a process cannot be submitted.
    const unassigned = process.steps.find(step => !step.approverId);
    if (unassigned) {
      return res.status(400).json({ error: `Approval step "${unassigned.name}" has no approver; set approverId on the process step` });
    }

    // Check entry conditions
    if (process.entryConditions && process.entryConditions.length > 0) {
      // Simplified condition check -- in production you'd evaluate against the actual record
    }

    const request = await prisma.approvalRequest.create({
      data: {
        processId,
        module,
        recordId,
        dealId: dealId || null,
        submittedById: req.userId,
        comments,
        currentStep: 1,
        steps: {
          // Numbered from 1 in process order, to match currentStep.
          create: process.steps.map((step, i) => ({
            stepOrder: i + 1,
            approverId: step.approverId,
          })),
        },
      },
      include: {
        steps: { include: { approver: { select: { id: true, firstName: true, lastName: true } } } },
        process: true,
      },
    });

    // Notify first approver
    const firstStep = request.steps.find(s => s.stepOrder === 1);
    if (firstStep) {
      await prisma.notification.create({
        data: {
          title: 'Approval Required',
          message: `${process.name}: Submitted by ${(await prisma.user.findUnique({ where: { id: req.userId }, select: { firstName: true } })).firstName}`,
          userId: firstStep.approverId,
          recordModule: module,
          recordId,
        },
      });
    }

    await req.audit({ action: 'create', module: 'approvals', recordId: request.id, details: `Submitted for approval: ${process.name}` });
    res.status(201).json(request);
  } catch (err) { next(err); }
});

// APPROVE a step
router.post('/requests/:id/approve', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { comments } = req.body;

    const request = await prisma.approvalRequest.findUnique({
      where: { id: req.params.id },
      include: { steps: { orderBy: { stepOrder: 'asc' } }, process: { include: { steps: true } } },
    });
    if (!request || request.status !== 'Pending') return res.status(400).json({ error: 'Invalid request' });

    const currentStep = request.steps.find(s => s.stepOrder === request.currentStep && s.approverId === req.userId);
    if (!currentStep) return res.status(403).json({ error: 'Not your turn to approve' });

    // Approve this step
    await prisma.approvalStep.update({
      where: { id: currentStep.id },
      data: { status: 'Approved', comments, decidedAt: new Date() },
    });

    // Check if there are more steps
    const nextStepNum = request.currentStep + 1;
    const hasNextStep = request.steps.some(s => s.stepOrder === nextStepNum);

    if (hasNextStep) {
      await prisma.approvalRequest.update({
        where: { id: req.params.id },
        data: { currentStep: nextStepNum },
      });
      // Notify next approver
      const nextStep = request.steps.find(s => s.stepOrder === nextStepNum);
      if (nextStep) {
        await prisma.notification.create({
          data: { title: 'Approval Required (Step ' + nextStepNum + ')', message: `${request.process.name}`, userId: nextStep.approverId, recordModule: request.module, recordId: request.recordId },
        });
      }
    } else {
      // Final approval
      await prisma.approvalRequest.update({
        where: { id: req.params.id },
        data: { status: 'Approved', completedAt: new Date() },
      });
      // Execute final approval action
      if (request.process.finalApprovalAction === 'updateField' && request.process.finalApprovalConfig) {
        const config = request.process.finalApprovalConfig;
        const modelName = request.module.endsWith('s') ? request.module.slice(0, -1) : request.module;
        try {
          await prisma[modelName].update({ where: { id: request.recordId }, data: { [config.field]: config.value } });
        } catch (e) { /* ignore if model/field doesn't exist */ }
      }
    }

    await req.audit({ action: 'update', module: 'approvals', recordId: req.params.id, details: `Step ${request.currentStep} approved` });
    const updated = await prisma.approvalRequest.findUnique({ where: { id: req.params.id }, include: { steps: { include: { approver: { select: { id: true, firstName: true, lastName: true } } } }, process: true } });
    res.json(updated);
  } catch (err) { next(err); }
});

// REJECT
router.post('/requests/:id/reject', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { comments } = req.body;
    const request = await prisma.approvalRequest.findUnique({ where: { id: req.params.id }, include: { steps: true } });
    const currentStep = request?.steps.find(s => s.stepOrder === request.currentStep && s.approverId === req.userId);
    if (!currentStep) return res.status(403).json({ error: 'Not authorized' });

    await prisma.approvalStep.update({ where: { id: currentStep.id }, data: { status: 'Rejected', comments, decidedAt: new Date() } });
    await prisma.approvalRequest.update({ where: { id: req.params.id }, data: { status: 'Rejected', completedAt: new Date() } });

    await prisma.notification.create({
      data: { title: 'Approval Rejected', message: comments || 'Your request was rejected', userId: request.submittedById, recordModule: request.module, recordId: request.recordId },
    });

    await req.audit({ action: 'update', module: 'approvals', recordId: req.params.id, details: 'Rejected' });
    res.json({ success: true, status: 'Rejected' });
  } catch (err) { next(err); }
});

// RECALL (submitter pulls back)
router.post('/requests/:id/recall', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const request = await prisma.approvalRequest.findUnique({ where: { id: req.params.id } });
    if (request?.submittedById !== req.userId) return res.status(403).json({ error: 'Only submitter can recall' });
    if (request.status !== 'Pending') return res.status(400).json({ error: 'Can only recall pending requests' });

    await prisma.approvalRequest.update({ where: { id: req.params.id }, data: { status: 'Recalled', completedAt: new Date() } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
