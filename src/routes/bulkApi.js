const { Router } = require('express');
const { authenticate, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere } = require('../middleware/access');
const { editableFields, scalarWhere, scalarSelect, modelHasField } = require('../utils/modelFields');
const { summaryRoute } = require('../utils/moduleStatus');
const router = Router();
router.use(authenticate);

const MODEL_MAP = {
  contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account',
  activities: 'activity', cases: 'case', products: 'product', quotes: 'quote',
  invoices: 'invoice', campaigns: 'campaign', contracts: 'contract', orders: 'order',
  entitlements: 'entitlement',
};

/*
 * Every operation here used to need only a session: anyone signed in could
 * read, write and hard-delete whole tables across thirteen modules, with any
 * columns, owners included. Each now takes the module's permission (read to
 * query, edit to write, full to delete) and reaches only rows the caller's
 * row security allows.
 */

/** The model for a module the caller may act on at `level`; otherwise it answers and returns null. */
function target(req, res, module, level) {
  const model = MODEL_MAP[module];
  if (!model) { res.status(400).json({ error: `Invalid module: ${module}` }); return null; }
  if (!permits(req, module, level)) { res.status(403).json({ error: `Insufficient permissions for ${module}` }); return null; }
  return model;
}

const reachable = reachableWhere;

// What a bulk write may set: the model's own columns, not its identity, its
// timestamps or who owns it (editableFields). New rows belong to the caller.
const PROTECTED = ['id', 'createdAt', 'updatedAt', 'deletedAt', 'ownerId', 'assignedId', 'createdById'];
const writable = editableFields;
const ownedByCaller = (model, data, req) => (modelHasField(model, 'ownerId') ? { ...data, ownerId: req.userId } : data);

// Bulk insert
router.post('/insert', async (req, res, next) => {
  try {
    const { module, records } = req.body || {};
    const model = target(req, res, module, 'edit');
    if (!model) return;
    if (!Array.isArray(records) || records.length > 10000) return res.status(400).json({ error: 'Max 10,000 records per batch' });
    const prisma = req.app.locals.prisma;
    const results = { success: 0, failed: 0, errors: [] };
    // Process in chunks of 500
    for (let i = 0; i < records.length; i += 500) {
      const chunk = records.slice(i, i + 500).map(r => ownedByCaller(model, writable(model, r), req));
      try {
        const created = await prisma[model].createMany({ data: chunk, skipDuplicates: true });
        results.success += created.count;
      } catch (e) {
        results.failed += chunk.length;
        results.errors.push({ batch: Math.floor(i / 500), error: e.message });
      }
    }
    res.json({ operation: 'insert', module, ...results, total: records.length });
  } catch (err) { next(err); }
});

// Bulk update: only rows the caller may change.
router.post('/update', async (req, res, next) => {
  try {
    const { module, records } = req.body || {};
    const model = target(req, res, module, 'edit');
    if (!model) return;
    if (!Array.isArray(records) || records.length > 10000) return res.status(400).json({ error: 'Max 10,000 records per batch' });
    const prisma = req.app.locals.prisma;
    const results = { success: 0, failed: 0, errors: [] };
    for (const record of records) {
      try {
        const id = record?.id ? String(record.id) : null;
        const { count } = id
          ? await prisma[model].updateMany({ where: await reachable(req, module, model, { id }, 'Edit'), data: writable(model, record) })
          : { count: 0 };
        if (count) results.success++;
        else { results.failed++; results.errors.push({ id, error: 'Not found' }); }
      } catch (e) { results.failed++; results.errors.push({ id: record?.id, error: e.message }); }
    }
    res.json({ operation: 'update', module, ...results, total: records.length });
  } catch (err) { next(err); }
});

/** Match on one of the model's own columns, among rows the caller may change. */
async function upsertAll(req, module, model, records, matchField) {
  const prisma = req.app.locals.prisma;
  const results = { created: 0, updated: 0, failed: 0, errors: [] };
  const matchable = matchField && modelHasField(model, matchField) && !PROTECTED.includes(matchField) ? matchField : null;
  for (const record of records) {
    try {
      const value = matchable ? record?.[matchable] : undefined;
      const existing = value !== undefined && value !== null
        ? await prisma[model].findFirst({ where: await reachable(req, module, model, { [matchable]: value }, 'Edit'), select: { id: true } })
        : null;
      if (existing) { await prisma[model].update({ where: { id: existing.id }, data: writable(model, record) }); results.updated++; }
      else { await prisma[model].create({ data: ownedByCaller(model, writable(model, record), req) }); results.created++; }
    } catch (e) { results.failed++; results.errors.push({ record: matchable ? record?.[matchable] : null, error: e.message }); }
  }
  return results;
}

// Bulk upsert
router.post('/upsert', async (req, res, next) => {
  try {
    const { module, records, matchField } = req.body || {};
    const model = target(req, res, module, 'edit');
    if (!model) return;
    const list = Array.isArray(records) ? records.slice(0, 10000) : [];
    const results = await upsertAll(req, module, model, list, matchField);
    res.json({ operation: 'upsert', module, ...results, total: list.length });
  } catch (err) { next(err); }
});

// Bulk delete: only rows the caller may change, and only with full access.
router.post('/delete', async (req, res, next) => {
  try {
    const { module, ids } = req.body || {};
    const model = target(req, res, module, 'full');
    if (!model) return;
    if (!Array.isArray(ids) || ids.length > 10000) return res.status(400).json({ error: 'Max 10,000 records per batch' });
    const where = await reachable(req, module, model, { id: { in: ids.map(String) } }, 'Edit');
    const deleted = await req.app.locals.prisma[model].deleteMany({ where });
    res.json({ operation: 'delete', module, deleted: deleted.count, total: ids.length });
  } catch (err) { next(err); }
});

// Bulk query: the caller's own columns and plain filters, over rows they can see.
router.post('/query', async (req, res, next) => {
  try {
    const { module, where, select, fields, limit = 10000, offset = 0 } = req.body || {};
    const model = target(req, res, module, 'read');
    if (!model) return;
    const records = await req.app.locals.prisma[model].findMany({
      where: await reachable(req, module, model, scalarWhere(model, where), 'Read'),
      select: scalarSelect(model, fields || select),
      take: Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 50000),
      skip: Math.max(parseInt(offset, 10) || 0, 0),
      orderBy: { createdAt: 'desc' },
    });
    res.json({ module, count: records.length, offset: Math.max(parseInt(offset, 10) || 0, 0), data: records });
  } catch (err) { next(err); }
});

module.exports = router;

// Bulk upsert
router.post('/upsert/:module', async (req, res, next) => {
  try {
    const { module } = req.params;
    const { records, matchField = 'email' } = req.body || {};
    if (!Array.isArray(records) || !records.length) return res.status(400).json({ error: 'records required' });
    const model = target(req, res, module, 'edit');
    if (!model) return;
    const list = records.slice(0, 1000);
    const { created, updated, failed } = await upsertAll(req, module, model, list, matchField);
    res.json({ module, total: records.length, created, updated, errors: failed });
  } catch (err) { next(err); }
});

// Job status
router.get('/jobs/:jobId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const job = await prisma.bulkJob.findUnique({ where: { id: req.params.jobId } }).catch(() => null);
    if (!job) return res.json({ jobId: req.params.jobId, status: 'not_found' });
    res.json(job);
  } catch (err) { next(err); }
});

// Totals from the module's own table.
summaryRoute(router, { module: 'bulk', model: 'bulkJob' });

// Bulk status update
router.post('/bulk/status', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { ids, status } = req.body;
    if (!ids?.length || !status) return res.status(400).json({ error: 'ids and status required' });
    const updated = await Promise.all(ids.slice(0, 100).map(async (id) => {
      try { return await prisma.$executeRaw`UPDATE "bulkApi" SET status = ${status} WHERE id = ${id}`; }
      catch (e) { return null; }
    }));
    await req.audit({ action: 'bulk_update', module: 'bulkApi', details: `Bulk status update: ${ids.length} records to ${status}` });
    res.json({ updated: updated.filter(Boolean).length, requested: ids.length });
  } catch (err) { next(err); }
});
