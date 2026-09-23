const { createCrudRouter } = require('../utils/crud');
const { auditMiddleware } = require('../middleware/audit');
const { authenticate, requirePermission } = require('../middleware/auth');
const { createNumbered, ORDER_NUMBER } = require('../utils/numbering');
const { lineItemFields } = require('../utils/modelFields');

/** The order's lines as sent, each cut down to the columns an item has. */
const orderLines = req => (Array.isArray(req.body?.items) ? req.body.items.map(i => lineItemFields(i)) : []);

const include = {
  account: { select: { id: true, name: true } },
  contract: { select: { id: true, contractNumber: true } },
  items: { include: { product: { select: { id: true, name: true } } } },
};

const router = createCrudRouter('order', 'orders', {
  include,
  searchFilter: (q) => ({
    OR: [
      { orderNumber: { contains: q, mode: 'insensitive' } },
      { account: { name: { contains: q, mode: 'insensitive' } } },
    ],
  }),
  numbering: ORDER_NUMBER,
  beforeCreate: async (data, req) => {
    const lines = orderLines(req);
    if (lines.length) {
      data.subtotal = lines.reduce((sum, line) => sum + line.total, 0);
      data.total = data.subtotal + (Number(data.tax) || 0) - (Number(data.discount) || 0);
    }
    return data;
  },
  // The items went to Prisma exactly as sent, as a bare list it rejected.
  nestedWrites: async (req, operation) => {
    const lines = operation === 'create' ? orderLines(req) : [];
    return lines.length ? { items: { create: lines } } : {};
  },
});

// POST /orders/:id/activate
router.post('/:id/activate', authenticate, requirePermission('orders', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: { status: 'Activated', activatedDate: new Date() },
      include,
    });
    await req.audit({ action: 'update', module: 'orders', recordId: order.id, details: 'Order activated' });
    req.app.locals.emit?.('order:activated', { orderId: order.id });
    res.json(order);
  } catch (err) { next(err); }
});

// POST /quotes/:quoteId/convert-to-order
router.post('/from-quote/:quoteId', authenticate, requirePermission('orders', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const quote = await prisma.quote.findUnique({
      where: { id: req.params.quoteId },
      include: { items: true, account: true },
    });
    if (!quote) return res.status(404).json({ error: 'Quote not found' });

    const order = await createNumbered(prisma, 'order', ORDER_NUMBER, {
      data: {
        accountId: quote.accountId,
        contactId: quote.contactId,
        quoteId: quote.id,
        subtotal: quote.total - quote.tax,
        tax: quote.tax,
        total: quote.total,
        discount: quote.discount,
        ownerId: req.userId,
        items: {
          create: quote.items.map(qi => ({
            productId: qi.productId,
            description: qi.description,
            quantity: qi.quantity,
            unitPrice: qi.unitPrice,
            total: qi.total,
            discount: qi.discount || 0,
          })),
        },
      },
      include,
    });
    await req.audit({ action: 'create', module: 'orders', recordId: order.id, details: `Created from quote ${quote.number}` });
    res.status(201).json(order);
  } catch (err) { next(err); }
});

module.exports = router;

// Order fulfillment workflow
router.post('/:id/fulfill', authenticate, requirePermission('orders', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { trackingNumber, carrier, shippedDate, notes } = req.body;
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: 'Not found' });
    if (order.status === 'Cancelled') return res.status(400).json({ error: 'Cannot fulfill cancelled order' });
    const updated = await prisma.order.update({ where: { id: req.params.id }, data: { status: 'Fulfilled', trackingNumber, carrier, shippedDate: shippedDate ? new Date(shippedDate) : new Date(), fulfilledAt: new Date(), fulfillmentNotes: notes } });
    await req.audit({ action: 'update', module: 'orders', recordId: order.id, details: `Fulfilled. Tracking: ${trackingNumber || 'N/A'}` });
    res.json(updated);
  } catch (err) { next(err); }
});

// Cancel order
router.post('/:id/cancel', authenticate, requirePermission('orders', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { reason } = req.body;
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: 'Not found' });
    if (order.status === 'Fulfilled') return res.status(400).json({ error: 'Cannot cancel fulfilled order' });
    const updated = await prisma.order.update({ where: { id: req.params.id }, data: { status: 'Cancelled', cancelledAt: new Date(), cancelReason: reason } });
    await req.audit({ action: 'update', module: 'orders', recordId: order.id, details: `Cancelled: ${reason || 'No reason'}` });
    res.json(updated);
  } catch (err) { next(err); }
});

// Order line items
router.get('/:id/items', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // A product's code is its sku; order items keep no sort position.
    const items = await prisma.orderItem.findMany({ where: { orderId: req.params.id }, include: { product: { select: { name: true, sku: true, price: true } } } });
    const subtotal = items.reduce((s, i) => s + (i.unitPrice || 0) * (i.quantity || 1), 0);
    res.json({ items, subtotal, itemCount: items.length });
  } catch (err) { next(err); }
});

router.post('/:id/items', authenticate, requirePermission('orders', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { productId, quantity, unitPrice, discount } = req.body;
    if (!productId) return res.status(400).json({ error: 'productId required' });
    const product = await prisma.product.findUnique({ where: { id: productId } });
    const price = unitPrice || product?.price || 0;
    const qty = quantity || 1;
    const item = await prisma.orderItem.create({ data: { orderId: req.params.id, productId, quantity: qty, unitPrice: price, discount: discount || 0, total: price * qty * (1 - (discount || 0) / 100) } });
    // Recalculate order total
    const allItems = await prisma.orderItem.findMany({ where: { orderId: req.params.id } });
    const total = allItems.reduce((s, i) => s + (i.total || 0), 0);
    await prisma.order.update({ where: { id: req.params.id }, data: { totalAmount: total } });
    res.status(201).json(item);
  } catch (err) { next(err); }
});

// Clone order
router.post('/:id/clone', authenticate, requirePermission('orders', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { items: true } });
    if (!order) return res.status(404).json({ error: 'Not found' });
    const { id, createdAt, updatedAt, items, orderNumber, ...data } = order;
    const clone = await createNumbered(prisma, 'order', ORDER_NUMBER, { data: { ...data, status: 'Draft', name: `${order.name} (Copy)`, createdById: req.user.id } });
    for (const item of items) {
      const { id: iId, orderId, createdAt: iC, updatedAt: iU, ...iData } = item;
      await prisma.orderItem.create({ data: { ...iData, orderId: clone.id } });
    }
    res.status(201).json(clone);
  } catch (err) { next(err); }
});

// Order metrics
router.get('/stats/summary', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 86400000);
    const [total, fulfilled, cancelled, recent, revenueAgg] = await Promise.all([
      prisma.order.count({ where: { deletedAt: null } }),
      prisma.order.count({ where: { status: 'Fulfilled', deletedAt: null } }),
      prisma.order.count({ where: { status: 'Cancelled', deletedAt: null } }),
      prisma.order.count({ where: { createdAt: { gte: thirtyDaysAgo }, deletedAt: null } }),
      prisma.order.aggregate({ where: { status: 'Fulfilled', deletedAt: null }, _sum: { totalAmount: true }, _avg: { totalAmount: true } }),
    ]);
    res.json({ totalOrders: total, fulfilled, cancelled, last30Days: recent, fulfillmentRate: total ? Math.round(fulfilled / total * 100) : 0, totalRevenue: revenueAgg._sum.totalAmount || 0, avgOrderValue: Math.round(revenueAgg._avg.totalAmount || 0) });
  } catch (err) { next(err); }
});
