const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { modelHasField } = require('../utils/modelFields');
const { buildAccessFilter, applyAccessFilter, isAdmin } = require('../middleware/rowSecurity');
const { statusRoutes, summaryRoute } = require('../utils/moduleStatus');

// Never under a served path.
const EXPORT_DIR = path.resolve(process.env.EXPORT_DIR || path.join(process.env.UPLOAD_DIR || './uploads', '..', 'private-exports'));

/** Whether the caller's role grants at least read on a module. */
function canRead(user, module) {
  if (isAdmin(user)) return true;
  const perm = user?.role?.permissions?.find(p => p.module === module);
  return !!perm && ['read', 'edit', 'full'].includes(perm.level);
}

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
    if (!['csv', 'json'].includes(format)) return res.status(400).json({ error: 'format must be csv or json' });

    // Exporting a module is reading it, in bulk. Any authenticated user could
    // previously export every row of any module whatever their role allowed.
    if (!canRead(req.user, module)) return res.status(403).json({ error: `Insufficient permissions for ${module}` });

    const exportReq = await prisma.dataExport.create({
      data: { module, format, filters: filters || {}, fields: fields || [], requestedById: req.userId },
    });

    // Process immediately (in production this would be a background job)
    try {
      const where = {};
      if (filters && typeof filters === 'object') {
        for (const [k, v] of Object.entries(filters)) {
          // Plain equality on real columns only; no operators, no relations.
          if (modelHasField(modelName, k) && (v === null || ['string', 'number', 'boolean'].includes(typeof v))) where[k] = v;
        }
      }
      if (modelHasField(modelName, 'deletedAt')) where.deletedAt = null;
      const accessFilter = await buildAccessFilter(prisma, req.user, module, { modelName });
      const records = await prisma[modelName].findMany({ where: applyAccessFilter(where, accessFilter), take: 50000 });

      let content;
      if (format === 'json') {
        content = JSON.stringify(records, null, 2);
      } else {
        // CSV
        if (records.length === 0) { content = ''; }
        else {
          const requested = Array.isArray(fields) ? fields.filter(f => modelHasField(modelName, f)) : [];
          const cols = requested.length ? requested : Object.keys(records[0]).filter(k => typeof records[0][k] !== 'object');
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

      // Written outside anything served, under a name nobody can guess. It
      // used to be export_<module>_<Date.now()> in a publicly served folder.
      fs.mkdirSync(EXPORT_DIR, { recursive: true });
      const filename = `${uuid()}.${format}`;
      fs.writeFileSync(path.join(EXPORT_DIR, filename), content);

      const downloadUrl = `/api/data-export/${exportReq.id}/download`;
      await prisma.dataExport.update({
        where: { id: exportReq.id },
        data: { status: 'completed', fileUrl: filename, recordCount: records.length, completedAt: new Date() },
      });

      res.json({ ...exportReq, status: 'completed', fileUrl: downloadUrl, recordCount: records.length });
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
    const name = path.basename(exp.fileUrl);
    const full = path.join(EXPORT_DIR, name);
    if (!/^[0-9a-f-]{36}\.(csv|json)$/i.test(name) || !fs.existsSync(full)) {
      return res.status(404).json({ error: 'Export file is no longer available' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.download(full, `${exp.module}-export.${exp.format || 'csv'}`);
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

// Record count, health and summary, answered from the module's own table.
statusRoutes(router, { module: 'dataExport', model: 'dataExport' });

// Totals from the module's own table.
summaryRoute(router, { module: 'dataExport', model: 'dataExport' });
