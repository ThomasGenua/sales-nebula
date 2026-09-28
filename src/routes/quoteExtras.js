const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { canReach, reachableWhere } = require('../middleware/access');
const { createNumbered, ORDER_NUMBER, QUOTE_NUMBER } = require('../utils/numbering');
const { summaryRoute } = require('../utils/moduleStatus');

const router = Router();

/**
 * 404 unless the caller can see (or, with 'Edit', change) the quote at :id.
 * The reads took any quote, and the writes (approval, discount, clone,
 * conversion) any quote id with the module permission alone. A quote has no
 * owner or creator column, so row security reaches it through group grants,
 * or, while the module is open, as a quote no group holds.
 */
const quoteReach = minLevel => async (req, res, next) => {
  try {
    if (await canReach(req, 'quotes', 'quote', req.params.id, minLevel)) return next();
    res.status(404).json({ error: 'Not found' });
  } catch (err) { next(err); }
};
const visibleQuote = quoteReach('Read');
const editableQuote = quoteReach('Edit');

// A quote's lines are its `items` (QuoteItem), which quotes.js writes and its
// PDF and invoices read. These routes read `lineItems` (QuoteLineItem), which
// nothing writes, so a discount zeroed the quote's total, a clone had no
// lines, and the comparison, preview and order had none either. A quote's
// amount is `total`, kept equal to `totalAmount` by quotes.js; the amounts
// read here as subtotalAmount and taxAmount are not columns.

// Quote approvals
router.post('/:id/submit-approval', authenticate, requirePermission('quotes', 'edit'), editableQuote, auditMiddleware, async (req, res, next) => {
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
router.post('/:id/apply-discount', authenticate, requirePermission('quotes', 'edit'), editableQuote, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { discountReason } = req.body;
    const discountPercent = Number(req.body.discountPercent);
    if (!discountPercent || discountPercent <= 0 || discountPercent > 100) return res.status(400).json({ error: 'Valid discountPercent (1-100) required' });
    const quote = await prisma.quote.findFirst({ where: { id: req.params.id, deletedAt: null }, include: { items: true } });
    if (!quote) return res.status(404).json({ error: 'Not found' });
    if (!quote.items.length) return res.status(400).json({ error: 'The quote has no lines to discount' });
    // Each line's discount is an amount, as the PDF shows it: the percentage
    // of the line before discount. The quote's own discount, also an amount,
    // still comes off the subtotal; it was overwritten with the percentage.
    const lines = quote.items.map(item => {
      const gross = (item.unitPrice || 0) * (item.quantity || 1);
      const off = gross * discountPercent / 100;
      return { id: item.id, discount: off, total: gross - off };
    });
    const subtotal = lines.reduce((s, l) => s + l.total, 0);
    const newTotal = subtotal - (quote.discount || 0) + (quote.tax || 0);
    await prisma.$transaction([
      ...lines.map(({ id, ...data }) => prisma.quoteItem.update({ where: { id }, data })),
      prisma.quote.update({ where: { id: quote.id }, data: { subtotal, total: newTotal, totalAmount: newTotal, discountReason } }),
    ]);
    await req.audit({ action: 'update', module: 'quotes', recordId: req.params.id, details: `Applied ${discountPercent}% discount` });
    res.json({ discount: discountPercent, newTotal, itemsUpdated: lines.length });
  } catch (err) { next(err); }
});

// Clone quote
router.post('/:id/clone', authenticate, requirePermission('quotes', 'edit'), editableQuote, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const original = await prisma.quote.findFirst({ where: { id: req.params.id, deletedAt: null }, include: { items: true } });
    if (!original) return res.status(404).json({ error: 'Quote not found' });
    // The copy gets its own number: `number` is unique, so reusing the
    // original's failed every clone. It is a new draft, not submitted or
    // turned into the original's order.
    const { id, createdAt, updatedAt, deletedAt, items, number, orderId, submittedAt, ...quoteData } = original;
    const clone = await createNumbered(prisma, 'quote', QUOTE_NUMBER, {
      data: {
        ...quoteData, name: `${original.name || original.number} (Copy)`, status: 'Draft', quoteNumber: null,
        items: { create: items.map(({ id, quoteId, ...item }) => item) },
      },
      include: { items: true },
    });
    await req.audit({ action: 'create', module: 'quotes', recordId: clone.id, details: `Cloned from ${original.id}` });
    res.status(201).json(clone);
  } catch (err) { next(err); }
});

// Convert quote to order
// It accepts the quote too, so it is a quote write as well as an order's.
router.post('/:id/convert-to-order', authenticate, requirePermission('orders', 'edit'), requirePermission('quotes', 'edit'), editableQuote, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const quote = await prisma.quote.findFirst({ where: { id: req.params.id, deletedAt: null }, include: { items: true } });
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    // An order must have an account; without one the create answered 500.
    if (!quote.accountId) return res.status(400).json({ error: 'The quote has no account, and an order needs one' });
    // The order is the caller's, as one they create is. It had no owner or
    // creator, so row security's ownership arm matched nobody. Its lines and
    // amounts are the quote's, as /api/orders/from-quote copies them.
    const order = await createNumbered(prisma, 'order', ORDER_NUMBER, {
      data: {
        name: `Order - ${quote.name || quote.number}`, status: 'Draft',
        accountId: quote.accountId, dealId: quote.dealId, contactId: quote.contactId,
        subtotal: quote.total - quote.tax + quote.discount, discount: quote.discount, tax: quote.tax,
        total: quote.total, totalAmount: quote.total, quoteId: quote.id,
        ownerId: req.user.id, createdById: req.user.id,
        items: { create: quote.items.map(i => ({ productId: i.productId, description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, discount: i.discount, total: i.total })) },
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
      where: { id: { in: quoteIds.map(String) }, deletedAt: null },
      include: { items: { include: { product: { select: { id: true, name: true } } } } },
    });
    res.json({
      quotes: quotes.map(q => ({
        id: q.id, name: q.name, number: q.number, status: q.status,
        totalAmount: q.total, discount: q.discount,
        lineItemCount: q.items.length,
        products: q.items.map(li => ({ name: li.product?.name || li.description, quantity: li.quantity, unitPrice: li.unitPrice, totalPrice: li.total })),
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
    const quote = await prisma.quote.findFirst({ where: { id: req.params.id, deletedAt: null }, include: { items: { include: { product: true } }, account: { select: { name: true, billingCity: true, billingCountry: true } } } });
    if (!quote) return res.status(404).json({ error: 'Not found' });
    res.json({ quote, lineItems: quote.items, account: quote.account, totals: { subtotal: quote.subtotal || 0, discount: quote.discount || 0, tax: quote.tax || 0, total: quote.total || 0 } });
  } catch (err) { next(err); }
});

// Quote analytics
// Over the live quotes the caller can see; this took a session alone and
// counted and averaged every quote.
router.get('/analytics/overview', authenticate, requirePermission('quotes', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const where = await reachableWhere(req, 'quotes', 'quote');
    const [total, accepted, avgValue, byStatus] = await Promise.all([
      prisma.quote.count({ where }),
      prisma.quote.count({ where: { AND: [where, { status: 'Accepted' }] } }),
      prisma.quote.aggregate({ where, _avg: { total: true } }),
      prisma.quote.groupBy({ by: ['status'], where, _count: true }),
    ]);
    res.json({ total, accepted, acceptanceRate: total ? Math.round(accepted / total * 100) : 0, avgValue: Math.round(avgValue._avg.total || 0), byStatus: byStatus.map(s => ({ status: s.status, count: s._count })) });
  } catch (err) { next(err); }
});

// Totals from the module's own table.
summaryRoute(router, { module: 'quotes', model: 'quote' });
