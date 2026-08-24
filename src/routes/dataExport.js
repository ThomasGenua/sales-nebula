const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();
router.use(authenticate);

const MODEL_MAP = {
  contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account',
  activities: 'activity', cases: 'case', products: 'product',
  quotes: 'quote', invoices: 'invoice', campaigns: 'campaign',
  contracts: 'contract', orders: 'order',
};

router.get('/', async (req, res, next) => {
  try {
    const exports = await req.app.locals.prisma.dataExport.findMany({
      where: { requestedById: req.userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ data: exports });
  } catch (err) { next(err); }
});

// POST /data-export - Request a new export
router.post('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, format = 'csv', filters, fields } = req.body;
    const modelName = MODEL_MAP[module];
    if (!modelName) return res.status(400).json({ error: 'Invalid module' });

    const exportReq = await prisma.dataExport.create({
      data: { module, format, filters: filters || {}, fields: fields || [], requestedById: req.userId },
    });

    // Process immediately (in production this would be a background job)
    try {
      const where = {};
      if (filters) {
        Object.entries(filters).forEach(([k, v]) => { where[k] = v; });
      }
      const records = await prisma[modelName].findMany({ where, take: 50000 });

      let content;
      if (format === 'json') {
        content = JSON.stringify(records, null, 2);
      } else {
        // CSV
        if (records.length === 0) { content = ''; }
        else {
          const cols = fields.length > 0 ? fields : Object.keys(records[0]).filter(k => typeof records[0][k] !== 'object');
          const header = cols.join(',');
          const rows = records.map(r => cols.map(c => {
            const val = r[c];
            if (val === null || val === undefined) return '';
            const str = String(val);
            return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
          }).join(','));
          content = [header, ...rows].join('\n');
        }
      }

      const fs = require('fs');
      const path = require('path');
      const dir = process.env.UPLOAD_DIR || './uploads';
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const filename = `export_${module}_${Date.now()}.${format}`;
      const filepath = path.join(dir, filename);
      fs.writeFileSync(filepath, content);

      await prisma.dataExport.update({
        where: { id: exportReq.id },
        data: { status: 'completed', fileUrl: `/uploads/${filename}`, recordCount: records.length, completedAt: new Date() },
      });

      res.json({ ...exportReq, status: 'completed', fileUrl: `/uploads/${filename}`, recordCount: records.length });
    } catch (e) {
      await prisma.dataExport.update({ where: { id: exportReq.id }, data: { status: 'failed' } });
      res.json({ ...exportReq, status: 'failed', error: e.message });
    }
  } catch (err) { next(err); }
});

// GET /data-export/:id/download
router.get('/:id/download', async (req, res, next) => {
  try {
    const exp = await req.app.locals.prisma.dataExport.findUnique({ where: { id: req.params.id } });
    if (!exp || exp.requestedById !== req.userId) return res.status(404).json({ error: 'Not found' });
    if (!exp.fileUrl) return res.status(400).json({ error: 'Export not ready' });
    const path = require('path');
    res.download(path.resolve(exp.fileUrl.replace(/^\//, '')));
  } catch (err) { next(err); }
});

module.exports = router;

// Export all data (GDPR data portability)
router.post('/full-export', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { modules = ['contacts','leads','deals','accounts','cases'] } = req.body;
    const data = {};
    const modelMap = { contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account', cases: 'case', products: 'product', activities: 'activity' };
    for (const mod of modules) {
      const model = modelMap[mod];
      if (model) { try { data[mod] = await prisma[model].findMany({ where: { deletedAt: null }, take: 50000 }); } catch (e) { data[mod] = []; } }
    }
    const exportMeta = { exportedAt: new Date(), exportedBy: req.user.id, modules, recordCounts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])) };
    res.json({ meta: exportMeta, data });
  } catch (err) { next(err); }
});

// Data retention policy
router.get('/retention-policy', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  res.json({
    policies: [
      { module: 'auditLogs', retentionDays: 365, description: 'Audit logs retained for 1 year' },
      { module: 'loginHistory', retentionDays: 180, description: 'Login history retained 6 months' },
      { module: 'recycleBin', retentionDays: 30, description: 'Deleted records recoverable for 30 days' },
      { module: 'emailLogs', retentionDays: 90, description: 'Email tracking data retained 90 days' },
      { module: 'eventLogs', retentionDays: 30, description: 'System events retained 30 days' },
    ],
  });
});

// Bulk status check
router.get('/status/health', authenticate, async (req, res, next) => {
  try { res.json({ module: 'dataExport', healthy: true, timestamp: new Date(), version: '4.1.0' }); } catch (err) { next(err); }
});

// Count endpoint
router.get('/count', authenticate, async (req, res, next) => {
  try { res.json({ count: 0, module: 'dataExport' }); } catch (err) { next(err); }
});

// Analytics / Stats
router.get('/analytics/summary', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const thirtyDays = new Date(Date.now() - 30 * 86400000);
    const modelName = 'DataExport';
    // Generic stats endpoint
    const stats = {
      module: 'dataExport',
      generatedAt: new Date(),
      environment: process.env.NODE_ENV || 'development',
    };
    res.json(stats);
  } catch (err) { next(err); }
});

// Bulk status update
router.post('/bulk/status', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { ids, status } = req.body;
    if (!ids?.length || !status) return res.status(400).json({ error: 'ids and status required' });
    const updated = await Promise.all(ids.slice(0, 100).map(async (id) => {
      try { return await prisma.$executeRaw`UPDATE "dataExport" SET status = ${status} WHERE id = ${id}`; }
      catch (e) { return null; }
    }));
    await req.audit({ action: 'bulk_update', module: 'dataExport', details: `Bulk status update: ${ids.length} records to ${status}` });
    res.json({ updated: updated.filter(Boolean).length, requested: ids.length });
  } catch (err) { next(err); }
});
