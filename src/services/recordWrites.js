/**
 * The one way a record of a CRUD module is created, changed or deleted.
 *
 * The CRUD router ran a module's rules around each write: its own hooks (a
 * case's number and closedAt, a deal's currency and stage history), then
 * validation, duplicate and assignment rules before the write, then audit,
 * security groups, real-time events, workflow rules and webhooks after it.
 * Every other path wrote straight to the table and skipped all of it: import,
 * the bulk API, mass actions, mobile sync, lead conversion, web-to-lead,
 * email-to-case, the portal. A rule set to notify someone of a new
 * high-priority case never heard of a case a customer opened by email, an
 * imported case had no number, and a deal moved by a mass update kept no
 * stage history.
 *
 * So the rules live here, and every path that writes these records comes
 * through createRecord, updateRecord or deleteRecord. tests/writePaths.test.js
 * fails when a new one writes the table directly.
 *
 * The context a write takes:
 *   userId  who is acting; none for a public form, inbound mail or a job
 *   req     the request, when there is one. Links are checked against what
 *           its caller may see, and a module's hooks may read its body
 *           (an order's lines).
 *   linkCache  a Map shared by the writes of one batch, so each linked
 *           record is looked up once (an import's accounts)
 *   source  what made the write ('import', 'web-to-lead'), for the audit trail
 *   include what the written record comes back with
 *   nested  rows written with the record that the caller built itself, from
 *           checked fields (an order's lines, copied from its quote; a
 *           quote's replaced lines); for a create from a request, the
 *           module's nestedWrites builds them
 *   hydrate (record) => ..., run on the record before the automation sees it
 *   emit    real-time senders; the request's, or else the WebSocket's
 *   after   inside a transaction: a list the automation is added to rather
 *           than run, for runAfter once the transaction commits (a workflow
 *           that emails cannot be rolled back, and it would read rows that
 *           are not there yet). `prisma` is then the client it runs on.
 */

const { Prisma } = require('@prisma/client');
const { audit } = require('../middleware/audit');
const { diffFields, formatChanges } = require('../utils/integrity');
const { pickModelFields, modelHasField } = require('../utils/modelFields');
const { createNumbered } = require('../utils/numbering');
const { checkValidationRules, applyAssignmentRules, findDuplicates, recordDuplicates } = require('./recordRules');
const { runWorkflowsSafely } = require('./workflowEngine');
const { logger } = require('./logger');

/** A write the rules refused: `status` and `body` are the HTTP answer. */
class RecordWriteError extends Error {
  constructor(status, body) {
    super(body.error);
    this.status = status;
    this.body = body;
    this.code = body.code;
  }

  /**
   * The answer for someone outside the company (a public form, the portal):
   * the rule's message, without the rule's name or another record's id.
   */
  get publicBody() {
    return { error: this.body.error, ...(this.code ? { code: this.code } : {}) };
  }
}

/**
 * Run a module's hook. One that refuses the data throws an error with a 4xx
 * status (an unknown currency); that is the write's answer, as a rule's is.
 */
async function runHook(fn, ...args) {
  try {
    return await fn(...args);
  } catch (err) {
    if (err instanceof RecordWriteError || !(err?.status >= 400 && err.status < 500)) throw err;
    throw new RecordWriteError(err.status, { error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
}

// ─── MODULES ───

// moduleName -> { moduleName, modelName, hooks }. Filled by createCrudRouter,
// which is where a CRUD module's hooks are declared, and by the routers of
// the modules that have their own (quotes, invoices, projects, prospects).
const modules = new Map();

function defineModule(moduleName, modelName, hooks = {}) {
  modules.set(moduleName, { moduleName, modelName, hooks });
}

function moduleDefinition(moduleName) {
  const definition = modules.get(moduleName);
  if (!definition) throw new Error(`${moduleName} has no record rules`);
  return definition;
}

/** Whether `moduleName`'s writes come through here (a CRUD module, or one registered by its router). */
const isRecordModule = moduleName => modules.has(moduleName);

// Ownership column, in preference order: a model that has `ownerId` uses it;
// one that only has `assignedId` uses that instead.
const OWNERSHIP_FIELDS = ['ownerId', 'assignedId'];

const softDeletes = modelName => modelHasField(modelName, 'deletedAt');

/** What a module's hooks are handed, besides the data. */
function hookContext(db, ctx, oldRecord = null) {
  return { prisma: db, userId: ctx.userId || null, req: ctx.req || null, oldRecord, emit: emitterFor(ctx) };
}

function emitterFor(ctx) {
  if (ctx.emit) return ctx.emit;
  if (ctx.req?.app?.locals?.emit) return ctx.req.app.locals.emit;
  // Required lazily: the WebSocket service is not needed to write a record.
  return require('./websocket').emit;
}

// ─── BATCHES ───

// The configuration the rules read on every write: validation, duplicate and
// assignment rules, workflows, webhooks and security group rules.
const RULE_TABLES = new Set([
  'validationRule', 'duplicateRule', 'assignmentRule', 'workflow', 'webhook', 'securityGroupRule', 'securityGroupUser',
]);

/**
 * The client for one batch of writes (an import, a bulk API call), reading
 * that configuration once rather than once a record: a 500-row import looked
 * the same rules up 500 times. Only the rule tables' findMany is remembered,
 * for this batch alone; everything else, the round-robin counter of an
 * assignment rule included, goes to the database as ever.
 */
function batchClient(prisma) {
  const remembered = new Map();
  const delegates = new Map();
  const bound = (owner, value) => (typeof value === 'function' ? value.bind(owner) : value);
  return new Proxy(prisma, {
    get(target, table) {
      const delegate = Reflect.get(target, table);
      if (!RULE_TABLES.has(table)) return bound(target, delegate);
      if (!delegates.has(table)) {
        delegates.set(table, new Proxy(delegate, {
          get(real, method) {
            const fn = Reflect.get(real, method);
            if (method !== 'findMany') return bound(real, fn);
            return args => {
              const key = `${table}:${JSON.stringify(args ?? {})}`;
              // Promise.resolve runs Prisma's lazy query once, now.
              if (!remembered.has(key)) remembered.set(key, Promise.resolve(fn.call(real, args)));
              return remembered.get(key);
            };
          },
        }));
      }
      return delegates.get(table);
    },
  });
}

// ─── AUTOMATION AFTER A WRITE ───

/** Run it now, or, inside a transaction, keep it for runAfter. */
async function automation(db, ctx, run) {
  if (Array.isArray(ctx.after)) {
    if (!ctx.prisma) throw new Error('A deferred write needs ctx.prisma to run its automation on once the transaction commits');
    ctx.after.push(() => run(ctx.prisma));
    return;
  }
  await run(ctx.prisma || db);
}

/** The automation a transaction kept back, once it has committed. */
async function runAfter(after) {
  for (const run of after.splice(0)) await run();
}

/**
 * File a record into security groups: the groups whose rules it matches, and
 * on create the auto-assigning groups of its owner. Both were configurable
 * and never ran, so a rule set to put new deals in a group left them open.
 * As with workflows, a failure here does not fail the write.
 */
async function assignSecurityGroups(prisma, moduleName, record, { onCreate }) {
  try {
    const { applyAutoAssignRules, autoAssignToUserGroups } = require('../middleware/rowSecurity');
    await applyAutoAssignRules(prisma, moduleName, record, { onCreate });
    const owner = record.ownerId || record.assignedId || record.createdById;
    if (onCreate && owner) await autoAssignToUserGroups(prisma, owner, moduleName, record.id);
  } catch (err) {
    logger.warn({ err, module: moduleName, recordId: record.id }, 'Security group assignment failed');
  }
}

async function fireWebhook(prisma, event, payload) {
  try {
    const { fireWebhookEvent } = require('./webhooks');
    await fireWebhookEvent(prisma, event, payload);
  } catch (e) { /* Webhooks are best-effort */ }
}

function sendRealtime(emit, method, ...args) {
  try { emit?.[method]?.(...args); } catch (e) { /* Real-time is best-effort */ }
}

const via = source => (source ? ` (${source})` : '');

// ─── CREATE ───

/**
 * Create a record of `moduleName` from `input`, its plain columns.
 * Returns { record, ignored, duplicates, assignment }; throws a
 * RecordWriteError when a rule refuses it.
 */
async function createRecord(db, moduleName, input, ctx = {}) {
  const { modelName, hooks } = moduleDefinition(moduleName);
  let data = { ...input };

  if (hooks.validate) {
    const { valid, errors } = hooks.validate(data);
    // The message names the fields: the pages show only `error`, which
    // said "Validation failed" and not what to fix.
    if (!valid) {
      const detail = Object.entries(errors || {}).map(([field, problem]) => `${field}: ${String(problem).toLowerCase()}`).join('; ');
      throw new RecordWriteError(400, { error: detail ? `Validation failed (${detail})` : 'Validation failed', errors });
    }
  }

  if (hooks.beforeCreate) data = await runHook(hooks.beforeCreate, data, hookContext(db, ctx));

  // Validation rules describe what is not allowed. They had admin screens and
  // a table and were read by nothing, so they validated nothing.
  const violations = await checkValidationRules(db, moduleName, data);
  if (violations.length) {
    throw new RecordWriteError(400, { error: violations[0].message, code: 'VALIDATION_RULE', violations });
  }

  // Duplicate rules likewise: configured, never consulted. A blocking rule
  // refuses; a warning rule lets the record through and says so.
  const duplicates = await findDuplicates(db, moduleName, data);
  const blocking = duplicates.filter(d => d.action === 'block');
  if (blocking.length) {
    throw new RecordWriteError(409, {
      error: `This looks like a duplicate of an existing ${moduleName.replace(/s$/, '')}.`,
      code: 'DUPLICATE_RECORD',
      duplicates: blocking,
    });
  }

  // Assignment rules pick an owner when the caller did not name one.
  const assignment = await applyAssignmentRules(db, moduleName, data);
  if (assignment) data = { ...data, ...assignment.fields };

  // Failing both, the creator owns what they create. Records were being
  // written with a null owner, so the ownership arm of row-level security
  // matched nobody and one rep could read and edit another rep's deals.
  for (const field of OWNERSHIP_FIELDS) {
    if (!modelHasField(modelName, field)) continue;
    if (!data[field] && ctx.userId) data[field] = ctx.userId;
    break;
  }
  // The creator is whoever made it; row security reads it as the owner of a
  // record with no owner column (a document).
  if (modelHasField(modelName, 'createdById') && ctx.userId) data.createdById = ctx.userId;

  // A key the model does not have would fail the write. Relation keys go
  // too; a module whose records take nested rows (order items) builds them
  // itself, from checked fields, in nestedWrites.
  const { data: picked, ignored } = pickModelFields(modelName, data);
  if (ctx.req) {
    const { linkRefusal } = require('../middleware/access');
    const problem = await linkRefusal(ctx.req, modelName, picked, null, ctx.linkCache);
    if (problem) throw new RecordWriteError(400, { error: problem, code: 'LINK_NOT_VISIBLE' });
  }
  const nested = ctx.nested || (hooks.nestedWrites && ctx.req ? await hooks.nestedWrites(ctx.req, 'create') : {});
  const createData = { ...picked, ...nested };
  const record = hooks.numbering
    ? await createNumbered(db, modelName, hooks.numbering, { data: createData, include: ctx.include })
    : await db[modelName].create({ data: createData, include: ctx.include });
  if (hooks.afterCreate) await hooks.afterCreate(record, hookContext(db, ctx));
  if (ctx.hydrate) await ctx.hydrate(record);

  await automation(db, ctx, async prisma => {
    await audit(prisma, { action: 'create', module: moduleName, recordId: record.id, details: `Created ${modelName}${via(ctx.source)}`, userId: ctx.userId || null });
    await assignSecurityGroups(prisma, moduleName, record, { onCreate: true });
    sendRealtime(emitterFor(ctx), 'recordCreated', moduleName, record);
    // Awaited so a rule's effects are in place before the caller sees the
    // record, and never thrown: automation must not fail the write itself.
    await runWorkflowsSafely(prisma, { module: moduleName, trigger: 'create', record, userId: ctx.userId || null });
    await fireWebhook(prisma, `${moduleName}.created`, { id: record.id, module: moduleName, data: record });
    if (duplicates.length) await recordDuplicates(prisma, moduleName, record.id, duplicates);
  });

  return { record, ignored, duplicates, assignment };
}

// ─── UPDATE ───

/**
 * Change a record: `target` is its id, or the record as it stands when the
 * caller has already read it. Returns { record, oldRecord, changes }.
 */
async function updateRecord(db, moduleName, target, input, ctx = {}) {
  const { modelName, hooks } = moduleDefinition(moduleName);
  const oldRecord = target && typeof target === 'object'
    ? target
    : await db[modelName].findUnique({ where: { id: String(target) } });
  // A record in the recycle bin is gone for editing, as it is for reading.
  if (!oldRecord || (softDeletes(modelName) && oldRecord.deletedAt)) {
    throw new RecordWriteError(404, { error: 'Not found' });
  }

  let data = { ...input };
  if (hooks.beforeUpdate) data = await runHook(hooks.beforeUpdate, data, hookContext(db, ctx, oldRecord));

  // Validate the record as it will be, not just the fields supplied.
  const violations = await checkValidationRules(db, moduleName, { ...oldRecord, ...data });
  if (violations.length) {
    throw new RecordWriteError(400, { error: violations[0].message, code: 'VALIDATION_RULE', violations });
  }

  const { data: updateData } = pickModelFields(modelName, data);
  // An empty Json column sent back empty is no change; leave it unwritten.
  for (const [key, value] of Object.entries(updateData)) {
    if (value === Prisma.DbNull && oldRecord[key] === null) delete updateData[key];
  }
  if (ctx.req) {
    const { linkRefusal } = require('../middleware/access');
    const problem = await linkRefusal(ctx.req, modelName, updateData, oldRecord, ctx.linkCache);
    if (problem) throw new RecordWriteError(400, { error: problem, code: 'LINK_NOT_VISIBLE' });
  }

  const record = await db[modelName].update({ where: { id: oldRecord.id }, data: { ...updateData, ...(ctx.nested || {}) }, include: ctx.include });
  if (hooks.afterUpdate) await hooks.afterUpdate(record, hookContext(db, ctx, oldRecord));
  if (ctx.hydrate) await ctx.hydrate(record);

  // Field-level audit, of the values written: the form sends the whole
  // record back as text, so diffing the body logged every number as changed.
  const changes = diffFields(oldRecord, updateData);
  // A status or stage move is its own trigger, so a rule does not have to
  // re-derive "did this change" from conditions.
  const moved = ['status', 'stage'].some(f => oldRecord[f] !== undefined && oldRecord[f] !== record[f]);

  await automation(db, ctx, async prisma => {
    await assignSecurityGroups(prisma, moduleName, record, { onCreate: false });
    if (changes.length) {
      await audit(prisma, { action: 'update', module: moduleName, recordId: record.id, details: `Updated ${modelName}${via(ctx.source)}: ${formatChanges(changes)}`, userId: ctx.userId || null });
    }
    sendRealtime(emitterFor(ctx), 'recordUpdated', moduleName, record);
    await runWorkflowsSafely(prisma, { module: moduleName, trigger: 'update', record, oldRecord, userId: ctx.userId || null });
    if (moved) await runWorkflowsSafely(prisma, { module: moduleName, trigger: 'statusChange', record, oldRecord, userId: ctx.userId || null });
    await fireWebhook(prisma, `${moduleName}.updated`, { id: record.id, module: moduleName, changes: changes.map(c => c.field) });
    if (oldRecord.stage !== undefined && oldRecord.stage !== record.stage) {
      await fireWebhook(prisma, `${moduleName}.stage_changed`, { id: record.id, module: moduleName, from: oldRecord.stage, to: record.stage });
    }
  });

  return { record, oldRecord, changes };
}

// ─── DELETE ───

/**
 * Delete a record: into the recycle bin where the model keeps deleted rows,
 * gone where it does not, with a recycle bin snapshot either way.
 * `target` is its id or the record. `ctx.alsoSet` is set with a soft delete
 * (a merged record's mergedIntoId). Returns the record as it was.
 */
async function deleteRecord(db, moduleName, target, ctx = {}) {
  const { modelName } = moduleDefinition(moduleName);
  const record = target && typeof target === 'object'
    ? target
    : await db[modelName].findUnique({ where: { id: String(target) } });
  // Not one already deleted: a second delete would file a second recycle bin
  // entry, whose restore then fails on the row that is there.
  if (!record || (softDeletes(modelName) && record.deletedAt)) {
    throw new RecordWriteError(404, { error: 'Not found' });
  }

  if (softDeletes(modelName)) {
    await db[modelName].update({ where: { id: record.id }, data: { deletedAt: new Date(), ...(ctx.alsoSet || {}) } });
  } else {
    await db[modelName].delete({ where: { id: record.id } });
  }

  // Recycle bin, 30-day retention.
  try {
    await db.recycleBinItem.create({
      data: {
        module: moduleName,
        recordId: record.id,
        recordData: record,
        deletedById: ctx.userId || null,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
  } catch (e) { /* The recycle bin is best-effort */ }

  await automation(db, ctx, async prisma => {
    await audit(prisma, { action: 'delete', module: moduleName, recordId: record.id, details: `Deleted ${modelName}${via(ctx.source)}`, userId: ctx.userId || null });
    sendRealtime(emitterFor(ctx), 'recordDeleted', moduleName, record.id);
    await fireWebhook(prisma, `${moduleName}.deleted`, { id: record.id, module: moduleName });
  });

  return record;
}

module.exports = {
  createRecord,
  updateRecord,
  deleteRecord,
  runAfter,
  batchClient,
  RecordWriteError,
  defineModule,
  moduleDefinition,
  isRecordModule,
};
