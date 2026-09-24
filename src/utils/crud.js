const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { validate } = require('../middleware/validate');
const { diffFields, formatChanges } = require('./integrity');
const { rowSecurity, applyAccessFilter } = require('../middleware/rowSecurity');
const { moduleAccess, recordAccess, reachableWhere, linkRefusal, visibleLinks } = require('../middleware/access');
const {
  pickModelFields, editableFields, modelHasField, resolveInclude, hydrateIncludes, looksLikeId,
  scalarWhere, scalarOrderBy,
} = require('./modelFields');
const { runWorkflowsSafely } = require('../services/workflowEngine');
const { createNumbered } = require('./numbering');
const {
  checkValidationRules, applyAssignmentRules, findDuplicates, recordDuplicates,
} = require('../services/recordRules');

// The model behind each CRUD module, for code outside its router that must
// check a record by module name (the WebSocket's record rooms).
const crudModels = new Map();
const crudModelFor = moduleName => crudModels.get(moduleName) || null;
/** The CRUD module whose records are this model's, or null. */
const crudModuleFor = modelName => {
  for (const [module, model] of crudModels) if (model.toLowerCase() === String(modelName).toLowerCase()) return module;
  return null;
};

/**
 * Creates a standard CRUD router for a Prisma model.
 * Enhanced with: field-level audit, optimistic locking, Prisma error handling, input validation.
 */
function createCrudRouter(modelName, moduleName, options = {}) {
  crudModels.set(moduleName, modelName);
  const router = Router();
  const {
    include: requestedInclude = {},
    searchFilter,
    beforeCreate,
    afterCreate,
    beforeUpdate,
    afterUpdate,
    validate,
    orderBy = { createdAt: 'desc' },
    customRoutes,
    // { field, prefix, width }: the record's human-readable number, which the
    // server assigns on create (see utils/numbering).
    numbering,
    // (req, 'create') => nested writes the router builds itself, from fields
    // it has checked; nothing nested comes from the request body.
    nestedWrites,
    // Columns only the module's own routes write (a document's stored file),
    // never taken from a request body.
    serverFields = [],
  } = options;

  // What the server sets and a request body never does: the id, the
  // timestamps, the soft-delete marker, who created the record, and the
  // module's serverFields. A chosen id need not look like one, and the record
  // check on /:id routes passes anything that does not; deletedAt let edit
  // permission delete, or restore, what DELETE needs full permission for.
  const SERVER_SET = ['id', 'createdAt', 'updatedAt', 'deletedAt', 'createdById', '_version', ...serverFields];
  const fromClient = body => {
    const data = { ...(body && typeof body === 'object' && !Array.isArray(body) ? body : {}) };
    for (const key of SERVER_SET) delete data[key];
    return data;
  };

  // Relations the model really has go to Prisma; `account` on a model with only
  // `accountId` is loaded separately, so the response keeps its shape.
  const { prismaInclude: include, manual: manualIncludes } = resolveInclude(modelName, requestedInclude);

  // Hand a non-id segment on to the module's own routes (`/count`, `/stats`).
  const idParam = (req, res, next) => (looksLikeId(modelName, req.params.id) ? next() : next('route'));

  // Apply auth + audit to all routes
  router.use(authenticate, auditMiddleware);

  // Every route here answers to the module's permission and row security,
  // the standard ones below and those a module adds (customRoutes, or routes
  // appended to the router it gets back). The added ones had authenticate()
  // alone, so a user with no access to deals could read a deal's timeline
  // and emails, merge and delete accounts, or edit another rep's line items.
  router.use(moduleAccess(moduleName));
  router.param('id', recordAccess(moduleName, modelName));

  const guard = (opts = {}) => rowSecurity(moduleName, { ...opts, modelName });

  // Not every model has a deletedAt column, and filtering on one that does not
  // exist makes the list and count queries throw. Only ask for it where it is.
  // Ownership column, in preference order: a model that has `ownerId` uses it;
  // one that only has `assignedId` uses that instead.
  const OWNERSHIP_FIELDS = ['ownerId', 'assignedId'];

  const softDeletes = modelHasField(modelName, 'deletedAt');
  const notDeleted = () => (softDeletes ? { deletedAt: null } : {});

  // LIST - GET /
  router.get('/', requirePermission(moduleName, 'read'), guard(), async (req, res, next) => {
    try {
      const prisma = req.app.locals.prisma;
      const { search, page = 1, limit = 50, sortBy, sortDir = 'desc', ...filters } = req.query;

      let where = { ...notDeleted() };

      if (search && searchFilter) {
        where = { ...where, ...searchFilter(search) };
      }

      // Filters on the record's own columns, with plain values. Any query key
      // went into the where clause, relations included, which reached the
      // columns of related records.
      const wanted = Object.fromEntries(Object.entries(filters).filter(([, value]) => value && value !== 'All'));
      // The filter panel sends a date range as <column>From / <column>To,
      // which are not columns, so the range was dropped and the list came back
      // unfiltered. They bound the column instead; a To date takes in its day.
      for (const key of Object.keys(wanted)) {
        const [, column, end] = /^(.+)(From|To)$/.exec(key) || [];
        if (!column || modelHasField(modelName, key) || typeof wanted[key] !== 'string') continue;
        const bound = end === 'To' && /^\d{4}-\d{2}-\d{2}$/.test(wanted[key]) ? `${wanted[key]}T23:59:59.999Z` : wanted[key];
        const range = wanted[column] && typeof wanted[column] === 'object' ? wanted[column] : {};
        wanted[column] = { ...range, [end === 'From' ? 'gte' : 'lte']: bound };
        delete wanted[key];
      }
      where = { ...where, ...scalarWhere(modelName, wanted) };

      const take = Math.min(parseInt(limit) || 50, 200); // Cap at 200
      const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

      // Restrict to what security groups allow. Without this every
      // authenticated user reads every record in the module.
      where = applyAccessFilter(where, req.accessFilter);

      const [records, total] = await Promise.all([
        prisma[modelName].findMany({
          where, include,
          orderBy: scalarOrderBy(modelName, sortBy, sortDir) || orderBy,
          skip, take,
        }),
        prisma[modelName].count({ where }),
      ]);

      await hydrateIncludes(prisma, records, manualIncludes);
      await visibleLinks(req, modelName, records, requestedInclude);
      res.json({
        data: records,
        meta: { total, page: parseInt(page), limit: take, pages: Math.ceil(total / take) },
      });
    } catch (err) { next(err); }
  });

  // GET ONE - GET /:id
  router.get('/:id', idParam, requirePermission(moduleName, 'read'), guard(), async (req, res, next) => {
    try {
      const prisma = req.app.locals.prisma;
      const record = await prisma[modelName].findFirst({
        where: { id: req.params.id, ...notDeleted() },
        include,
      });
      if (!record) return res.status(404).json({ error: 'Not found' });
      // 404 rather than 403: a record the caller may not see should not be
      // distinguishable from one that does not exist.
      if (req.canAccessRecord && !(await req.canAccessRecord(req.params.id, 'Read'))) {
        return res.status(404).json({ error: 'Not found' });
      }
      await hydrateIncludes(prisma, record, manualIncludes);
      await visibleLinks(req, modelName, record, requestedInclude);
      res.json(record);
    } catch (err) { next(err); }
  });

  // CREATE - POST /
  router.post('/', requirePermission(moduleName, 'edit'), async (req, res, next) => {
    try {
      const prisma = req.app.locals.prisma;
      let data = fromClient(req.body);

      if (validate) {
        const { valid, errors } = validate(data);
        if (!valid) return res.status(400).json({ error: 'Validation failed', errors });
      }

      if (beforeCreate) data = await beforeCreate(data, req);

      // Validation rules describe what is not allowed. They had admin screens
      // and a table and were read by nothing, so they validated nothing.
      const violations = await checkValidationRules(prisma, moduleName, data);
      if (violations.length) {
        return res.status(400).json({
          error: violations[0].message,
          code: 'VALIDATION_RULE',
          violations,
        });
      }

      // Duplicate rules likewise: configured, never consulted. A blocking rule
      // refuses; a warning rule lets the record through and says so.
      const duplicates = await findDuplicates(prisma, moduleName, data);
      const blocking = duplicates.filter(d => d.action === 'block');
      if (blocking.length) {
        return res.status(409).json({
          error: `This looks like a duplicate of an existing ${moduleName.replace(/s$/, '')}.`,
          code: 'DUPLICATE_RECORD',
          duplicates: blocking,
        });
      }

      // Assignment rules pick an owner when the caller did not name one.
      const assignment = await applyAssignmentRules(prisma, moduleName, data);
      if (assignment) data = { ...data, ...assignment.fields };

      // Failing both, the creator owns what they create. Records were being
      // written with a null owner, so the ownership arm of row-level security
      // matched nobody and one rep could read and edit another rep's deals.
      for (const field of OWNERSHIP_FIELDS) {
        if (!modelHasField(modelName, field)) continue;
        if (!data[field] && req.userId) data[field] = req.userId;
        break;
      }
      // The creator is whoever made it; row security reads it as the owner
      // of a record with no owner column (a document).
      if (modelHasField(modelName, 'createdById') && req.userId) data.createdById = req.userId;

      // A key the model does not have used to 500 the whole request. Relation
      // keys go too; a router whose records take nested rows (order items)
      // builds them itself, from checked fields, in nestedWrites.
      const { data: pickedData, ignored } = pickModelFields(modelName, data);
      const linkProblem = await linkRefusal(req, modelName, pickedData);
      if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
      const createData = nestedWrites ? { ...pickedData, ...(await nestedWrites(req, 'create')) } : pickedData;
      const record = numbering
        ? await createNumbered(prisma, modelName, numbering, { data: createData, include })
        : await prisma[modelName].create({ data: createData, include });
      await hydrateIncludes(prisma, record, manualIncludes);

      await req.audit({ action: 'create', module: moduleName, recordId: record.id, details: `Created ${modelName}` });

      // Emit real-time event
      if (req.app.locals.emit?.recordCreated) {
        req.app.locals.emit.recordCreated(moduleName, record);
      }

      if (afterCreate) await afterCreate(record, req);

      // Fire the rules for this module. Nothing used to call the engine, so a
      // workflow could be enabled and never run. Awaited so a rule's effects
      // are in place before the caller sees the record, and swallowed so
      // automation can never fail the write itself.
      await runWorkflowsSafely(prisma, { module: moduleName, trigger: 'create', record, userId: req.userId });

      // Fire webhook
      try {
        const { fireWebhookEvent } = require('../services/webhooks');
        await fireWebhookEvent(prisma, `${moduleName}.created`, { id: record.id, module: moduleName, data: record });
      } catch (e) { /* Webhook is best-effort */ }

      if (duplicates.length) await recordDuplicates(prisma, moduleName, record.id, duplicates);

      const warnings = [];
      if (ignored.length) warnings.push(`Ignored unknown field(s): ${ignored.join(', ')}`);
      if (duplicates.length) warnings.push(`Possible duplicate of ${duplicates.length} existing record(s).`);

      // Linked records as far as the caller may see them (visibleLinks), in
      // the response only: hooks and workflows above had the record whole.
      const body = { ...record };
      await visibleLinks(req, modelName, body, requestedInclude);
      res.status(201).json({
        ...body,
        ...(warnings.length ? { warnings } : {}),
        ...(duplicates.length ? { duplicates } : {}),
        ...(assignment ? { assignedBy: assignment.rule } : {}),
      });
    } catch (err) { next(err); }
  });

  // UPDATE - PUT /:id
  router.put('/:id', idParam, requirePermission(moduleName, 'edit'), guard({ minLevel: 'Edit' }), async (req, res, next) => {
    try {
      const prisma = req.app.locals.prisma;
      let data = fromClient(req.body);

      // Optimistic locking check
      const expectedVersion = req.body._version || req.headers['if-match'];
      if (expectedVersion) {
        const current = await prisma[modelName].findUnique({ where: { id: req.params.id }, select: { updatedAt: true } });
        if (current && current.updatedAt.toISOString() !== expectedVersion) {
          return res.status(409).json({
            error: 'Record has been modified by another user',
            code: 'CONFLICT',
            currentVersion: current.updatedAt.toISOString(),
          });
        }
      }

      // Get old record for field-level audit
      const oldRecord = await prisma[modelName].findUnique({ where: { id: req.params.id } });
      if (!oldRecord) return res.status(404).json({ error: 'Not found' });
      if (req.canAccessRecord && !(await req.canAccessRecord(req.params.id, 'Edit'))) {
        return res.status(404).json({ error: 'Not found' });
      }

      if (beforeUpdate) data = await beforeUpdate(data, req);

      // Validate the record as it will be, not just the fields supplied.
      const updateViolations = await checkValidationRules(prisma, moduleName, { ...oldRecord, ...data });
      if (updateViolations.length) {
        return res.status(400).json({
          error: updateViolations[0].message,
          code: 'VALIDATION_RULE',
          violations: updateViolations,
        });
      }

      const { data: updateData } = pickModelFields(modelName, data);
      const linkProblem = await linkRefusal(req, modelName, updateData, oldRecord);
      if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
      const record = await prisma[modelName].update({
        where: { id: req.params.id },
        data: updateData,
        include,
      });
      await hydrateIncludes(prisma, record, manualIncludes);

      // Field-level audit, of the values written: the form sends the whole
      // record back as text, so diffing the body logged every number as changed.
      const changes = diffFields(oldRecord, updateData);
      if (changes.length > 0) {
        await req.audit({
          action: 'update', module: moduleName, recordId: record.id,
          details: `Updated ${modelName}: ${formatChanges(changes)}`,
        });
      }

      if (req.app.locals.emit?.recordUpdated) {
        req.app.locals.emit.recordUpdated(moduleName, record);
      }

      if (afterUpdate) await afterUpdate(record, req);

      await runWorkflowsSafely(prisma, { module: moduleName, trigger: 'update', record, oldRecord, userId: req.userId });

      // A status or stage move is its own trigger, so a rule does not have to
      // re-derive "did this change" from conditions.
      const movedStage = ['status', 'stage'].some(f => oldRecord[f] !== undefined && oldRecord[f] !== record[f]);
      if (movedStage) {
        await runWorkflowsSafely(prisma, { module: moduleName, trigger: 'statusChange', record, oldRecord, userId: req.userId });
      }

      // Fire webhook
      try {
        const { fireWebhookEvent } = require('../services/webhooks');
        await fireWebhookEvent(prisma, `${moduleName}.updated`, { id: record.id, module: moduleName, changes: changes.map(c => c.field) });
      } catch (e) { /* Webhook is best-effort */ }

      // As for create: linked records as the caller may see them, in the response only.
      const body = { ...record };
      await visibleLinks(req, modelName, body, requestedInclude);
      res.json(body);
    } catch (err) { next(err); }
  });

  // DELETE - DELETE /:id
  router.delete('/:id', idParam, requirePermission(moduleName, 'full'), guard({ minLevel: 'Full' }), async (req, res, next) => {
    try {
      const prisma = req.app.locals.prisma;

      // Snapshot record before delete for recycle bin
      const record = await prisma[modelName].findUnique({ where: { id: req.params.id } });
      if (!record) return res.status(404).json({ error: 'Not found' });
      if (req.canAccessRecord && !(await req.canAccessRecord(req.params.id, 'Full'))) {
        return res.status(404).json({ error: 'Not found' });
      }

      // Soft delete where the model supports it; otherwise remove the row.
      // The recycle bin snapshot below covers both cases.
      if (softDeletes) {
        await prisma[modelName].update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
      } else {
        await prisma[modelName].delete({ where: { id: req.params.id } });
      }

      // Send to recycle bin (30-day retention)
      try {
        await prisma.recycleBinItem.create({
          data: {
            module: moduleName,
            recordId: req.params.id,
            recordData: record,
            deletedById: req.userId,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        });
      } catch (e) { /* Recycle bin is best-effort */ }

      await req.audit({ action: 'delete', module: moduleName, recordId: req.params.id, details: `Deleted ${modelName}` });

      if (req.app.locals.emit?.recordDeleted) {
        req.app.locals.emit.recordDeleted(moduleName, req.params.id);
      }

      // Fire webhook
      try {
        const { fireWebhookEvent } = require('../services/webhooks');
        await fireWebhookEvent(prisma, `${moduleName}.deleted`, { id: req.params.id, module: moduleName });
      } catch (e) { /* Webhook is best-effort */ }

      res.json({ success: true });
    } catch (err) { next(err); }
  });

  // BULK DELETE - POST /bulk-delete
  // Only rows the caller could delete one at a time. This deleted whatever
  // ids it was sent, other reps' records included.
  router.post('/bulk-delete', requirePermission(moduleName, 'full'), async (req, res, next) => {
    try {
      const prisma = req.app.locals.prisma;
      const { ids } = req.body;
      if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
      if (ids.length > 100) return res.status(400).json({ error: 'Maximum 100 records per bulk operation' });

      const where = await reachableWhere(req, moduleName, modelName, { id: { in: ids.map(String) } }, 'Full');
      const result = await prisma[modelName].deleteMany({ where });
      await req.audit({ action: 'delete', module: moduleName, details: `Bulk deleted ${result.count} ${moduleName}` });
      res.json({ success: true, deleted: result.count });
    } catch (err) { next(err); }
  });

  // BULK UPDATE - POST /bulk-update
  // The record's own plain columns, on rows the caller could edit one at a
  // time. The body went to updateMany whole, on any ids: another rep's
  // records, who owns them, a document's stored file path.
  router.post('/bulk-update', requirePermission(moduleName, 'edit'), async (req, res, next) => {
    try {
      const prisma = req.app.locals.prisma;
      const { ids, data } = req.body;
      if (!ids || !Array.isArray(ids) || !data || typeof data !== 'object') return res.status(400).json({ error: 'ids array and data required' });
      if (ids.length > 100) return res.status(400).json({ error: 'Maximum 100 records per bulk operation' });

      const changes = editableFields(modelName, fromClient(data));
      if (!Object.keys(changes).length) return res.status(400).json({ error: 'No fields in data that a bulk update may change' });
      const linkProblem = await linkRefusal(req, modelName, changes);
      if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });

      const where = await reachableWhere(req, moduleName, modelName, { id: { in: ids.map(String) } }, 'Edit');
      const result = await prisma[modelName].updateMany({ where, data: changes });
      await req.audit({ action: 'update', module: moduleName, details: `Bulk updated ${result.count} ${moduleName}` });
      res.json({ success: true, updated: result.count });
    } catch (err) { next(err); }
  });

  // Add custom routes if provided
  if (customRoutes) customRoutes(router);

  return router;
}

module.exports = { createCrudRouter, crudModelFor, crudModuleFor };
