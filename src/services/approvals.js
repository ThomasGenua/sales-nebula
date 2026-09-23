/**
 * Who approves each step of an approval process, and the request built on
 * that.
 *
 * A process step names its approver by type:
 *   user     - the user in approverId
 *   role     - anyone holding the role in approverId
 *   manager  - anyone in the role directly above the submitter's in the role
 *              hierarchy
 *   queue    - the members of the team in approverId ("team" is accepted too;
 *              the schema has no other membership list to route a queue to)
 *
 * Only `user` steps used to work. The others carry no user id, and before
 * that were given the submitter, who could then approve their own request.
 * Every candidate now gets a step row at the step's position, the first
 * decision settles the step for all of them, and the submitter is never a
 * candidate.
 */

const APPROVER_TYPES = ['user', 'role', 'manager', 'queue', 'team'];

class ApprovalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApprovalError';
    this.status = 400;
  }
}

const activeUserIds = async (prisma, where) =>
  (await prisma.user.findMany({ where: { ...where, active: true }, select: { id: true } })).map(u => u.id);

/** The user ids who may decide one process step for this submitter. */
async function candidatesFor(prisma, step, submitter) {
  const type = String(step.approverType || 'user').toLowerCase();
  if (!APPROVER_TYPES.includes(type)) {
    throw new ApprovalError(`Approval step "${step.name}" has an unknown approver type: ${step.approverType}`);
  }
  if (type !== 'manager' && !step.approverId) {
    throw new ApprovalError(`Approval step "${step.name}" names no ${type === 'team' ? 'queue' : type}; set approverId on the process step`);
  }

  let ids;
  if (type === 'user') {
    ids = await activeUserIds(prisma, { id: step.approverId });
  } else if (type === 'role') {
    ids = await activeUserIds(prisma, { roleId: step.approverId });
  } else if (type === 'manager') {
    const link = submitter.roleId
      ? await prisma.roleHierarchy.findUnique({ where: { roleId: submitter.roleId } })
      : null;
    if (!link?.parentId) {
      throw new ApprovalError(`Approval step "${step.name}" goes to the submitter's manager, but the submitter's role has no parent in the role hierarchy`);
    }
    ids = await activeUserIds(prisma, { roleId: link.parentId });
  } else {
    const members = await prisma.teamMember.findMany({ where: { teamId: step.approverId }, select: { userId: true } });
    ids = await activeUserIds(prisma, { id: { in: members.map(m => m.userId) } });
  }

  const eligible = [...new Set(ids)].filter(id => id !== submitter.id);
  if (!eligible.length) {
    throw new ApprovalError(`Approval step "${step.name}" has no active approver other than the submitter`);
  }
  return eligible;
}

/**
 * Step rows for a new request: every candidate of every process step, the
 * first step Pending and the rest Waiting their turn. Throws ApprovalError
 * (a 400) when any step has no one to decide it.
 */
async function buildApprovalSteps(prisma, processSteps, submitter) {
  const rows = [];
  for (const [i, step] of processSteps.entries()) {
    for (const approverId of await candidatesFor(prisma, step, submitter)) {
      // Numbered from 1 in process order, to match ApprovalRequest.currentStep.
      rows.push({ stepOrder: i + 1, approverId, status: i === 0 ? 'Pending' : 'Waiting' });
    }
  }
  return rows;
}

/** Tell everyone who can now decide a step that it is waiting for them. */
async function notifyApprovers(prisma, request, stepOrder, title, message) {
  const rows = await prisma.approvalStep.findMany({ where: { requestId: request.id, stepOrder, status: 'Pending' }, select: { approverId: true } });
  for (const { approverId } of rows) {
    await prisma.notification.create({
      data: { title, message, userId: approverId, recordModule: request.module, recordId: request.recordId },
    });
  }
}

/**
 * Record one approver's decision on the current step. The other candidates'
 * rows for that step are closed as Skipped, so no one decides it twice.
 */
async function settleStep(prisma, request, deciderRow, status, comments) {
  const now = new Date();
  await prisma.approvalStep.update({ where: { id: deciderRow.id }, data: { status, comments, decidedAt: now } });
  await prisma.approvalStep.updateMany({
    where: { requestId: request.id, stepOrder: deciderRow.stepOrder, id: { not: deciderRow.id }, status: 'Pending' },
    data: { status: 'Skipped', decidedAt: now },
  });
}

/** Close every step still open on a request that has ended. */
async function closeOpenSteps(prisma, requestId) {
  await prisma.approvalStep.updateMany({
    where: { requestId, status: { in: ['Pending', 'Waiting'] } },
    data: { status: 'Skipped', decidedAt: new Date() },
  });
}

module.exports = {
  APPROVER_TYPES, ApprovalError,
  candidatesFor, buildApprovalSteps, notifyApprovers, settleStep, closeOpenSteps,
};
