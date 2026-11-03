const router = require('express').Router();
const { authenticate, requirePermission } = require('../middleware/auth');
const service = require('../services/crmMigration');
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
router.use(authenticate, requirePermission('admin', 'full'), (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/metadata', (req, res) => res.json({ fields: service.fields, required: service.required, stages: service.stages, modules: Object.keys(service.fields) }));
router.post('/mapping', (req, res) => {
  if (!service.fields[req.body.module] || !Array.isArray(req.body.headers) || req.body.headers.length > 200 || req.body.headers.some(h => typeof h !== 'string')) return res.status(400).json({ error: 'Choose a supported module and CSV headings' });
  res.json(service.mapping(req.body.module, req.body.headers));
});
router.get('/', wrap(async (req, res) => res.json({ data: await req.app.locals.prisma.migrationBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }) })));
router.post('/', wrap(async (req, res) => res.status(201).json(await service.stage(req.app.locals.prisma, req, req.body))));
router.param('id', async (req, res, next, id) => {
  try { req.batch = await req.app.locals.prisma.migrationBatch.findUnique({ where: { id } }); if (!req.batch) return res.status(404).json({ error: 'Migration not found' }); next(); } catch (e) { next(e); }
});
router.get('/:id', wrap(async (req, res) => {
  const db = req.app.locals.prisma, page = Math.max(1, Number(req.query.page) || 1);
  const where = { batchId: req.batch.id, ...(req.query.errors === 'true' && { status: { in: ['Failed', 'Invalid'] } }) };
  const [rows, total, groups] = await Promise.all([db.migrationRow.findMany({ where, orderBy: { position: 'asc' }, take: 50, skip: (page - 1) * 50 }), db.migrationRow.count({ where }), db.migrationRow.groupBy({ by: ['status'], where: { batchId: req.batch.id }, _count: true })]);
  res.json({ batch: req.batch, rows, total, page, counts: Object.fromEntries(groups.map(g => [g.status, g._count])) });
}));
router.patch('/:id/rows/:rowId', wrap(async (req, res) => {
  if (['Running', 'Undone'].includes(req.batch.status)) return res.status(409).json({ error: 'Pause the migration before correcting rows' });
  const db = req.app.locals.prisma;
  const row = await db.migrationRow.findFirst({ where: { id: req.params.rowId, batchId: req.batch.id, status: { in: ['Pending', 'Failed', 'Invalid'] } } });
  if (!row) return res.status(404).json({ error: 'Editable row not found' });
  const allowed = [...service.fields[row.module], 'ownerEmail', 'ownerExternalId', 'accountExternalId', 'contactExternalId'];
  if (!req.body.data || Object.entries(req.body.data).some(([k, v]) => !allowed.includes(k) || typeof v !== 'string')) return res.status(400).json({ error: 'Use mapped text fields' });
  const data = { ...row.data, ...req.body.data }, error = service.problem(row.module, data);
  res.json(await db.migrationRow.update({ where: { id: row.id }, data: { data, status: error ? 'Invalid' : 'Pending', error } }));
}));
router.post('/:id/start', wrap(async (req, res) => {
  if (req.body.acknowledgeAutomation !== true) return res.status(400).json({ error: 'Review and acknowledge active automation before importing' });
  if (req.batch.status === 'Undone') return res.status(409).json({ error: 'Create a new migration after undo' });
  const db = req.app.locals.prisma;
  if (await db.migrationRow.count({ where: { batchId: req.batch.id, status: 'Invalid' } })) return res.status(400).json({ error: 'Correct invalid preview rows before starting' });
  await db.$transaction([db.migrationRow.updateMany({ where: { batchId: req.batch.id, status: 'Failed' }, data: { status: 'Pending', error: null } }), db.migrationBatch.update({ where: { id: req.batch.id }, data: { status: 'Running', error: null } })]);
  res.json({ started: true });
  // Durable rows are also picked up by the scheduler after process restarts.
  setImmediate(() => service.runBatch(db, req.batch.id).catch(() => {}));
}));
router.post('/:id/pause', wrap(async (req, res) => {
  await req.app.locals.prisma.migrationBatch.updateMany({ where: { id: req.batch.id, status: 'Running' }, data: { status: 'Paused' } }); res.json({ paused: true });
}));
router.get('/:id/undo', wrap(async (req, res) => {
  if (req.batch.status === 'Running') return res.status(409).json({ error: 'Pause the migration before previewing undo' });
  res.json(await service.undoPreview(req.app.locals.prisma, req.batch));
}));
router.post('/:id/undo', wrap(async (req, res) => {
  if (req.batch.status === 'Running') return res.status(409).json({ error: 'Pause the migration before undo' });
  res.json(await service.undo(req.app.locals.prisma, req, req.batch, req.body.hash));
}));
module.exports = router;
