const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere } = require('../middleware/access');
const { createCrudRouter } = require('../utils/crud');
const { statusRoutes } = require('../utils/moduleStatus');
const { updateRecord, batchClient, RecordWriteError } = require('../services/recordWrites');

const router = createCrudRouter('asset', 'assets', {
  include: {
    account: { select: { id: true, name: true } },
    contact: { select: { id: true, firstName: true, lastName: true } },
    product: { select: { id: true, name: true } },
  },
  searchFilter: (q) => ({
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      { serialNumber: { contains: q, mode: 'insensitive' } },
    ],
  }),
  validate: (data) => {
    const errors = {};
    if (!data.name?.trim()) errors.name = 'Asset name required';
    return { valid: Object.keys(errors).length === 0, errors };
  },
});

// Lifecycle management
router.post('/:id/install', authenticate, requirePermission('assets', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // An asset has no location column: sending one made the install answer
    // 500, so it is not stored. As an edit (services/recordWrites): rules,
    // audit trail, workflows and webhooks, which these actions never reached.
    const { record: asset } = await updateRecord(prisma, 'assets', req.params.id, {
      status: 'Installed',
      installDate: new Date(),
    }, { req, userId: req.userId, source: 'installed' });
    res.json(asset);
  } catch (err) { next(err); }
});

router.post('/:id/decommission', authenticate, requirePermission('assets', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { record: asset } = await updateRecord(prisma, 'assets', req.params.id, {
      status: 'Decommissioned', decommissionDate: new Date(), decommissionReason: req.body.reason,
    }, { req, userId: req.userId, source: 'decommissioned' });
    res.json(asset);
  } catch (err) { next(err); }
});

router.post('/:id/transfer', authenticate, requirePermission('assets', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { accountId, contactId } = req.body;
    // Only to an account and contact the caller can see. Asset keeps both as
    // plain columns, which linkRefusal cannot check; they were stored as sent,
    // and the asset's include read back the account's and contact's names.
    for (const [key, module, model, value] of [['accountId', 'accounts', 'account', accountId], ['contactId', 'contacts', 'contact', contactId]]) {
      if (!value) continue;
      const found = permits(req, module, 'read') && await prisma[model].findFirst({ where: await reachableWhere(req, module, model, { id: String(value) }), select: { id: true } });
      if (!found) return res.status(400).json({ error: `${key} does not name a ${model} you can see`, code: 'LINK_NOT_VISIBLE' });
    }
    const { record: asset } = await updateRecord(prisma, 'assets', req.params.id, {
      ...(accountId && { accountId }), ...(contactId && { contactId }),
    }, { req, userId: req.userId, source: 'transferred' });
    res.json(asset);
  } catch (err) { next(err); }
});

// Warranty check
router.get('/:id/warranty', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const asset = await prisma.asset.findUnique({ where: { id: req.params.id } });
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    const now = new Date();
    // warrantyEnd/warrantyStart were never columns, so every asset read as
    // out of warranty. warrantyEndDate is the column the asset form writes.
    const warrantyEnd = asset.warrantyEndDate ? new Date(asset.warrantyEndDate) : null;
    res.json({
      assetId: asset.id,
      name: asset.name,
      warrantyEnd: asset.warrantyEndDate,
      underWarranty: warrantyEnd ? warrantyEnd > now : false,
      daysRemaining: warrantyEnd ? Math.max(0, Math.ceil((warrantyEnd - now) / 86400000)) : null,
    });
  } catch (err) { next(err); }
});

// Service history
router.get('/:id/service-history', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Each module's records only with its read permission, and only those row
    // security lets the caller see; deleted cases and anyone's were listed.
    const cases = permits(req, 'cases', 'read') ? await prisma.case.findMany({
      where: await reachableWhere(req, 'cases', 'case', { assetId: req.params.id }),
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, caseNumber: true, subject: true, status: true, priority: true, createdAt: true, closedAt: true },
    }) : [];
    const workOrders = permits(req, 'fieldService', 'read') ? await prisma.workOrder.findMany({
      where: await reachableWhere(req, 'fieldService', 'workOrder', { assetId: req.params.id }),
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, workOrderNumber: true, subject: true, status: true, priority: true, createdAt: true },
    }) : [];
    res.json({ cases, workOrders, totalServiceEvents: cases.length + workOrders.length });
  } catch (err) { next(err); }
});

// Bulk status update
// Assets the caller could edit one at a time; this set any asset's status.
router.post('/bulk/status', authenticate, requirePermission('assets', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || !ids.length || typeof status !== 'string' || !status) return res.status(400).json({ error: 'ids and status required' });
    if (ids.length > 100) return res.status(400).json({ error: 'Maximum 100 records per bulk operation' });
    // Each as an edit is (services/recordWrites), so the status rules and
    // workflows see every one; a refused one keeps its status and is listed.
    const where = await reachableWhere(req, 'assets', 'asset', { id: { in: ids.map(String) }, deletedAt: null }, 'Edit');
    const db = batchClient(prisma);
    const write = { req, userId: req.userId, source: 'bulk status' };
    let updated = 0;
    const failed = [];
    for (const asset of await prisma.asset.findMany({ where })) {
      try {
        await updateRecord(db, 'assets', asset, { status }, write);
        updated++;
      } catch (err) {
        if (!(err instanceof RecordWriteError)) throw err;
        failed.push({ id: asset.id, error: err.body.error });
      }
    }
    res.json({ updated, ...(failed.length ? { failed } : {}) });
  } catch (err) { next(err); }
});

module.exports = router;

// Record count, health and summary, answered from the module's own table.
statusRoutes(router, { module: 'assets', model: 'asset', analytics: true });

// Asset utilization report
router.get('/reports/utilization', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // The assets the caller may see; this counted everyone's.
    const assets = await prisma.asset.findMany({ where: await reachableWhere(req, 'assets', 'asset'), select: { id: true, name: true, status: true, installDate: true, usageEndDate: true } });
    const byStatus = {};
    assets.forEach(a => { byStatus[a.status || 'Unknown'] = (byStatus[a.status || 'Unknown'] || 0) + 1; });
    const activeCount = assets.filter(a => a.status === 'Active' || a.status === 'Installed').length;
    res.json({ total: assets.length, byStatus, utilizationRate: assets.length > 0 ? ((activeCount / assets.length) * 100).toFixed(1) + '%' : '0%', activeCount });
  } catch (err) { next(err); }
});

// Warranty expiring soon
router.get('/reports/warranty-expiring', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const thirtyDaysOut = new Date(Date.now() + 30 * 86400000);
    const expiring = await prisma.asset.findMany({ where: await reachableWhere(req, 'assets', 'asset', { warrantyEndDate: { lte: thirtyDaysOut, gte: new Date() } }), select: { id: true, name: true, warrantyEndDate: true, accountId: true }, orderBy: { warrantyEndDate: 'asc' } });
    res.json({ count: expiring.length, assets: expiring });
  } catch (err) { next(err); }
});

module.exports = router;
