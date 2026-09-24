const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { canReach } = require('../middleware/access');
const { createNumbered, ORDER_NUMBER, QUOTE_NUMBER } = require('../utils/numbering');
const { summaryRoute } = require('../utils/moduleStatus');

const router = Router();

/** 404 unless the caller can see the quote at :id; these reads took any quote. */
async function visibleQuote(req, res, next) {
  try {
    if (await canReach(req, 'quotes', 'quote', req.params.id)) return next();
    res.status(404).json({ error: 'Not found' });
  } catch (err) { next(err); }
}

// Quote approvals
router.post('/:id/submit-approval', authenticate, requirePermission('quotes', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const quote = await prisma.quote.update({ where: { id: req.params.id }, data: { status: 'Pending Approval', submittedAt: new Date() } });
    // Create approval record
    await prisma.approval.create({
      data: { module: 'quotes', recordId: quote.id, status: 'Pending', requesterId: req.user.id, approverId: req.body.approverId || null },
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
    // The copy gets its own number: `number` is unique, so reusing the
    // original's failed every clone.
    const { id, createdAt, updatedAt, lineItems, number, ...quoteData } = original;
    const clone = await createNumbered(prisma, 'quote', QUOTE_NUMBER, {
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
    const order = await createNumbered(prisma, 'order', ORDER_NUMBER, {
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
router.post('/compare', authenticate, requirePermission('quotes', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { quoteIds } = req.body;
    if (!Array.isArray(quoteIds) || quoteIds.length < 2) return res.status(400).json({ error: 'At least 2 quoteIds required' });
    // Every quote compared must be one the caller can see.
    for (const id of quoteIds) {
      if (!(await canReach(req, 'quotes', 'quote', id))) return res.status(404).json({ error: 'Not found' });
    }
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
router.get('/:id/versions', authenticate, requirePermission('quotes', 'read'), visibleQuote, async (req, res, next) => {
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
router.get('/:id/preview', authenticate, requirePermission('quotes', 'read'), visibleQuote, async (req, res, next) => {
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

// Totals from the module's own table.
summaryRoute(router, { module: 'quotes', model: 'quote' });
