const { Router } = require('express');
const { authenticate, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere } = require('../middleware/access');
const { editableFields, scalarWhere, scalarSelect, modelHasField } = require('../utils/modelFields');
const { summaryRoute } = require('../utils/moduleStatus');
const { createRecord, updateRecord, deleteRecord, batchClient, RecordWriteError } = require('../services/recordWrites');
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
 *
 * Each record is written as one made on its own page is
 * (services/recordWrites): the module's rules and hooks, then its workflows
 * and webhooks. Inserts were a createMany, so a case or an order had no
 * number and failed, a row that clashed was dropped without a word, and no
 * rule saw any of it. A row a rule refuses fails on its own.
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
// timestamps or who owns it (editableFields). A new row's owner comes from the
// module's assignment rules, and failing them is the caller.
const PROTECTED = ['id', 'createdAt', 'updatedAt', 'deletedAt', 'ownerId', 'assignedId', 'createdById'];
const writable = editableFields;

/** One context for every record of a request: one link lookup each, one read of the rules. */
const batchOf = req => ({
  db: batchClient(req.app.locals.prisma),
  ctx: { req, userId: req.userId, source: 'bulk API', linkCache: new Map() },
});
/** A row's failure: a rule's refusal with its code, or what the database said. */
const failure = e => ({ error: e.message, ...(e instanceof RecordWriteError && e.code ? { code: e.code } : {}) });

// Bulk insert
router.post('/insert', async (req, res, next) => {
  try {
    const { module, records } = req.body || {};
    const model = target(req, res, module, 'edit');
    if (!model) return;
    if (!Array.isArray(records) || records.length > 10000) return res.status(400).json({ error: 'Max 10,000 records per batch' });
    const { db, ctx } = batchOf(req);
    const results = { success: 0, failed: 0, errors: [] };
    for (const [index, record] of records.entries()) {
      try {
        await createRecord(db, module, writable(model, record), ctx);
        results.success++;
      } catch (e) { results.failed++; results.errors.push({ index, ...failure(e) }); }
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
    const { db, ctx } = batchOf(req);
    const results = { success: 0, failed: 0, errors: [] };
    for (const record of records) {
      try {
        const id = record?.id ? String(record.id) : null;
        const current = id ? await db[model].findFirst({ where: await reachable(req, module, model, { id }, 'Edit') }) : null;
        if (!current) { results.failed++; results.errors.push({ id, error: 'Not found' }); continue; }
        await updateRecord(db, module, current, writable(model, record), ctx);
        results.success++;
      } catch (e) { results.failed++; results.errors.push({ id: record?.id, ...failure(e) }); }
    }
    res.json({ operation: 'update', module, ...results, total: records.length });
  } catch (err) { next(err); }
});

/** Match on one of the model's own columns, among rows the caller may change. */
async function upsertAll(req, module, model, records, matchField) {
  const { db, ctx } = batchOf(req);
  const results = { created: 0, updated: 0, failed: 0, errors: [] };
  const matchable = matchField && modelHasField(model, matchField) && !PROTECTED.includes(matchField) ? matchField : null;
  for (const record of records) {
    try {
      const value = matchable ? record?.[matchable] : undefined;
      const existing = value !== undefined && value !== null
        ? await db[model].findFirst({ where: await reachable(req, module, model, { [matchable]: value }, 'Edit') })
        : null;
      if (existing) { await updateRecord(db, module, existing, writable(model, record), ctx); results.updated++; }
      else { await createRecord(db, module, writable(model, record), ctx); results.created++; }
    } catch (e) { results.failed++; results.errors.push({ record: matchable ? record?.[matchable] : null, ...failure(e) }); }
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

// Bulk delete: only rows the caller may delete (full access, Full on the row),
// and a soft delete where the model has one, as every other delete is. Rows
// were removed outright, and one with dependent records failed the batch;
// then set deleted in one updateMany, with no recycle bin entry to restore
// them from and no delete webhook.
router.post('/delete', async (req, res, next) => {
  try {
    const { module, ids } = req.body || {};
    const model = target(req, res, module, 'full');
    if (!model) return;
    if (!Array.isArray(ids) || ids.length > 10000) return res.status(400).json({ error: 'Max 10,000 records per batch' });
    const live = modelHasField(model, 'deletedAt') ? { deletedAt: null } : {};
    const where = await reachable(req, module, model, { id: { in: ids.map(String) }, ...live }, 'Full');
    const { db, ctx } = batchOf(req);
    let deleted = 0;
    const errors = [];
    for (const record of await db[model].findMany({ where })) {
      try { await deleteRecord(db, module, record, ctx); deleted++; } catch (e) { errors.push({ id: record.id, ...failure(e) }); }
    }
    res.json({ operation: 'delete', module, deleted, total: ids.length, ...(errors.length ? { errors } : {}) });
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
