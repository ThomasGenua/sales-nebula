const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { validate } = require('../middleware/validate');
const { diffFields, formatChanges } = require('./integrity');
const { rowSecurity, applyAccessFilter } = require('../middleware/rowSecurity');

/**
 * Creates a standard CRUD router for a Prisma model.
 * Enhanced with: field-level audit, optimistic locking, Prisma error handling, input validation.
 */
function createCrudRouter(modelName, moduleName, options = {}) {
  const router = Router();
  const {
    include = {},
    searchFilter,
    beforeCreate,
    afterCreate,
    beforeUpdate,
    afterUpdate,
    validate,
    orderBy = { createdAt: 'desc' },
    customRoutes,
  } = options;

  // Apply auth + audit to all routes
  router.use(authenticate, auditMiddleware);

  const guard = (opts = {}) => rowSecurity(moduleName, { ...opts, modelName });

  // LIST - GET /
  router.get('/', requirePermission(moduleName, 'read'), guard(), async (req, res, next) => {
    try {
      const prisma = req.app.locals.prisma;
      const { search, page = 1, limit = 50, sortBy, sortDir = 'desc', ...filters } = req.query;

      let where = { deletedAt: null };

      if (search && searchFilter) {
        where = { ...where, ...searchFilter(search) };
      }

      Object.entries(filters).forEach(([key, value]) => {
        if (value && value !== 'All') {
          where[key] = value;
        }
      });

      const take = Math.min(parseInt(limit) || 50, 200); // Cap at 200
      const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

      // Restrict to what security groups allow. Without this every
      // authenticated user reads every record in the module.
      where = applyAccessFilter(where, req.accessFilter);

      const [records, total] = await Promise.all([
        prisma[modelName].findMany({
          where, include,
          orderBy: sortBy ? { [sortBy]: sortDir } : orderBy,
          skip, take,
        }),
        prisma[modelName].count({ where }),
      ]);

      res.json({
        data: records,
        meta: { total, page: parseInt(page), limit: take, pages: Math.ceil(total / take) },
      });
    } catch (err) { next(err); }
  });

  // GET ONE - GET /:id
  router.get('/:id', requirePermission(moduleName, 'read'), guard(), async (req, res, next) => {
    try {
      const prisma = req.app.locals.prisma;
      const record = await prisma[modelName].findFirst({
        where: { id: req.params.id, deletedAt: null },
        include,
      });
      if (!record) return res.status(404).json({ error: 'Not found' });
      // 404 rather than 403: a record the caller may not see should not be
      // distinguishable from one that does not exist.
      if (req.canAccessRecord && !(await req.canAccessRecord(req.params.id, 'Read'))) {
        return res.status(404).json({ error: 'Not found' });
      }
      res.json(record);
    } catch (err) { next(err); }
  });

  // CREATE - POST /
  router.post('/', requirePermission(moduleName, 'edit'), async (req, res, next) => {
    try {
      const prisma = req.app.locals.prisma;
      let data = { ...req.body };

      if (validate) {
        const { valid, errors } = validate(data);
        if (!valid) return res.status(400).json({ error: 'Validation failed', errors });
      }

      if (beforeCreate) data = await beforeCreate(data, req);

      const record = await prisma[modelName].create({ data, include });

      await req.audit({ action: 'create', module: moduleName, recordId: record.id, details: `Created ${modelName}` });

      // Emit real-time event
      if (req.app.locals.emit?.recordCreated) {
        req.app.locals.emit.recordCreated(moduleName, record);
      }

      if (afterCreate) await afterCreate(record, req);

      // Fire webhook
      try {
        const { fireWebhookEvent } = require('../services/webhooks');
        await fireWebhookEvent(prisma, `${moduleName}.created`, { id: record.id, module: moduleName, data: record });
      } catch (e) { /* Webhook is best-effort */ }

      res.status(201).json(record);
    } catch (err) { next(err); }
  });

  // UPDATE - PUT /:id
  router.put('/:id', requirePermission(moduleName, 'edit'), guard({ minLevel: 'Edit' }), async (req, res, next) => {
    try {
      const prisma = req.app.locals.prisma;
      let data = { ...req.body };

      // Strip protected fields
      delete data.id;
      delete data.createdAt;
      delete data.updatedAt;
      delete data._version;

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

      const record = await prisma[modelName].update({
        where: { id: req.params.id },
        data,
        include,
      });

      // Field-level audit
      const changes = diffFields(oldRecord, data);
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

      // Fire webhook
      try {
        const { fireWebhookEvent } = require('../services/webhooks');
        await fireWebhookEvent(prisma, `${moduleName}.updated`, { id: record.id, module: moduleName, changes: changes.map(c => c.field) });
      } catch (e) { /* Webhook is best-effort */ }

      res.json(record);
    } catch (err) { next(err); }
  });

  // DELETE - DELETE /:id
  router.delete('/:id', requirePermission(moduleName, 'full'), guard({ minLevel: 'Full' }), async (req, res, next) => {
    try {
      const prisma = req.app.locals.prisma;

      // Snapshot record before delete for recycle bin
      const record = await prisma[modelName].findUnique({ where: { id: req.params.id } });
      if (!record) return res.status(404).json({ error: 'Not found' });
      if (req.canAccessRecord && !(await req.canAccessRecord(req.params.id, 'Full'))) {
        return res.status(404).json({ error: 'Not found' });
      }

      // Soft delete
      await prisma[modelName].update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });

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
  router.post('/bulk-delete', requirePermission(moduleName, 'full'), async (req, res, next) => {
    try {
      const prisma = req.app.locals.prisma;
      const { ids } = req.body;
      if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
      if (ids.length > 100) return res.status(400).json({ error: 'Maximum 100 records per bulk operation' });

      const result = await prisma[modelName].deleteMany({ where: { id: { in: ids } } });
      await req.audit({ action: 'delete', module: moduleName, details: `Bulk deleted ${result.count} ${moduleName}` });
      res.json({ success: true, deleted: result.count });
    } catch (err) { next(err); }
  });

  // BULK UPDATE - POST /bulk-update
  router.post('/bulk-update', requirePermission(moduleName, 'edit'), async (req, res, next) => {
    try {
      const prisma = req.app.locals.prisma;
      const { ids, data } = req.body;
      if (!ids || !Array.isArray(ids) || !data) return res.status(400).json({ error: 'ids array and data required' });
      if (ids.length > 100) return res.status(400).json({ error: 'Maximum 100 records per bulk operation' });

      // Strip dangerous fields
      delete data.id; delete data.createdAt; delete data.updatedAt; delete data.password;

      const result = await prisma[modelName].updateMany({ where: { id: { in: ids } }, data });
      await req.audit({ action: 'update', module: moduleName, details: `Bulk updated ${result.count} ${moduleName}` });
      res.json({ success: true, updated: result.count });
    } catch (err) { next(err); }
  });

  // Add custom routes if provided
  if (customRoutes) customRoutes(router);

  return router;
}

module.exports = { createCrudRouter };
