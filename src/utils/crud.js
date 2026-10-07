const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { rowSecurity, applyAccessFilter } = require('../middleware/rowSecurity');
const { moduleAccess, recordAccess, reachableWhere, linkRefusal, visibleLinks } = require('../middleware/access');
const {
  editableFields, modelHasField, resolveInclude, hydrateIncludes, looksLikeId,
  scalarWhere, scalarOrderBy,
} = require('./modelFields');
const {
  createRecord, updateRecord, deleteRecord, RecordWriteError, defineModule, batchClient,
} = require('../services/recordWrites');

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
 *
 * The module's hooks are its rules for every write, wherever it comes from:
 * they are handed to services/recordWrites, which the routes below and every
 * other path that writes these records go through. Each takes the data or
 * record and a context of { prisma, userId, req, oldRecord, emit, source };
 * `req` is null for a write that did not come from a request (inbound mail,
 * a job), and `source` says what made it ('import', 'escalated').
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
  defineModule(moduleName, modelName, { validate, beforeCreate, afterCreate, beforeUpdate, afterUpdate, numbering, nestedWrites });

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
      // Live records only, whatever the filters say: a filter on deletedAt
      // (?deletedAt[gte]=..., ?deletedAtFrom=...) replaced this condition and
      // listed deleted records, which only the recycle bin should show.
      where = { ...where, ...scalarWhere(modelName, wanted), ...notDeleted() };

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
      const { record, ignored, duplicates, assignment } = await createRecord(prisma, moduleName, fromClient(req.body), {
        req, userId: req.userId, include, hydrate: created => hydrateIncludes(prisma, created, manualIncludes),
      });

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
      const data = fromClient(req.body);

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
      // A record in the recycle bin is gone for editing, as it is for GET: this
      // saved an edit to it and answered 200, so a stale tab reported a save of
      // something that no longer showed anywhere.
      if (!oldRecord || (softDeletes && oldRecord.deletedAt)) return res.status(404).json({ error: 'Not found' });
      if (req.canAccessRecord && !(await req.canAccessRecord(req.params.id, 'Edit'))) {
        return res.status(404).json({ error: 'Not found' });
      }

      const { record } = await updateRecord(prisma, moduleName, oldRecord, data, {
        req, userId: req.userId, include, hydrate: updated => hydrateIncludes(prisma, updated, manualIncludes),
      });

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
      // Not one already deleted: a second delete answered 200 and filed a second
      // recycle bin entry, whose restore then failed on the row that is there.
      if (!record || (softDeletes && record.deletedAt)) return res.status(404).json({ error: 'Not found' });
      if (req.canAccessRecord && !(await req.canAccessRecord(req.params.id, 'Full'))) {
        return res.status(404).json({ error: 'Not found' });
      }

      // Soft where the model keeps deleted rows, with a recycle bin entry
      // either way.
      await deleteRecord(prisma, moduleName, record, { req, userId: req.userId });

      res.json({ success: true });
    } catch (err) { next(err); }
  });

  // Each record of a bulk change goes through the same write as one at a time,
  // so the module's rules, workflows and webhooks see it, and a deleted one
  // goes to the recycle bin. These were one deleteMany and one updateMany:
  // nothing fired, a bulk delete was permanent where a single one is not, and
  // a rule that refused a value let a bulk update write it. A record a rule
  // refuses is left as it was and reported in `failed`.
  const eachReachable = async (req, ids, level, write) => {
    const prisma = req.app.locals.prisma;
    const where = await reachableWhere(req, moduleName, modelName, { id: { in: ids.map(String) }, ...notDeleted() }, level);
    const records = await prisma[modelName].findMany({ where });
    const db = batchClient(prisma);
    let done = 0;
    const failed = [];
    for (const record of records) {
      try {
        await write(db, record);
        done++;
      } catch (err) {
        if (!(err instanceof RecordWriteError)) throw err;
        failed.push({ id: record.id, error: err.body.error, ...(err.code ? { code: err.code } : {}) });
      }
    }
    return { done, failed };
  };

  // BULK DELETE - POST /bulk-delete
  // Only rows the caller could delete one at a time. This deleted whatever
  // ids it was sent, other reps' records included.
  router.post('/bulk-delete', requirePermission(moduleName, 'full'), async (req, res, next) => {
    try {
      const { ids } = req.body;
      if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
      if (ids.length > 100) return res.status(400).json({ error: 'Maximum 100 records per bulk operation' });

      const { done, failed } = await eachReachable(req, ids, 'Full',
        (prisma, record) => deleteRecord(prisma, moduleName, record, { req, userId: req.userId, source: 'bulk delete' }));
      res.json({ success: true, deleted: done, ...(failed.length ? { failed } : {}) });
    } catch (err) { next(err); }
  });

  // BULK UPDATE - POST /bulk-update
  // The record's own plain columns, on rows the caller could edit one at a
  // time. The body went to updateMany whole, on any ids: another rep's
  // records, who owns them, a document's stored file path.
  router.post('/bulk-update', requirePermission(moduleName, 'edit'), async (req, res, next) => {
    try {
      const { ids, data } = req.body;
      if (!ids || !Array.isArray(ids) || !data || typeof data !== 'object') return res.status(400).json({ error: 'ids array and data required' });
      if (ids.length > 100) return res.status(400).json({ error: 'Maximum 100 records per bulk operation' });

      const changes = editableFields(modelName, fromClient(data));
      if (!Object.keys(changes).length) return res.status(400).json({ error: 'No fields in data that a bulk update may change' });
      const linkProblem = await linkRefusal(req, modelName, changes);
      if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });

      const { done, failed } = await eachReachable(req, ids, 'Edit',
        (prisma, record) => updateRecord(prisma, moduleName, record, changes, { req, userId: req.userId, source: 'bulk update' }));
      res.json({ success: true, updated: done, ...(failed.length ? { failed } : {}) });
    } catch (err) { next(err); }
  });

  // Add custom routes if provided
  if (customRoutes) customRoutes(router);

  return router;
}

module.exports = { createCrudRouter, crudModelFor, crudModuleFor };
