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
 *
 * A process's entryConditions, [{ field, operator, value }] as workflows use
 * them, must all hold for a record to be submitted to it. They were stored
 * and never looked at.
 *
 * When a request is decided, its process's final action for that outcome
 * runs: `updateField` sets one field on the record, `createNotification`
 * tells the record's owner (or config.userId). The approve route used to
 * read a finalApprovalConfig column that did not exist, so neither ever ran.
 */
const { Prisma } = require('@prisma/client');
const { logger } = require('./logger');
const { plainFieldProblem } = require('../utils/modelFields');
const { visibleWhere, isAdmin } = require('../middleware/rowSecurity');
const { evaluateConditions, COMPARE_OPERATORS } = require('./workflowEngine');

const APPROVER_TYPES = ['user', 'role', 'manager', 'queue', 'team'];
const FINAL_ACTIONS = ['none', 'updateField', 'createNotification'];

/** The modules an approval can be about, and the table each one lives in. */
const APPROVAL_MODELS = {
  deals: 'deal', quotes: 'quote', invoices: 'invoice', contracts: 'contract', orders: 'order',
  cases: 'case', leads: 'lead', accounts: 'account', contacts: 'contact', campaigns: 'campaign',
  products: 'product', projects: 'project', subscriptions: 'subscription',
};

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

// ─── FINAL ACTIONS ───

const dmmfModel = modelName => Prisma.dmmf.datamodel.models.find(m => m.name.toLowerCase() === modelName.toLowerCase());

/** Why `{ field, value }` cannot be set on this module's records, or null. */
function fieldUpdateProblem(module, config) {
  const modelName = APPROVAL_MODELS[module];
  if (!modelName) return `updateField works only for these modules: ${Object.keys(APPROVAL_MODELS).join(', ')}`;
  const { field, value } = config && typeof config === 'object' ? config : {};
  const problem = plainFieldProblem(modelName, field, value);
  return problem ? `updateField on ${module}: ${problem}` : null;
}

// ─── ENTRY CONDITIONS ───

/** Why a process's entry conditions could never be checked, or null. */
function entryConditionsProblem(module, conditions) {
  if (conditions == null) return null;
  if (!Array.isArray(conditions)) return 'entryConditions must be a list of { field, operator, value }';
  if (!conditions.length) return null;
  const modelName = APPROVAL_MODELS[module];
  if (!modelName) return `entryConditions work only for these modules: ${Object.keys(APPROVAL_MODELS).join(', ')}`;
  const model = dmmfModel(modelName);
  for (const condition of conditions) {
    const { field, operator } = condition || {};
    if (!model.fields.some(f => f.name === field && f.kind !== 'object')) {
      return `entryConditions: ${module} has no field "${field}"`;
    }
    if (!COMPARE_OPERATORS.includes(operator)) {
      return `entryConditions: operator must be one of ${COMPARE_OPERATORS.join(', ')}`;
    }
  }
  return null;
}

/** Whether a record meets a process's entry conditions; none means it does. */
const meetsEntryConditions = (process, record) =>
  !Array.isArray(process.entryConditions) || !process.entryConditions.length
    || (!!record && evaluateConditions(process.entryConditions, record));

/** Why a process's final actions could not run, or null when they can. */
function finalActionProblem(process) {
  const outcomes = [
    ['finalApprovalAction', process.finalApprovalAction, process.finalApprovalConfig],
    ['finalRejectionAction', process.finalRejectionAction, process.finalRejectionConfig],
  ];
  for (const [label, action, config] of outcomes) {
    if (action == null || action === 'none') continue;
    if (!FINAL_ACTIONS.includes(action)) return `${label} must be one of: ${FINAL_ACTIONS.join(', ')}`;
    if (action === 'updateField') {
      const problem = fieldUpdateProblem(process.module, config);
      if (problem) return problem;
    }
    if (action === 'createNotification' && config != null) {
      const { message, userId } = config;
      if ((message != null && typeof message !== 'string') || (userId != null && typeof userId !== 'string')) {
        return 'createNotification takes an optional message and userId, both strings';
      }
    }
  }
  return null;
}

/** Who owns a record, by whichever ownership columns its model has. */
async function recordOwners(prisma, modelName, recordId) {
  const fields = ['ownerId', 'assignedId'].filter(f => prisma[modelName]?.fields && f in prisma[modelName].fields);
  if (!fields.length) return [];
  const record = await prisma[modelName].findUnique({
    where: { id: recordId },
    select: Object.fromEntries(fields.map(f => [f, true])),
  });
  return [...new Set(fields.map(f => record?.[f]).filter(Boolean))];
}

/**
 * The final action a decided request's process names for its outcome
 * ('Approved' or 'Rejected'). The decision stands whatever happens here, so
 * a failure is logged and returned, not thrown.
 */
async function runFinalAction(prisma, request, process, outcome) {
  const approved = outcome === 'Approved';
  const action = approved ? process.finalApprovalAction : process.finalRejectionAction;
  const config = (approved ? process.finalApprovalConfig : process.finalRejectionConfig) || {};
  if (!action || action === 'none') return null;
  const modelName = APPROVAL_MODELS[request.module];
  try {
    if (action === 'updateField') {
      // Checked again: the process or the schema may have changed since.
      const problem = fieldUpdateProblem(request.module, config);
      if (problem) throw new Error(problem);
      await prisma[modelName].update({ where: { id: request.recordId }, data: { [config.field]: config.value } });
    } else if (action === 'createNotification') {
      const to = config.userId ? [config.userId] : modelName ? await recordOwners(prisma, modelName, request.recordId) : [];
      // The submitter hears of every outcome already.
      for (const userId of to.filter(id => id !== request.submittedById)) {
        await prisma.notification.create({
          data: {
            title: `Approval ${outcome.toLowerCase()}`,
            message: config.message || `${process.name}: ${outcome.toLowerCase()}`,
            userId, recordModule: request.module, recordId: request.recordId,
          },
        });
      }
    } else {
      throw new Error(`Unknown final action: ${action}`);
    }
    return { action, ok: true };
  } catch (err) {
    logger.warn({ err, requestId: request.id, action }, 'Approval final action failed');
    return { action, ok: false, error: err.message };
  }
}

// ─── WHO SEES WHAT ───

/** The record an approval would be about, if the submitter may see it. */
async function findVisibleRecord(req, module, recordId) {
  const modelName = APPROVAL_MODELS[module];
  if (!modelName || !recordId) return null;
  const prisma = req.app.locals.prisma;
  return prisma[modelName].findFirst({ where: await visibleWhere(req, module, modelName, { id: String(recordId) }) });
}

/**
 * Administrators, and whoever may fully manage workflows, see every request;
 * everyone else sees those they submitted or were asked to decide.
 */
function canSeeAllRequests(user) {
  if (isAdmin(user)) return true;
  return user?.role?.permissions?.some(p => p.module === 'workflows' && p.level === 'full') || false;
}

module.exports = {
  APPROVER_TYPES, APPROVAL_MODELS, FINAL_ACTIONS, ApprovalError,
  candidatesFor, buildApprovalSteps, notifyApprovers, settleStep, closeOpenSteps,
  fieldUpdateProblem, finalActionProblem, runFinalAction, findVisibleRecord, canSeeAllRequests,
  entryConditionsProblem, meetsEntryConditions,
};
