const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere } = require('../middleware/access');
const { createCrudRouter } = require('../utils/crud');
const { statusRoutes } = require('../utils/moduleStatus');

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
    const asset = await prisma.asset.update({
      where: { id: req.params.id },
      data: {
        status: 'Installed',
        installDate: new Date(),
        ...(req.body.location && { location: req.body.location }),
      },
    });
    await req.audit({ action: 'update', module: 'assets', recordId: asset.id, details: 'Asset installed' });
    res.json(asset);
  } catch (err) { next(err); }
});

router.post('/:id/decommission', authenticate, requirePermission('assets', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const asset = await prisma.asset.update({
      where: { id: req.params.id },
      data: { status: 'Decommissioned', decommissionDate: new Date(), decommissionReason: req.body.reason },
    });
    await req.audit({ action: 'update', module: 'assets', recordId: asset.id, details: 'Asset decommissioned' });
    res.json(asset);
  } catch (err) { next(err); }
});

router.post('/:id/transfer', authenticate, requirePermission('assets', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { accountId, contactId } = req.body;
    const asset = await prisma.asset.update({
      where: { id: req.params.id },
      data: { ...(accountId && { accountId }), ...(contactId && { contactId }) },
    });
    await req.audit({ action: 'update', module: 'assets', recordId: asset.id, details: `Asset transferred` });
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
    const cases = await prisma.case.findMany({
      where: { assetId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, caseNumber: true, subject: true, status: true, priority: true, createdAt: true, closedAt: true },
    });
    const workOrders = await prisma.workOrder.findMany({
      where: { assetId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, workOrderNumber: true, subject: true, status: true, priority: true, createdAt: true },
    });
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
    const where = await reachableWhere(req, 'assets', 'asset', { id: { in: ids.map(String) } }, 'Edit');
    const result = await prisma.asset.updateMany({ where, data: { status } });
    res.json({ updated: result.count });
  } catch (err) { next(err); }
});

module.exports = router;

// Record count, health and summary, answered from the module's own table.
statusRoutes(router, { module: 'assets', model: 'asset', analytics: true });

// Asset utilization report
router.get('/reports/utilization', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const assets = await prisma.asset.findMany({ where: { deletedAt: null }, select: { id: true, name: true, status: true, installDate: true, usageEndDate: true } });
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
    const expiring = await prisma.asset.findMany({ where: { warrantyEndDate: { lte: thirtyDaysOut, gte: new Date() }, deletedAt: null }, select: { id: true, name: true, warrantyEndDate: true, accountId: true }, orderBy: { warrantyEndDate: 'asc' } });
    res.json({ count: expiring.length, assets: expiring });
  } catch (err) { next(err); }
});

module.exports = router;
