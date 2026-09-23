const { Prisma } = require('@prisma/client');
const { modelHasField } = require('../utils/modelFields');

/**
 * Rule engine for Workflow records.
 *
 * Lifted out of the /api/workflows/execute route, which held the only copy.
 * Nothing ever called that route — not the frontend, not any write path — so
 * a workflow could be written, enabled, and would never fire. The engine
 * itself was sound; it just had no trigger.
 *
 * Every write here goes straight to Prisma rather than back through the CRUD
 * router, so an action that updates a record cannot re-enter the engine and
 * loop. The depth guard below is belt and braces for future action types.
 */

/** Modules whose plural does not simply lose an "s". */
const IRREGULAR = {
  activities: 'activity',
  companies: 'company',
  opportunities: 'opportunity',
};

/**
 * Map a module name to its Prisma delegate.
 *
 * The route used module.slice(0, -1), which turns "activities" into
 * "activitie" and threw on every activity workflow.
 */
function resolveModel(moduleName) {
  const key = String(moduleName || '').trim();
  if (!key) return null;

  const candidates = [
    IRREGULAR[key.toLowerCase()],
    key.endsWith('ies') ? `${key.slice(0, -3)}y` : null,
    key.endsWith('s') ? key.slice(0, -1) : key,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const match = Prisma.dmmf.datamodel.models.find(
      m => m.name.toLowerCase() === candidate.toLowerCase()
    );
    if (match) return match.name.charAt(0).toLowerCase() + match.name.slice(1);
  }
  return null;
}

/** Which stored trigger values answer to a given event. */
const TRIGGER_ALIASES = {
  create: ['create', 'on_create', 'oncreate', 'created'],
  update: ['update', 'on_update', 'onupdate', 'updated'],
  statusChange: ['statuschange', 'status_change', 'on_status_change'],
  scheduled: ['scheduled', 'schedule', 'cron'],
};

function triggersFor(event) {
  return TRIGGER_ALIASES[event] || [String(event).toLowerCase()];
}

/** The operators compare() understands, for checking conditions when they are saved. */
const COMPARE_OPERATORS = [
  'equals', 'eq', 'notEquals', 'ne', 'contains', 'notContains', 'startsWith',
  'greaterThan', 'gt', 'lessThan', 'lt', 'gte', 'lte', 'isEmpty', 'isNotEmpty', 'in',
];

function compare(operator, value, target) {
  const left = value === null || value === undefined ? '' : value;
  switch (operator) {
    case 'equals': case 'eq': return String(left) === String(target);
    case 'notEquals': case 'ne': return String(left) !== String(target);
    case 'contains': return String(left).toLowerCase().includes(String(target).toLowerCase());
    case 'notContains': return !String(left).toLowerCase().includes(String(target).toLowerCase());
    case 'startsWith': return String(left).toLowerCase().startsWith(String(target).toLowerCase());
    case 'greaterThan': case 'gt': return Number(left) > Number(target);
    case 'lessThan': case 'lt': return Number(left) < Number(target);
    case 'gte': return Number(left) >= Number(target);
    case 'lte': return Number(left) <= Number(target);
    case 'isEmpty': return left === '' || left === null || left === undefined;
    case 'isNotEmpty': return !(left === '' || left === null || left === undefined);
    case 'in': return Array.isArray(target) && target.map(String).includes(String(left));
    default: return false;
  }
}

/**
 * Every condition must hold. `changed` and `changedTo` compare against the
 * record as it was, which is why the CRUD router passes the old row through.
 */
function evaluateConditions(conditions, record, oldRecord) {
  const list = Array.isArray(conditions) ? conditions : [];
  if (!list.length) return true;

  return list.every(condition => {
    const { field, operator, value } = condition || {};
    if (!field) return false;

    if (operator === 'changed') {
      if (!oldRecord) return false;
      return String(oldRecord[field] ?? '') !== String(record[field] ?? '');
    }
    if (operator === 'changedTo') {
      if (!oldRecord) return false;
      return String(oldRecord[field] ?? '') !== String(record[field] ?? '')
        && String(record[field] ?? '') === String(value);
    }
    return compare(operator, record[field], value);
  });
}

/** A sensible person to notify when the rule does not name one. */
function ownerOf(record, fallbackUserId) {
  return record.ownerId || record.assignedId || fallbackUserId || null;
}

async function runActions(prisma, workflow, { moduleName, modelName, record, userId }) {
  const actions = Array.isArray(workflow.actions) ? workflow.actions : [];
  const actionsRun = [];

  for (const action of actions) {
    const config = action?.config || {};
    switch (action?.type) {
      case 'updateField': {
        if (!config.field) break;
        await prisma[modelName].update({
          where: { id: record.id },
          data: { [config.field]: config.value },
        });
        // Keep the in-memory copy in step for any later action in this rule.
        record[config.field] = config.value;
        actionsRun.push(`Updated ${config.field}`);
        break;
      }

      case 'createActivity': {
        const link = {};
        // Tie the task to the record that triggered it when the shape allows,
        // instead of creating an orphan.
        for (const [fk, mod] of [['dealId', 'deals'], ['contactId', 'contacts'], ['accountId', 'accounts'], ['caseId', 'cases']]) {
          if (mod === moduleName && modelHasField('activity', fk)) link[fk] = record.id;
        }
        await prisma.activity.create({
          data: {
            type: config.actType || 'Task',
            subject: config.subject || `Auto: ${workflow.name}`,
            priority: config.priority || 'Medium',
            status: 'Scheduled',
            ...(config.assignToId || ownerOf(record, userId) ? { assignedId: config.assignToId || ownerOf(record, userId) } : {}),
            ...link,
          },
        });
        actionsRun.push('Created activity');
        break;
      }

      case 'createNotification': {
        const target = config.userId || ownerOf(record, userId);
        if (!target) break;   // a notification with nobody to read it is noise
        await prisma.notification.create({
          data: {
            title: config.title || workflow.name,
            message: config.message || `${workflow.name} ran on ${moduleName}`,
            userId: target,
            recordModule: moduleName,
            recordId: record.id,
          },
        });
        actionsRun.push('Sent notification');
        break;
      }

      case 'sendEmail': {
        const to = config.to || record.email || record.contactEmail;
        if (!to) break;
        // Required lazily: the mailer reaches the Graph client, and loading it
        // at module scope would drag the transport into every write path.
        const { sendEmail } = require('./mailer');
        const result = await sendEmail(prisma, {
          to,
          subject: config.subject || workflow.name,
          body: config.body || `${workflow.name} ran on ${moduleName} ${record.id}`,
          mailboxId: config.mailboxId,
        });
        actionsRun.push(`Email to ${to}: ${result.status}`);
        break;
      }

      default:
        break;
    }
  }

  return actionsRun;
}

/** Guards against an action type that one day writes back through the API. */
const MAX_DEPTH = 3;

/**
 * Run every active workflow for this module and event. Failures are recorded
 * against the workflow and never propagated: automation must not be able to
 * fail the write that triggered it.
 */
async function runWorkflows(prisma, { module: moduleName, trigger, record, oldRecord, userId, depth = 0 } = {}) {
  if (!prisma || !moduleName || !record?.id) return [];
  if (depth >= MAX_DEPTH) return [];

  const modelName = resolveModel(moduleName);
  if (!modelName) return [];

  const accepted = triggersFor(trigger);
  const workflows = await prisma.workflow.findMany({ where: { active: true, module: moduleName } })
    .catch(() => []);

  const due = workflows.filter(w => accepted.includes(String(w.trigger || '').toLowerCase()));
  const results = [];

  for (const workflow of due) {
    try {
      if (!evaluateConditions(workflow.conditions, record, oldRecord)) continue;

      const actionsRun = await runActions(prisma, workflow, { moduleName, modelName, record, userId });

      await prisma.workflowLog.create({
        data: {
          workflowId: workflow.id, workflowName: workflow.name,
          module: moduleName, trigger: String(trigger), recordId: record.id,
          actionsRun, success: true,
        },
      });
      await prisma.workflow.update({
        where: { id: workflow.id },
        data: { runCount: { increment: 1 }, lastRun: new Date() },
      });
      results.push({ workflow: workflow.name, actionsRun, success: true });
    } catch (err) {
      await prisma.workflowLog.create({
        data: {
          workflowId: workflow.id, workflowName: workflow.name,
          module: moduleName, trigger: String(trigger), recordId: record.id,
          actionsRun: [], success: false, error: String(err.message).slice(0, 400),
        },
      }).catch(() => {});
      results.push({ workflow: workflow.name, success: false, error: err.message });
    }
  }

  return results;
}

/** Never let a rule break the write that triggered it. */
function runWorkflowsSafely(prisma, context) {
  return runWorkflows(prisma, context).catch(() => []);
}

module.exports = {
  runWorkflows,
  runWorkflowsSafely,
  runActions,
  evaluateConditions,
  COMPARE_OPERATORS,
  resolveModel,
  triggersFor,
};
