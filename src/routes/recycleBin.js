const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();
router.use(authenticate, auditMiddleware);

const MODEL_MAP = {
  contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account',
  activities: 'activity', cases: 'case', products: 'product',
  quotes: 'quote', invoices: 'invoice', campaigns: 'campaign',
  documents: 'document', emails: 'email',
  contracts: 'contract', orders: 'order', entitlements: 'entitlement',
};

// A bin module as its model, named as the bin names it (contacts) or as the
// model (contact); null for anything else. And back.
const binModel = name => MODEL_MAP[name] || (Object.values(MODEL_MAP).includes(name) ? name : null);
const binModule = model => Object.keys(MODEL_MAP).find(key => MODEL_MAP[key] === model);

// LIST deleted items
router.get('/', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, page = 1, limit = 50, search } = req.query;
    const take = Math.min(parseInt(limit) || 50, 200);
    const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;

    let where = {};
    // The Recycle Bin page asks for a model name (contact); entries are filed
    // by module (contacts), so it opened on an empty list.
    if (module) where.module = binModule(binModel(module)) || module;

    const [items, total] = await Promise.all([
      prisma.recycleBinItem.findMany({
        where, orderBy: { deletedAt: 'desc' }, skip, take,
      }),
      prisma.recycleBinItem.count({ where }),
    ]);

    // Hydrate deleted-by user
    const userIds = [...new Set(items.map(i => i.deletedById))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, firstName: true, lastName: true },
    });
    const userMap = Object.fromEntries(users.map(u => [u.id, u]));

    const data = items.map(item => ({
      id: item.id,
      module: item.module,
      recordId: item.recordId,
      name: extractName(item.module, item.recordData),
      deletedBy: userMap[item.deletedById] || null,
      deletedAt: item.deletedAt,
      expiresAt: item.expiresAt,
    }));

    res.json({ data, meta: { total, page: parseInt(page), limit: take, pages: Math.ceil(total / take) } });
  } catch (err) { next(err); }
});

// RESTORE a deleted item
router.post('/:id/restore', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const item = await prisma.recycleBinItem.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: 'Not found in recycle bin' });

    const modelName = MODEL_MAP[item.module];
    if (!modelName || !prisma[modelName]) {
      return res.status(400).json({ error: `Cannot restore module: ${item.module}` });
    }

    const existing = await prisma[modelName].findUnique({ where: { id: item.recordId } }).catch(() => null);

    // Deleting through the CRUD router is a soft delete for most models, so
    // the row is still there with deletedAt set. Re-creating it hit the
    // unique constraints and answered 409 every time — restore has never
    // worked for a soft-deletable model. Clear the flag instead.
    let restored;
    if (existing && existing.deletedAt) {
      restored = await prisma[modelName].update({
        where: { id: item.recordId },
        data: { deletedAt: null },
      });
    } else if (existing) {
      return res.status(409).json({ error: 'A record with this ID already exists. It may have been re-created.' });
    } else {
      // Hard-deleted (Deal and Workflow have no deletedAt): rebuild from the snapshot.
      const data = typeof item.recordData === 'string' ? JSON.parse(item.recordData) : item.recordData;
      delete data.createdAt;
      delete data.updatedAt;
      restored = await prisma[modelName].create({ data });
    }

    // Remove from recycle bin
    await prisma.recycleBinItem.delete({ where: { id: item.id } });

    await req.audit({ action: 'create', module: item.module, recordId: restored.id, details: `Restored from recycle bin` });
    res.json({ success: true, restored });
  } catch (err) { next(err); }
});

// Permanent delete (purge). It sat below DELETE /:id, which took "purge" for
// a bin entry's id, so it never ran. A module is named as elsewhere in the bin
// (contacts) or, as it was here, by model (contact); a model that cannot be
// purged is reported in `failed`, not skipped in silence.
router.delete('/purge', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, olderThanDays = 30 } = req.body;
    const days = Number(olderThanDays);
    if (!Number.isFinite(days) || days < 0) return res.status(400).json({ error: 'olderThanDays must be a number of days' });
    const cutoff = new Date(Date.now() - days * 86400000);
    const modules = module ? [binModel(module)] : ['contact', 'lead', 'deal', 'account', 'case', 'activity'];
    if (!modules[0]) return res.status(400).json({ error: `Cannot purge module: ${module}` });
    let totalPurged = 0;
    const failed = [];
    for (const m of modules) {
      try {
        const result = await prisma[m].deleteMany({ where: { deletedAt: { not: null, lt: cutoff } } });
        totalPurged += result.count;
      } catch (e) { failed.push(m); }
    }
    await req.audit({ action: 'delete', module: 'recycleBin', recordId: 'purge', details: `Purged ${totalPurged} records older than ${days} days` });
    res.json({ purged: totalPurged, cutoffDate: cutoff, failed });
  } catch (err) { next(err); }
});

// PERMANENTLY DELETE
router.delete('/:id', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.recycleBinItem.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// EMPTY recycle bin (purge all)
router.post('/empty', requirePermission('settings', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module } = req.body;
    const where = module ? { module } : {};
    const result = await prisma.recycleBinItem.deleteMany({ where });
    await req.audit({ action: 'delete', module: 'settings', details: `Emptied recycle bin (${result.count} items)` });
    res.json({ success: true, purged: result.count });
  } catch (err) { next(err); }
});

// GET recycle bin stats
router.get('/stats', requirePermission('settings', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const items = await prisma.recycleBinItem.groupBy({ by: ['module'], _count: true });
    const total = items.reduce((s, i) => s + i._count, 0);
    const byModule = Object.fromEntries(items.map(i => [i.module, i._count]));
    res.json({ total, byModule });
  } catch (err) { next(err); }
});

function extractName(module, data) {
  const d = typeof data === 'string' ? JSON.parse(data) : data;
  switch (module) {
    case 'contacts': return `${d.firstName || ''} ${d.lastName || ''}`.trim();
    case 'leads': return `${d.firstName || ''} ${d.lastName || ''}`.trim();
    case 'deals': return d.name || '';
    case 'accounts': return d.name || '';
    case 'cases': return d.subject || d.caseNumber || '';
    case 'products': return d.name || '';
    default: return d.name || d.subject || d.id || '';
  }
}

module.exports = router;

// A second GET /stats (per-model counts of soft-deleted rows, for anyone signed
// in) stood here. The one above answers that path, so it never ran.

// Bulk restore. The module is named as elsewhere in the bin (contacts) or by
// model (contact); any other name went to prisma[module] and failed as a 500.
// The restored records leave the bin, as a single restore's does: they stayed
// listed, and restoring one again answered 409.
router.post('/restore/bulk', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, ids } = req.body;
    if (!module || !Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'module and ids required' });
    const model = binModel(module);
    if (!model) return res.status(400).json({ error: `Cannot restore module: ${module}` });
    const deleted = await prisma[model].findMany({ where: { id: { in: ids.map(String) }, deletedAt: { not: null } }, select: { id: true } });
    const restoredIds = deleted.map(r => r.id);
    const result = await prisma[model].updateMany({ where: { id: { in: restoredIds } }, data: { deletedAt: null } });
    await prisma.recycleBinItem.deleteMany({ where: { module: binModule(model), recordId: { in: restoredIds } } });
    await req.audit({ action: 'restore', module: 'recycleBin', recordId: module, details: `Bulk restored ${result.count} ${module} records` });
    res.json({ restored: result.count });
  } catch (err) { next(err); }
});
