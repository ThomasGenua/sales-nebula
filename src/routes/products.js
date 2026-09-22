const { createCrudRouter } = require('../utils/crud');
const { auditMiddleware } = require('../middleware/audit');
const { requirePermission, authenticate } = require('../middleware/auth');

const router = createCrudRouter('product', 'products', {
  searchFilter: (q) => ({
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      { sku: { contains: q, mode: 'insensitive' } },
    ],
  }),
  validate: (data) => {
    const errors = {};
    if (!data.name?.trim()) errors.name = 'Required';
    if (!data.sku?.trim()) errors.sku = 'Required';
    return { valid: Object.keys(errors).length === 0, errors };
  },
  beforeCreate: (data) => ({ ...data, price: parseFloat(data.price) || 0, cost: parseFloat(data.cost) || 0 }),
  orderBy: { name: 'asc' },
  customRoutes: (router) => {
    // GET /api/products/categories - Unique category list
    router.get('/categories/list', requirePermission('products', 'read'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const products = await prisma.product.findMany({ select: { category: true }, distinct: ['category'] });
        const categories = products.map(p => p.category).filter(Boolean).sort();
        res.json({ data: categories });
      } catch (err) { next(err); }
    });

    // GET /api/products/catalog - Active products for quoting
    router.get('/catalog/active', requirePermission('products', 'read'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const { category, search } = req.query;
        let where = { active: true };
        if (category) where.category = category;
        if (search) where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { sku: { contains: search, mode: 'insensitive' } },
        ];

        const products = await prisma.product.findMany({
          where,
          orderBy: { name: 'asc' },
          select: { id: true, name: true, sku: true, price: true, category: true, unit: true, description: true },
        });
        res.json({ data: products });
      } catch (err) { next(err); }
    });

    // POST /api/products/:id/clone
    router.post('/:id/clone', requirePermission('products', 'edit'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const source = await prisma.product.findUnique({ where: { id: req.params.id } });
        if (!source) return res.status(404).json({ error: 'Not found' });

        const { id, createdAt, updatedAt, ...data } = source;
        data.name = `${data.name} (Copy)`;
        data.sku = `${data.sku}-COPY-${Date.now().toString(36).slice(-4)}`;

        const clone = await prisma.product.create({ data });
        res.status(201).json(clone);
      } catch (err) { next(err); }
    });

    // PUT /api/products/:id/toggle-active
    router.put('/:id/toggle-active', requirePermission('products', 'edit'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const product = await prisma.product.findUnique({ where: { id: req.params.id } });
        if (!product) return res.status(404).json({ error: 'Not found' });
        const updated = await prisma.product.update({
          where: { id: req.params.id },
          data: { active: !product.active },
        });
        res.json(updated);
      } catch (err) { next(err); }
    });

    // GET /api/products/stats - Product metrics
    router.get('/stats/overview', requirePermission('products', 'read'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const [total, active, categories] = await Promise.all([
          prisma.product.count(),
          prisma.product.count({ where: { active: true } }),
          prisma.product.findMany({ select: { category: true }, distinct: ['category'] }),
        ]);

        const products = await prisma.product.findMany({ select: { price: true, cost: true, category: true } });
        const avgPrice = products.length > 0 ? products.reduce((s, p) => s + p.price, 0) / products.length : 0;
        const avgMargin = products.length > 0 ? products.reduce((s, p) => s + (p.price > 0 ? (p.price - p.cost) / p.price * 100 : 0), 0) / products.length : 0;

        // Revenue by product (from deal line items)
        const lineItems = await prisma.dealLineItem.findMany({
          where: { productId: { not: null } },
          select: { productId: true, total: true },
        });
        const revenueByProduct = {};
        lineItems.forEach(li => {
          revenueByProduct[li.productId] = (revenueByProduct[li.productId] || 0) + li.total;
        });

        res.json({
          total, active, inactive: total - active,
          categories: categories.length,
          avgPrice: Math.round(avgPrice * 100) / 100,
          avgMargin: Math.round(avgMargin * 10) / 10,
          topProducts: Object.entries(revenueByProduct)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([productId, revenue]) => ({ productId, revenue })),
        });
      } catch (err) { next(err); }
    });
  },
});

// Price book entries for product
router.get('/:id/pricing', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const entries = await prisma.priceBookEntry.findMany({ where: { productId: req.params.id, active: true }, include: { priceBook: { select: { id: true, name: true } } } });
    res.json(entries);
  } catch (err) { next(err); }
});

// Product usage/inventory
router.get('/:id/inventory', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const product = await prisma.product.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, quantityOnHand: true, reorderPoint: true, reorderQuantity: true } });
    const [quotedQty, orderedQty] = await Promise.all([
      prisma.quoteLineItem.aggregate({ where: { productId: req.params.id }, _sum: { quantity: true } }),
      prisma.orderItem.aggregate({ where: { productId: req.params.id }, _sum: { quantity: true } }),
    ]).catch(() => [{}, {}]);
    res.json({ ...product, quotedQuantity: quotedQty?._sum?.quantity || 0, orderedQuantity: orderedQty?._sum?.quantity || 0, needsReorder: (product?.quantityOnHand || 0) <= (product?.reorderPoint || 0) });
  } catch (err) { next(err); }
});

// Clone product
router.post('/:id/clone', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const original = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!original) return res.status(404).json({ error: 'Not found' });
    const { id, createdAt, updatedAt, code, ...data } = original;
    const clone = await prisma.product.create({ data: { ...data, name: `${original.name} (Copy)`, sku: code ? `${code}-COPY` : null, active: false } });
    res.status(201).json(clone);
  } catch (err) { next(err); }
});

// Product bundles
router.get('/:id/bundle', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const items = await prisma.productBundleItem.findMany({ where: { bundleId: req.params.id }, include: { product: { select: { id: true, name: true, price: true } } } }).catch(() => []);
    const totalPrice = items.reduce((s, i) => s + ((i.product?.price || 0) * (i.quantity || 1)), 0);
    res.json({ bundleId: req.params.id, items, totalPrice, itemCount: items.length });
  } catch (err) { next(err); }
});

module.exports = router;
