const { Router } = require('express');
const { pickModelFields } = require('../utils/modelFields');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { generateDocumentHtml } = require('../utils/documentTemplate');

const router = Router();
router.use(authenticate, auditMiddleware);

const include = {
  items: { include: { product: { select: { id: true, name: true, sku: true } } } },
  deal: { select: { id: true, name: true } },
  account: { select: { id: true, name: true } },
  contact: { select: { id: true, firstName: true, lastName: true } },
};

router.get('/', requirePermission('quotes', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50, status, search, sortBy, sortDir = 'desc' } = req.query;
    const take = Math.min(parseInt(limit) || 50, 200);
    const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;
    let where = {};
    if (status && status !== 'All') where.status = status;
    if (search) where.number = { contains: search, mode: 'insensitive' };
    const [quotes, total] = await Promise.all([
      prisma.quote.findMany({ where, include, orderBy: sortBy ? { [sortBy]: sortDir } : { createdAt: 'desc' }, skip, take }),
      prisma.quote.count({ where }),
    ]);
    res.json({ data: quotes, meta: { total, page: parseInt(page), limit: take, pages: Math.ceil(total / take) } });
  } catch (err) { next(err); }
});

router.get('/:id', requirePermission('quotes', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const quote = await prisma.quote.findUnique({ where: { id: req.params.id }, include });
    if (!quote) return res.status(404).json({ error: 'Not found' });
    res.json(quote);
  } catch (err) { next(err); }
});

router.post('/', requirePermission('quotes', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { items, ...rest } = req.body;
    // Same as invoices: keep only real columns and coerce date-only strings,
    // so a plain "2026-12-31" from a date input does not 500 the create.
    const { data } = pickModelFields('quote', rest);

    // Auto-generate number
    const count = await prisma.quote.count();
    data.number = `QT-${String(count + 1).padStart(3, '0')}`;

    const quote = await prisma.quote.create({
      data: {
        ...data,
        items: { create: items?.map(i => ({ productId: i.productId, name: i.name, quantity: i.quantity, price: i.price, discount: i.discount || 0 })) || [] },
      },
      include,
    });
    await req.audit({ action: 'create', module: 'quotes', recordId: quote.id, details: `Created ${quote.number}` });
    res.status(201).json(quote);
  } catch (err) { next(err); }
});

router.put('/:id', requirePermission('quotes', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { items, id, createdAt, updatedAt, ...data } = req.body;

    // Delete old items and recreate
    if (items) {
      await prisma.quoteItem.deleteMany({ where: { quoteId: req.params.id } });
    }

    const quote = await prisma.quote.update({
      where: { id: req.params.id },
      data: {
        ...data,
        ...(items && { items: { create: items.map(i => ({ productId: i.productId, name: i.name, quantity: i.quantity, price: i.price, discount: i.discount || 0 })) } }),
      },
      include,
    });
    await req.audit({ action: 'update', module: 'quotes', recordId: quote.id });
    res.json(quote);
  } catch (err) { next(err); }
});

// Accept quote
router.post('/:id/accept', requirePermission('quotes', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const quote = await prisma.quote.update({ where: { id: req.params.id }, data: { status: 'Accepted' }, include });
    await req.audit({ action: 'update', module: 'quotes', recordId: quote.id, details: 'Quote accepted' });
    res.json(quote);
  } catch (err) { next(err); }
});

// Create invoice from quote
router.post('/:id/create-invoice', requirePermission('invoices', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const quote = await prisma.quote.findUnique({ where: { id: req.params.id }, include: { items: true } });
    if (!quote) return res.status(404).json({ error: 'Quote not found' });

    const invCount = await prisma.invoice.count();
    const invoice = await prisma.invoice.create({
      data: {
        number: `INV-${String(invCount + 1).padStart(3, '0')}`,
        quoteId: quote.id,
        accountId: quote.accountId,
        contactId: quote.contactId,
        tax: quote.tax,
        notes: quote.notes,
        items: {
          create: quote.items.map(i => ({
            productId: i.productId, name: i.name, quantity: i.quantity, price: i.price, discount: i.discount,
          })),
        },
      },
      include: { items: true },
    });
    await req.audit({ action: 'create', module: 'invoices', recordId: invoice.id, details: `Created from ${quote.number}` });
    res.status(201).json(invoice);
  } catch (err) { next(err); }
});

router.delete('/:id', requirePermission('quotes', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.quote.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Generate quote as HTML (for PDF rendering client-side or print)
router.get('/:id/pdf', requirePermission('quotes', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const quote = await prisma.quote.findUnique({
      where: { id: req.params.id },
      include: {
        items: { include: { product: { select: { name: true, sku: true } } } },
        account: { select: { name: true, address: true, city: true, state: true, country: true, zip: true } },
        contact: { select: { firstName: true, lastName: true, email: true, phone: true } },
      },
    });
    if (!quote) return res.status(404).json({ error: 'Quote not found' });

    const html = generateDocumentHtml('QUOTE', {
      number: quote.number,
      date: quote.createdAt,
      validUntil: quote.validUntil,
      status: quote.status,
      terms: quote.terms,
      notes: quote.notes,
      account: quote.account,
      contact: quote.contact,
      items: quote.items.map(i => ({
        name: i.product?.name || i.name || 'Item',
        sku: i.product?.sku || '',
        quantity: i.quantity,
        unitPrice: i.unitPrice || i.price,
        discount: i.discount || 0,
        total: i.total,
      })),
      subtotal: quote.subtotal,
      discount: quote.discount,
      tax: quote.tax,
      total: quote.total,
    });

    if (req.query.format === 'json') {
      return res.json({ quote, html });
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) { next(err); }
});

module.exports = router;
