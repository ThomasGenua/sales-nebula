const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();
router.use(authenticate, auditMiddleware);

// ═══════════════════════════════════════
// ─── PRODUCT BUNDLES ───
// ═══════════════════════════════════════

router.get('/bundles', requirePermission('products', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const bundles = await prisma.productBundle.findMany({
      include: { items: { include: { product: { select: { id: true, name: true, sku: true, price: true } } }, orderBy: { sortOrder: 'asc' } } },
      orderBy: { name: 'asc' },
    });
    res.json({ data: bundles });
  } catch (err) { next(err); }
});

router.get('/bundles/:id', requirePermission('products', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const bundle = await prisma.productBundle.findUnique({
      where: { id: req.params.id },
      include: { items: { include: { product: true }, orderBy: { sortOrder: 'asc' } } },
    });
    if (!bundle) return res.status(404).json({ error: 'Not found' });
    res.json(bundle);
  } catch (err) { next(err); }
});

router.post('/bundles', requirePermission('products', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { items, ...data } = req.body;
    const bundle = await prisma.productBundle.create({
      data: { ...data, items: { create: items || [] } },
      include: { items: { include: { product: true } } },
    });
    await req.audit({ action: 'create', module: 'products', recordId: bundle.id, details: `Created bundle: ${bundle.name}` });
    res.status(201).json(bundle);
  } catch (err) { next(err); }
});

router.put('/bundles/:id', requirePermission('products', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { items, id, createdAt, updatedAt, ...data } = req.body;
    if (items) await prisma.productBundleItem.deleteMany({ where: { bundleId: req.params.id } });
    const bundle = await prisma.productBundle.update({
      where: { id: req.params.id },
      data: { ...data, ...(items && { items: { create: items } }) },
      include: { items: { include: { product: true } } },
    });
    res.json(bundle);
  } catch (err) { next(err); }
});

router.delete('/bundles/:id', requirePermission('products', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.productBundle.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /cpq/bundles/:id/configure - Generate line items from a bundle
router.post('/bundles/:id/configure', requirePermission('quotes', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const bundle = await prisma.productBundle.findUnique({
      where: { id: req.params.id },
      include: { items: { include: { product: true } } },
    });
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const { selections = {}, quantity = 1 } = req.body; // selections: { itemId: qty } for optional items

    const lineItems = bundle.items
      .filter(item => item.required || selections[item.id])
      .map(item => ({
        productId: item.product.id,
        name: item.product.name,
        quantity: (selections[item.id] || item.quantity) * quantity,
        price: item.product.price,
        discount: bundle.discount,
      }));

    const subtotal = lineItems.reduce((s, i) => s + (i.price * i.quantity * (1 - i.discount / 100)), 0);

    res.json({ lineItems, subtotal, bundleName: bundle.name, bundleDiscount: bundle.discount });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════
// ─── PRICEBOOKS ───
// ═══════════════════════════════════════

router.get('/pricebooks', requirePermission('products', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const pricebooks = await prisma.pricebook.findMany({
      include: { entries: { include: { product: { select: { id: true, name: true, sku: true } } } } },
      orderBy: { name: 'asc' },
    });
    res.json({ data: pricebooks });
  } catch (err) { next(err); }
});

router.post('/pricebooks', requirePermission('products', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { entries, ...data } = req.body;
    const pricebook = await prisma.pricebook.create({
      data: { ...data, entries: { create: entries || [] } },
      include: { entries: { include: { product: true } } },
    });
    res.status(201).json(pricebook);
  } catch (err) { next(err); }
});

router.put('/pricebooks/:id', requirePermission('products', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { entries, id, createdAt, updatedAt, ...data } = req.body;
    if (entries) await prisma.pricebookEntry.deleteMany({ where: { pricebookId: req.params.id } });
    const pricebook = await prisma.pricebook.update({
      where: { id: req.params.id },
      data: { ...data, ...(entries && { entries: { create: entries } }) },
      include: { entries: { include: { product: true } } },
    });
    res.json(pricebook);
  } catch (err) { next(err); }
});

// GET price for a product (checks pricebook, discount schedule, quantity)
router.post('/price', requirePermission('quotes', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { productId, pricebookId, quantity = 1 } = req.body;

    // Get base price from pricebook or product
    let unitPrice;
    if (pricebookId) {
      const entry = await prisma.pricebookEntry.findUnique({
        where: { pricebookId_productId: { pricebookId, productId } },
      });
      if (entry?.active) unitPrice = entry.unitPrice;
    }
    if (unitPrice === undefined) {
      const product = await prisma.product.findUnique({ where: { id: productId } });
      unitPrice = product?.price || 0;
    }

    // Check discount schedules
    const scheduleLinks = await prisma.productDiscountSchedule.findMany({
      where: { productId },
      include: { schedule: { include: { tiers: { orderBy: { minQty: 'asc' } } } } },
    });

    let discount = 0;
    for (const link of scheduleLinks) {
      if (!link.schedule.active) continue;
      const tier = link.schedule.tiers.find(t => quantity >= t.minQty && (!t.maxQty || quantity <= t.maxQty));
      if (tier) { discount = Math.max(discount, tier.discount); break; }
    }

    const finalPrice = unitPrice * (1 - discount / 100);
    const lineTotal = finalPrice * quantity;

    res.json({ unitPrice, discount, finalPrice, quantity, lineTotal });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════
// ─── DISCOUNT SCHEDULES ───
// ═══════════════════════════════════════

router.get('/discount-schedules', requirePermission('products', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const schedules = await prisma.discountSchedule.findMany({
      include: { tiers: { orderBy: { minQty: 'asc' } }, products: { include: { product: { select: { id: true, name: true } } } } },
    });
    res.json({ data: schedules });
  } catch (err) { next(err); }
});

router.post('/discount-schedules', requirePermission('products', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { tiers, productIds, ...data } = req.body;
    const schedule = await prisma.discountSchedule.create({
      data: {
        ...data,
        tiers: { create: tiers || [] },
        ...(productIds && { products: { create: productIds.map(pid => ({ productId: pid })) } }),
      },
      include: { tiers: true, products: true },
    });
    res.status(201).json(schedule);
  } catch (err) { next(err); }
});

router.delete('/discount-schedules/:id', requirePermission('products', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.discountSchedule.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
