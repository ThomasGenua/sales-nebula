const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { summaryRoute } = require('../utils/moduleStatus');
const router = Router();
router.use(authenticate);

const MODEL_MAP = {
  contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account',
  activities: 'activity', cases: 'case', products: 'product', quotes: 'quote',
  invoices: 'invoice', campaigns: 'campaign', contracts: 'contract', orders: 'order',
  entitlements: 'entitlement',
};

// Bulk insert
router.post('/insert', async (req, res, next) => {
  try {
    const { module, records } = req.body;
    if (!MODEL_MAP[module]) return res.status(400).json({ error: `Invalid module: ${module}` });
    if (!records || records.length > 10000) return res.status(400).json({ error: 'Max 10,000 records per batch' });
    const prisma = req.app.locals.prisma;
    const model = MODEL_MAP[module];
    const results = { success: 0, failed: 0, errors: [] };
    // Process in chunks of 500
    for (let i = 0; i < records.length; i += 500) {
      const chunk = records.slice(i, i + 500);
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

// Bulk update
router.post('/update', async (req, res, next) => {
  try {
    const { module, records } = req.body;
    if (!MODEL_MAP[module]) return res.status(400).json({ error: `Invalid module: ${module}` });
    if (!records || records.length > 10000) return res.status(400).json({ error: 'Max 10,000 records per batch' });
    const prisma = req.app.locals.prisma;
    const model = MODEL_MAP[module];
    const results = { success: 0, failed: 0, errors: [] };
    for (const record of records) {
      try {
        const { id, ...data } = record;
        await prisma[model].update({ where: { id }, data });
        results.success++;
      } catch (e) { results.failed++; results.errors.push({ id: record.id, error: e.message }); }
    }
    res.json({ operation: 'update', module, ...results, total: records.length });
  } catch (err) { next(err); }
});

// Bulk upsert
router.post('/upsert', async (req, res, next) => {
  try {
    const { module, records, matchField } = req.body;
    if (!MODEL_MAP[module]) return res.status(400).json({ error: `Invalid module: ${module}` });
    const prisma = req.app.locals.prisma;
    const model = MODEL_MAP[module];
    const results = { created: 0, updated: 0, failed: 0, errors: [] };
    for (const record of (records || [])) {
      try {
        const existing = matchField ? await prisma[model].findFirst({ where: { [matchField]: record[matchField] } }) : null;
        if (existing) { await prisma[model].update({ where: { id: existing.id }, data: record }); results.updated++; }
        else { await prisma[model].create({ data: record }); results.created++; }
      } catch (e) { results.failed++; results.errors.push({ record: record[matchField], error: e.message }); }
    }
    res.json({ operation: 'upsert', module, ...results, total: (records || []).length });
  } catch (err) { next(err); }
});

// Bulk delete
router.post('/delete', async (req, res, next) => {
  try {
    const { module, ids } = req.body;
    if (!MODEL_MAP[module]) return res.status(400).json({ error: `Invalid module: ${module}` });
    if (!ids || ids.length > 10000) return res.status(400).json({ error: 'Max 10,000 records per batch' });
    const deleted = await req.app.locals.prisma[MODEL_MAP[module]].deleteMany({ where: { id: { in: ids } } });
    res.json({ operation: 'delete', module, deleted: deleted.count, total: ids.length });
  } catch (err) { next(err); }
});

// Bulk query
router.post('/query', async (req, res, next) => {
  try {
    const { module, where, select, limit = 10000 } = req.body;
    if (!MODEL_MAP[module]) return res.status(400).json({ error: `Invalid module: ${module}` });
    const records = await req.app.locals.prisma[MODEL_MAP[module]].findMany({
      where: where || {}, select: select || undefined, take: Math.min(parseInt(limit), 50000),
    });
    res.json({ module, count: records.length, data: records });
  } catch (err) { next(err); }
});

module.exports = router;

// Bulk upsert
router.post('/upsert/:module', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module } = req.params;
    const { records, matchField = 'email' } = req.body;
    if (!records?.length) return res.status(400).json({ error: 'records required' });
    const models = { contacts: 'contact', leads: 'lead', accounts: 'account', deals: 'deal' };
    const model = models[module];
    if (!model) return res.status(400).json({ error: 'Invalid module' });
    let created = 0, updated = 0, errors = 0;
    for (const rec of records.slice(0, 1000)) {
      try {
        const existing = rec[matchField] ? await prisma[model].findFirst({ where: { [matchField]: rec[matchField], deletedAt: null } }) : null;
        if (existing) { await prisma[model].update({ where: { id: existing.id }, data: rec }); updated++; }
        else { await prisma[model].create({ data: { ...rec, ownerId: req.user.id } }); created++; }
      } catch (e) { errors++; }
    }
    res.json({ module, total: records.length, created, updated, errors });
  } catch (err) { next(err); }
});

// Bulk query
router.post('/query', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, fields, where, limit = 1000, offset = 0 } = req.body;
    const models = { contacts: 'contact', leads: 'lead', accounts: 'account', deals: 'deal', cases: 'case', products: 'product' };
    const model = models[module];
    if (!model) return res.status(400).json({ error: 'Invalid module' });
    const select = fields?.length ? fields.reduce((acc, f) => { acc[f] = true; return acc; }, { id: true }) : undefined;
    const data = await prisma[model].findMany({ where: { ...where, deletedAt: null }, ...(select && { select }), take: Math.min(+limit, 10000), skip: +offset, orderBy: { createdAt: 'desc' } });
    res.json({ module, count: data.length, offset: +offset, data });
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
