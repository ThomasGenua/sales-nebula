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
    if (lines.length && data.subtotal === undefined) {
      data.subtotal = lines.reduce((sum, line) => sum + line.total, 0);
      data.total = data.subtotal + (Number(data.tax) || 0) - (Number(data.discount) || 0);
    }
    return withTotals(data);
  },
  beforeUpdate: async (data, { oldRecord, prisma }) => {
    const changed = key => data[key] !== undefined && String(data[key]) !== String(oldRecord[key]);
    if (changed('quoteId')) throw Object.assign(new Error('An existing order cannot change its source quote'), { status: 400 });
    if (oldRecord.quoteId && ['subtotal','tax','discount','total','totalAmount','accountId','contactId'].some(changed)) throw Object.assign(new Error('Revise the source quote and create a replacement order'), { status: 400 });
    if (oldRecord.quoteId && data.status && data.status !== oldRecord.status && data.status !== 'Cancelled') {
      const quote = await prisma.quote.findFirst({ where: { id: oldRecord.quoteId, deletedAt: null }, include: { items: true } });
      if (!quote || quote.total !== oldRecord.total) throw Object.assign(new Error('The source quote has changed'), { status: 400 });
      await require('../services/quotePricing').approvalRequired(prisma, quote, quote.items, quote);
    }
    if (!['subtotal','tax','discount','total','totalAmount'].some(key => data[key] !== undefined)) return data;
    const lines = await prisma.orderItem.findMany({ where: { orderId: oldRecord.id } });
    const subtotal = Math.round(lines.reduce((sum,l) => sum + l.total, 0) * 100) / 100;
    const tax = Number(data.tax ?? oldRecord.tax ?? 0), discount = Number(data.discount ?? oldRecord.discount ?? 0);
    if (!Number.isFinite(tax) || tax < 0 || !Number.isFinite(discount) || discount < 0 || discount > subtotal) throw Object.assign(new Error('Invalid order tax or discount'), { status: 400 });
    const total = Math.round((subtotal + tax - discount) * 100) / 100;
    for (const [key,value] of Object.entries({ subtotal, total, totalAmount: total })) if (data[key] !== undefined && Math.abs(Number(data[key]) - value) > 0.005) throw Object.assign(new Error('Order totals must match its line items'), { status: 400 });
    return { ...data, subtotal, total, totalAmount: total };
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

async function mutateItem(req, res, next) {
  try {
    const db = req.app.locals.prisma, after = [];
    const result = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${req.params.id} FOR UPDATE`;
      const order = await tx.order.findFirst({ where: await reachableWhere(req, 'orders', 'order', { id: req.params.id }, 'Edit'), include: { items: true } });
      if (!order) throw Object.assign(new Error('Not found'), { status: 404 });
      if (order.status !== 'Draft') throw Object.assign(new Error('Only draft orders can change lines'), { status: 409 });
      if (order.quoteId) throw Object.assign(new Error('Revise and approve the source quote, then create a replacement order'), { status: 409 });
      const current = req.params.itemId && order.items.find(i => i.id === req.params.itemId);
      if (req.params.itemId && !current) throw Object.assign(new Error('Item not found'), { status: 404 });
      let candidate;
      if (req.method !== 'DELETE') {
        const input = { ...current, ...req.body };
        const problem = await linkRefusal(req, 'orderItem', { productId: input.productId });
        if (problem) throw Object.assign(new Error(problem), { status: 400 });
        const product = input.productId && await tx.product.findUnique({ where: { id: input.productId } });
        candidate = { productId: input.productId || null, description: input.description || null,
          quantity: Number(input.quantity ?? 1), unitPrice: Number(input.unitPrice ?? product?.price ?? 0), discount: Number(input.discount ?? 0) };
      }
      const sources = order.items.filter(i => i.id !== current?.id);
      if (candidate) sources.push(candidate);
      const priced = await require('../services/orderPricing').prepareOrderLines(tx, order, sources);
      // Reprice the entire order in the same transaction as its totals.
      await tx.orderItem.deleteMany({ where: { orderId: order.id } });
      for (const line of priced.lines) {
        const { id, orderId, createdAt, updatedAt, ...data } = line;
        await tx.orderItem.create({ data: { ...data, ...(id && { id }), orderId: order.id } });
      }
      const { lines, ...totals } = priced;
      await updateRecord(tx, 'orders', order, totals, { req, userId: req.userId, source: 'line items', after, prisma: db });
      return tx.order.findUnique({ where: { id: order.id }, include: { items: true } });
    }, { timeout: 30000 });
    await require('../services/recordWrites').runAfter(after);
    res.status(req.method === 'POST' ? 201 : 200).json(result);
  } catch (err) { next(err); }
}
router.post('/:id/items', authenticate, requirePermission('orders', 'full'), mutateItem);
router.put('/:id/items/:itemId', authenticate, requirePermission('orders', 'full'), mutateItem);
router.delete('/:id/items/:itemId', authenticate, requirePermission('orders', 'full'), mutateItem);

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
