const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const router = Router();
router.use(authenticate);

// Product Rules
router.get('/product-rules', async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.productRule.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }) }); }
  catch (err) { next(err); }
});
router.post('/product-rules', requirePermission('products', 'edit'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.productRule.create({ data: req.body })); }
  catch (err) { next(err); }
});
router.put('/product-rules/:id', requirePermission('products', 'edit'), async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.productRule.update({ where: { id: req.params.id }, data: req.body })); }
  catch (err) { next(err); }
});
router.delete('/product-rules/:id', requirePermission('products', 'full'), async (req, res, next) => {
  try { await req.app.locals.prisma.productRule.delete({ where: { id: req.params.id } }); res.json({ success: true }); }
  catch (err) { next(err); }
});

// Price Rules
router.get('/price-rules', async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.priceRule.findMany({ where: { active: true }, orderBy: { evalOrder: 'asc' } }) }); }
  catch (err) { next(err); }
});
router.post('/price-rules', requirePermission('products', 'edit'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.priceRule.create({ data: req.body })); }
  catch (err) { next(err); }
});
router.put('/price-rules/:id', requirePermission('products', 'edit'), async (req, res, next) => {
  try { res.json(await req.app.locals.prisma.priceRule.update({ where: { id: req.params.id }, data: req.body })); }
  catch (err) { next(err); }
});

// Guided Selling
router.get('/guided-selling', async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.guidedSellingRule.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }) }); }
  catch (err) { next(err); }
});
router.post('/guided-selling', requirePermission('products', 'edit'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.guidedSellingRule.create({ data: req.body })); }
  catch (err) { next(err); }
});
router.post('/guided-selling/recommend', async (req, res, next) => {
  try {
    const rules = await req.app.locals.prisma.guidedSellingRule.findMany({ where: { active: true } });
    const answers = req.body.answers || {};
    const products = [];
    for (const rule of rules) {
      for (const mapping of (rule.productMapping || [])) {
        const match = Object.entries(mapping.answers || {}).every(([q, a]) => answers[q] === a);
        if (match) products.push(...(mapping.products || []));
      }
    }
    const unique = [...new Set(products)];
    const productRecords = unique.length > 0 ? await req.app.locals.prisma.product.findMany({ where: { id: { in: unique } } }) : [];
    res.json({ recommended: productRecords });
  } catch (err) { next(err); }
});

// Discount Schedules
router.get('/discount-schedules', async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.discountSchedule.findMany({ where: { active: true } }) }); }
  catch (err) { next(err); }
});
router.post('/discount-schedules', requirePermission('products', 'edit'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.discountSchedule.create({ data: req.body })); }
  catch (err) { next(err); }
});
router.post('/discount-schedules/calculate', async (req, res, next) => {
  try {
    const { productId, quantity } = req.body;
    // A schedule reaches its products through ProductDiscountSchedule, and a
    // tier's columns are minQuantity / maxQuantity / discountPercent. minQty,
    // maxQty and discount were never set, so no quantity earned a discount.
    const schedule = await req.app.locals.prisma.discountSchedule.findFirst({
      where: { active: true, products: { some: { productId } } },
      include: { tiers: { orderBy: { minQuantity: 'asc' } } },
    });
    if (!schedule) return res.json({ discount: 0, type: 'none' });
    const tier = schedule.tiers.find(t => quantity >= t.minQuantity && (t.maxQuantity == null || quantity <= t.maxQuantity));
    res.json({ discount: tier?.discountPercent || 0, type: schedule.type, tier });
  } catch (err) { next(err); }
});

// Quote validation (apply product + price rules)
router.post('/validate-quote', async (req, res, next) => {
  try {
    const { lineItems } = req.body;
    const productRules = await req.app.locals.prisma.productRule.findMany({ where: { active: true, type: 'Validation' } });
    const errors = []; const warnings = [];
    for (const rule of productRules) {
      const conditions = rule.conditions || [];
      for (const item of (lineItems || [])) {
        const match = conditions.every(c => {
          const val = item[c.field];
          if (c.operator === 'equals') return val === c.value;
          if (c.operator === 'gt') return val > c.value;
          if (c.operator === 'lt') return val < c.value;
          if (c.operator === 'contains') return String(val).includes(c.value);
          return false;
        });
        if (match && rule.type === 'Validation') errors.push({ rule: rule.name, message: rule.errorMessage, item });
        if (match && rule.type === 'Alert') warnings.push({ rule: rule.name, message: rule.errorMessage, item });
      }
    }
    res.json({ valid: errors.length === 0, errors, warnings });
  } catch (err) { next(err); }
});

module.exports = router;

// Pricing simulation
router.post('/simulate', authenticate, async (req, res, next) => {
  try {
    const { products, discountPercent = 0, quantity = 1 } = req.body;
    if (!products?.length) return res.status(400).json({ error: 'products required' });
    const prisma = req.app.locals.prisma;
    const lineItems = [];
    for (const p of products) {
      const product = await prisma.product.findUnique({ where: { id: p.productId } });
      if (!product) continue;
      const basePrice = product.price || 0;
      const qty = p.quantity || quantity;
      const discount = p.discount || discountPercent;
      const linePrice = basePrice * qty * (1 - discount / 100);
      lineItems.push({ productId: product.id, name: product.name, basePrice, quantity: qty, discount, lineTotal: Math.round(linePrice * 100) / 100 });
    }
    const subtotal = lineItems.reduce((s, l) => s + l.lineTotal, 0);
    res.json({ lineItems, subtotal, tax: Math.round(subtotal * 0.08 * 100) / 100, total: Math.round(subtotal * 1.08 * 100) / 100 });
  } catch (err) { next(err); }
});

// Approval matrix
router.get('/approval-matrix', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rules = await prisma.cpqApprovalRule.findMany({ where: { active: true }, orderBy: { priority: 'asc' } }).catch(() => [
      { threshold: 10000, approver: 'Sales Manager', autoApprove: false },
      { threshold: 50000, approver: 'VP Sales', autoApprove: false },
      { threshold: 100000, approver: 'CRO', autoApprove: false },
    ]);
    res.json(rules);
  } catch (err) { next(err); }
});


// Bulk status update
router.post('/bulk/status', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { ids, status } = req.body;
    if (!ids?.length || !status) return res.status(400).json({ error: 'ids and status required' });
    const updated = await Promise.all(ids.slice(0, 100).map(async (id) => {
      try { return await prisma.$executeRaw`UPDATE "advancedCpq" SET status = ${status} WHERE id = ${id}`; }
      catch (e) { return null; }
    }));
    await req.audit({ action: 'bulk_update', module: 'advancedCpq', details: `Bulk status update: ${ids.length} records to ${status}` });
    res.json({ updated: updated.filter(Boolean).length, requested: ids.length });
  } catch (err) { next(err); }
});
