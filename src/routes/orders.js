const { createCrudRouter } = require('../utils/crud');
const { auditMiddleware } = require('../middleware/audit');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { reachableWhere, linkRefusal } = require('../middleware/access');
const { ORDER_NUMBER } = require('../utils/numbering');
const { createRecord, updateRecord } = require('../services/recordWrites');
const { lineItemFields } = require('../utils/modelFields');

/** The order's lines as sent, each cut down to the columns an item has. */
const orderLines = req => (Array.isArray(req?.body?.items) ? req.body.items.map(i => lineItemFields(i)) : []);

const sameValue = (a, b) => String(a) === String(b);

/**
 * `data` with `total` (what the seed, the lines and quote conversion write)
 * and `totalAmount` (what the list page, adding an item and the stats use)
 * kept equal, whichever the caller changed. Each writer set one, so an order
 * made with lines showed a total of 0 on the page and counted nothing in
 * revenue, and one made on the page had no total anywhere else.
 */
function withTotals(data, current = {}) {
  const totalChanged = data.total !== undefined && !sameValue(data.total, current.total);
  const twinChanged = data.totalAmount !== undefined && !sameValue(data.totalAmount, current.totalAmount);
  if (twinChanged && !totalChanged) return { ...data, total: data.totalAmount };
  return data.total !== undefined ? { ...data, totalAmount: data.total } : data;
}

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
  // An order must have an account; without one the create answered 500.
  validate: (data) => {
    const errors = {};
    if (!data.accountId) errors.accountId = 'Required';
    return { valid: Object.keys(errors).length === 0, errors };
  },
  beforeCreate: async (data, { req }) => {
    const lines = orderLines(req);
    if (lines.length) {
      data.subtotal = lines.reduce((sum, line) => sum + line.total, 0);
      data.total = data.subtotal + (Number(data.tax) || 0) - (Number(data.discount) || 0);
    }
    return withTotals(data);
  },
  beforeUpdate: async (data, { oldRecord }) => {
    if (data.total === undefined && data.totalAmount === undefined) return data;
    return withTotals(data, oldRecord);
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
    // As an edit (services/recordWrites): the order's rules, the audit trail,
    // the real-time update, and the workflows and webhooks on its status,
    // which an activation, fulfilment or cancellation never reached.
    const { record: order } = await updateRecord(prisma, 'orders', req.params.id, {
      status: 'Activated', activatedDate: new Date(),
    }, { req, userId: req.userId, source: 'activated', include });
    res.json(order);
  } catch (err) { next(err); }
});

// POST /quotes/:quoteId/convert-to-order
router.post('/from-quote/:quoteId', authenticate, requirePermission('orders', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // A live quote the caller can see: the router checks :id, not :quoteId, so
    // any quote id was copied, account, lines and amounts, into an order.
    const quote = permits(req, 'quotes', 'read') && await prisma.quote.findFirst({
      where: await reachableWhere(req, 'quotes', 'quote', { id: String(req.params.quoteId) }),
      include: { items: true },
    });
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    // An order must have an account; without one the create answered 500.
    if (!quote.accountId) return res.status(400).json({ error: 'The quote has no account, and an order needs one' });

    // The subtotal is before the discount, as an order's total is subtotal
    // plus tax less discount; it was taken after it, so the parts did not
    // add up to the total.
    // Made as an order is on its own page (services/recordWrites): number,
    // rules, workflows and webhooks, with the quote's lines as its own.
    const { record: order } = await createRecord(prisma, 'orders', {
      name: `Order - ${quote.name || quote.number}`,
      accountId: quote.accountId,
      contactId: quote.contactId,
      quoteId: quote.id,
      subtotal: quote.total - quote.tax + quote.discount,
      tax: quote.tax,
      total: quote.total,
      totalAmount: quote.total,
      discount: quote.discount,
      ownerId: req.userId,
    }, {
      userId: req.userId, source: `from quote ${quote.number}`, emit: req.app.locals.emit, include,
      nested: {
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
    });
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
    const { record: updated } = await updateRecord(prisma, 'orders', order, {
      status: 'Fulfilled', trackingNumber, carrier, shippedDate: shippedDate ? new Date(shippedDate) : new Date(), fulfilledAt: new Date(), fulfillmentNotes: notes,
    }, { req, userId: req.userId, source: 'fulfilled' });
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
    const { record: updated } = await updateRecord(prisma, 'orders', order, {
      status: 'Cancelled', cancelledAt: new Date(), cancelReason: reason,
    }, { req, userId: req.userId, source: 'cancelled' });
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
    // A live product the caller can see; the id was stored as sent.
    const linkProblem = await linkRefusal(req, 'orderItem', { productId });
    if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
    const product = await prisma.product.findUnique({ where: { id: productId } });
    const price = Number(unitPrice) || product?.price || 0;
    const qty = parseInt(quantity) || 1;
    const off = Number(discount) || 0;
    const item = await prisma.orderItem.create({ data: { orderId: req.params.id, productId, quantity: qty, unitPrice: price, discount: off, total: price * qty * (1 - off / 100) } });
    // Recalculate the order's subtotal and total from its lines, as a create
    // does; only totalAmount was set, so the order's total and PDF kept the old one.
    const allItems = await prisma.orderItem.findMany({ where: { orderId: req.params.id } });
    const subtotal = allItems.reduce((s, i) => s + (i.total || 0), 0);
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, select: { tax: true, discount: true } });
    const total = subtotal + (order?.tax || 0) - (order?.discount || 0);
    // As an edit of the order, so a rule on its total sees the new one.
    await updateRecord(prisma, 'orders', req.params.id, { subtotal, total, totalAmount: total }, { req, userId: req.userId, source: 'line items' });
    res.status(201).json(item);
  } catch (err) { next(err); }
});

// Clone order
router.post('/:id/clone', authenticate, requirePermission('orders', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const order = await prisma.order.findFirst({ where: { id: req.params.id, deletedAt: null }, include: { items: true } });
    if (!order) return res.status(404).json({ error: 'Not found' });
    // A new draft, the caller's: it kept the source's owner, its deleted
    // marker, and its activation, shipping and cancellation.
    const {
      id, createdAt, updatedAt, deletedAt, items, orderNumber,
      activatedDate, fulfilledAt, shippedDate, trackingNumber, carrier, fulfillmentNotes, cancelledAt, cancelReason,
      ...data
    } = order;
    // Made as an order is on its own page, with its lines in the same write;
    // they were copied one by one afterwards, so a failure left a partial copy.
    const { record: clone } = await createRecord(prisma, 'orders', {
      ...data, status: 'Draft', name: `${order.name || order.orderNumber} (Copy)`, ownerId: req.user.id,
    }, {
      userId: req.userId, source: 'clone', emit: req.app.locals.emit,
      nested: { items: { create: items.map(({ id: iId, orderId, createdAt: iC, updatedAt: iU, ...iData }) => iData) } },
    });
    res.status(201).json(clone);
  } catch (err) { next(err); }
});

// Order metrics
router.get('/stats/summary', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 86400000);
    // Over the live orders the caller may see; this counted everyone's. An
    // order's amount is its total, or totalAmount where only that was set.
    const visible = where => reachableWhere(req, 'orders', 'order', where);
    const [total, fulfilled, cancelled, recent, fulfilledOrders] = await Promise.all([
      prisma.order.count({ where: await visible() }),
      prisma.order.count({ where: await visible({ status: 'Fulfilled' }) }),
      prisma.order.count({ where: await visible({ status: 'Cancelled' }) }),
      prisma.order.count({ where: await visible({ createdAt: { gte: thirtyDaysAgo } }) }),
      prisma.order.findMany({ where: await visible({ status: 'Fulfilled' }), select: { total: true, totalAmount: true } }),
    ]);
    const revenue = fulfilledOrders.reduce((s, o) => s + (o.total || o.totalAmount || 0), 0);
    res.json({ totalOrders: total, fulfilled, cancelled, last30Days: recent, fulfillmentRate: total ? Math.round(fulfilled / total * 100) : 0, totalRevenue: revenue, avgOrderValue: fulfilledOrders.length ? Math.round(revenue / fulfilledOrders.length) : 0 });
  } catch (err) { next(err); }
});
