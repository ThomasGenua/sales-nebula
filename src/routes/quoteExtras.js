const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();

// Quote approvals
router.post('/:id/submit-approval', authenticate, requirePermission('quotes', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const quote = await prisma.quote.update({ where: { id: req.params.id }, data: { status: 'Pending Approval', submittedAt: new Date() } });
    // Create approval record
    await prisma.approval.create({
      data: { module: 'quotes', recordId: quote.id, status: 'Pending', submittedById: req.user.id, approverId: req.body.approverId || null },
    });
    await req.audit({ action: 'update', module: 'quotes', recordId: quote.id, details: 'Submitted for approval' });
    res.json(quote);
  } catch (err) { next(err); }
});

// Apply discount to all line items
router.post('/:id/apply-discount', authenticate, requirePermission('quotes', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { discountPercent, discountReason } = req.body;
    if (!discountPercent || discountPercent <= 0 || discountPercent > 100) return res.status(400).json({ error: 'Valid discountPercent (1-100) required' });
    const items = await prisma.quoteLineItem.findMany({ where: { quoteId: req.params.id } });
    const multiplier = 1 - (discountPercent / 100);
    await prisma.$transaction(items.map(item =>
      prisma.quoteLineItem.update({
        where: { id: item.id },
        data: { discount: discountPercent, totalPrice: parseFloat(item.unitPrice) * (item.quantity || 1) * multiplier },
      })
    ));
    const updatedItems = await prisma.quoteLineItem.findMany({ where: { quoteId: req.params.id } });
    const newTotal = updatedItems.reduce((s, i) => s + (parseFloat(i.totalPrice) || 0), 0);
    await prisma.quote.update({ where: { id: req.params.id }, data: { totalAmount: newTotal, discount: discountPercent, discountReason } });
    await req.audit({ action: 'update', module: 'quotes', recordId: req.params.id, details: `Applied ${discountPercent}% discount` });
    res.json({ discount: discountPercent, newTotal, itemsUpdated: items.length });
  } catch (err) { next(err); }
});

// Clone quote
router.post('/:id/clone', authenticate, requirePermission('quotes', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const original = await prisma.quote.findUnique({ where: { id: req.params.id }, include: { lineItems: true } });
    if (!original) return res.status(404).json({ error: 'Quote not found' });
    const { id, createdAt, updatedAt, lineItems, ...quoteData } = original;
    const clone = await prisma.quote.create({
      data: {
        ...quoteData, name: `${original.name} (Copy)`, status: 'Draft', quoteNumber: null,
        lineItems: { create: lineItems.map(({ id, quoteId, createdAt, updatedAt, ...item }) => item) },
      },
      include: { lineItems: true },
    });
    await req.audit({ action: 'create', module: 'quotes', recordId: clone.id, details: `Cloned from ${original.id}` });
    res.status(201).json(clone);
  } catch (err) { next(err); }
});

// Convert quote to order
router.post('/:id/convert-to-order', authenticate, requirePermission('orders', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const quote = await prisma.quote.findUnique({ where: { id: req.params.id }, include: { lineItems: true } });
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    const order = await prisma.order.create({
      data: {
        name: `Order - ${quote.name}`, status: 'Draft',
        accountId: quote.accountId, dealId: quote.dealId, contactId: quote.contactId,
        totalAmount: quote.totalAmount, quoteId: quote.id,
      },
    });
    await prisma.quote.update({ where: { id: req.params.id }, data: { status: 'Accepted', orderId: order.id } });
    await req.audit({ action: 'create', module: 'orders', recordId: order.id, details: `Created from quote ${quote.id}` });
    res.status(201).json(order);
  } catch (err) { next(err); }
});

// Quote comparison
router.post('/compare', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { quoteIds } = req.body;
    if (!quoteIds?.length || quoteIds.length < 2) return res.status(400).json({ error: 'At least 2 quoteIds required' });
    const quotes = await prisma.quote.findMany({
      where: { id: { in: quoteIds } },
      include: { lineItems: { include: { product: { select: { id: true, name: true } } } } },
    });
    res.json({
      quotes: quotes.map(q => ({
        id: q.id, name: q.name, status: q.status,
        totalAmount: q.totalAmount, discount: q.discount,
        lineItemCount: q.lineItems.length,
        products: q.lineItems.map(li => ({ name: li.product?.name || li.name, quantity: li.quantity, unitPrice: li.unitPrice, totalPrice: li.totalPrice })),
      })),
    });
  } catch (err) { next(err); }
});

// Quote version history
router.get('/:id/versions', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const versions = await prisma.quoteVersion.findMany({
      where: { quoteId: req.params.id }, orderBy: { version: 'desc' },
    });
    res.json(versions);
  } catch (err) { next(err); }
});

module.exports = router;

// Quote PDF preview data
router.get('/:id/preview', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const quote = await prisma.quote.findUnique({ where: { id: req.params.id }, include: { lineItems: { include: { product: true } }, account: { select: { name: true, billingCity: true, billingCountry: true } } } });
    if (!quote) return res.status(404).json({ error: 'Not found' });
    res.json({ quote, lineItems: quote.lineItems, account: quote.account, totals: { subtotal: quote.subtotalAmount || 0, discount: quote.discount || 0, tax: quote.taxAmount || 0, total: quote.totalAmount || 0 } });
  } catch (err) { next(err); }
});

// Quote analytics
router.get('/analytics/overview', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [total, accepted, avgValue, byStatus] = await Promise.all([
      prisma.quote.count({ where: { deletedAt: null } }),
      prisma.quote.count({ where: { status: 'Accepted', deletedAt: null } }),
      prisma.quote.aggregate({ where: { deletedAt: null }, _avg: { totalAmount: true } }),
      prisma.quote.groupBy({ by: ['status'], where: { deletedAt: null }, _count: true }),
    ]);
    res.json({ total, accepted, acceptanceRate: total ? Math.round(accepted / total * 100) : 0, avgValue: Math.round(avgValue._avg.totalAmount || 0), byStatus: byStatus.map(s => ({ status: s.status, count: s._count })) });
  } catch (err) { next(err); }
});

// Analytics / Stats
router.get('/analytics/summary', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const thirtyDays = new Date(Date.now() - 30 * 86400000);
    const modelName = 'QuoteExtras';
    // Generic stats endpoint
    const stats = {
      module: 'quoteExtras',
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
      try { return await prisma.$executeRaw`UPDATE "quoteExtras" SET status = ${status} WHERE id = ${id}`; }
      catch (e) { return null; }
    }));
    await req.audit({ action: 'bulk_update', module: 'quoteExtras', details: `Bulk status update: ${ids.length} records to ${status}` });
    res.json({ updated: updated.filter(Boolean).length, requested: ids.length });
  } catch (err) { next(err); }
});
