const { Router } = require('express');
const { pickModelFields, lineItemFields, scalarOrderBy } = require('../utils/modelFields');
const { authenticate, requirePermission } = require('../middleware/auth');
const { recordAccess, reachableWhere, canReach, linkRefusal } = require('../middleware/access');
const { auditMiddleware } = require('../middleware/audit');
const { generateDocumentHtml } = require('../utils/documentTemplate');
const { createNumbered, INVOICE_NUMBER } = require('../utils/numbering');

const router = Router();
router.use(authenticate, auditMiddleware);
// An invoice named in the path must be one row security lets the caller see,
// or change for a write; these took any invoice id with the module permission.
router.param('id', recordAccess('invoices', 'invoice'));

/** Why an invoice's links may not be written, or null: its account and contact, and its quote. */
async function invoiceLinkProblem(req, data, current = null) {
  const problem = await linkRefusal(req, 'invoice', data, current);
  if (problem) return problem;
  const quoteChanged = data.quoteId && (!current || current.quoteId !== data.quoteId);
  if (quoteChanged && !(await canReach(req, 'quotes', 'quote', data.quoteId))) return 'quoteId does not name a quote you can see';
  return null;
}

const include = {
  items: { include: { product: { select: { id: true, name: true } } } },
  quote: { select: { id: true, number: true } },
  account: { select: { id: true, name: true } },
  contact: { select: { id: true, firstName: true, lastName: true } },
};

router.get('/', requirePermission('invoices', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { status, page = 1, limit = 50, search, sortBy, sortDir = 'desc' } = req.query;
    const take = Math.min(parseInt(limit) || 50, 200);
    const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;
    let where = {};
    if (status && status !== 'All') where.status = status;
    if (search) where.number = { contains: search, mode: 'insensitive' };
    // Invoices the caller may see, sorted on one of an invoice's own columns.
    where = await reachableWhere(req, 'invoices', 'invoice', where);
    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({ where, include, orderBy: scalarOrderBy('invoice', sortBy, sortDir) || { createdAt: 'desc' }, skip, take }),
      prisma.invoice.count({ where }),
    ]);
    res.json({ data: invoices, meta: { total, page: parseInt(page), limit: take, pages: Math.ceil(total / take) } });
  } catch (err) { next(err); }
});

router.get('/:id', requirePermission('invoices', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id }, include });
    if (!invoice) return res.status(404).json({ error: 'Not found' });
    res.json(invoice);
  } catch (err) { next(err); }
});

router.post('/', requirePermission('invoices', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { items, ...rest } = req.body;
    // Same reason as the shared CRUD router: one stray key (an "amount" that the
    // model spells subtotal/total) made Prisma reject the entire input.
    const { data } = pickModelFields('invoice', rest);
    const linkProblem = await invoiceLinkProblem(req, data);
    if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
    // Each line cut down to an invoice item's columns; they went in as sent.
    const invoice = await createNumbered(prisma, 'invoice', INVOICE_NUMBER, {
      data: { ...data, items: { create: Array.isArray(items) ? items.map(i => lineItemFields(i, { discount: false })) : [] } },
      include,
    });
    await req.audit({ action: 'create', module: 'invoices', recordId: invoice.id });
    res.status(201).json(invoice);
  } catch (err) { next(err); }
});

router.put('/:id', requirePermission('invoices', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { items, id, createdAt, updatedAt, ...rest } = req.body || {};
    // Real columns only, and no nested writes: the body went to Prisma whole.
    const { data } = pickModelFields('invoice', rest);
    const current = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ error: 'Not found' });
    const linkProblem = await invoiceLinkProblem(req, data, current);
    if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
    const lines = Array.isArray(items) ? items.map(i => lineItemFields(i, { discount: false })) : null;
    const writes = [];
    if (lines) writes.push(prisma.invoiceItem.deleteMany({ where: { invoiceId: req.params.id } }));
    writes.push(prisma.invoice.update({
      where: { id: req.params.id },
      data: { ...data, ...(lines && { items: { create: lines } }) },
      include,
    }));
    const invoice = (await prisma.$transaction(writes)).pop();
    res.json(invoice);
  } catch (err) { next(err); }
});

// Mark as paid
router.post('/:id/pay', requirePermission('invoices', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const invoice = await prisma.invoice.update({
      where: { id: req.params.id },
      data: { status: 'Paid', paidDate: new Date(), payMethod: req.body.payMethod || 'Wire Transfer' },
      include,
    });
    await req.audit({ action: 'update', module: 'invoices', recordId: invoice.id, details: 'Invoice paid' });
    res.json(invoice);
  } catch (err) { next(err); }
});

router.delete('/:id', requirePermission('invoices', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!(await canReach(req, 'invoices', 'invoice', req.params.id, 'Full'))) return res.status(404).json({ error: 'Not found' });
    await prisma.invoice.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Stats
router.get('/stats/summary', requirePermission('invoices', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Over the invoices the caller may see.
    const invoices = await prisma.invoice.findMany({ where: await reachableWhere(req, 'invoices', 'invoice'), include: { items: true } });
    const calcTotal = (inv) => {
      const sub = inv.items.reduce((s, i) => s + (i.price * i.quantity * (1 - i.discount / 100)), 0);
      return sub + sub * (inv.tax || 0) / 100;
    };
    const outstanding = invoices.filter(i => i.status === 'Sent');
    const paid = invoices.filter(i => i.status === 'Paid');
    const overdue = invoices.filter(i => i.status !== 'Paid' && i.dueDate && new Date(i.dueDate) < new Date());
    res.json({
      outstanding: { count: outstanding.length, total: outstanding.reduce((s, i) => s + calcTotal(i), 0) },
      paid: { count: paid.length, total: paid.reduce((s, i) => s + calcTotal(i), 0) },
      overdue: { count: overdue.length },
    });
  } catch (err) { next(err); }
});

// Generate invoice as printable HTML
router.get('/:id/pdf', requirePermission('invoices', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: {
        items: { include: { product: { select: { name: true, sku: true } } } },
        // Account keeps its postcode as billingZip; asking for zip failed every PDF.
        account: { select: { name: true, address: true, city: true, state: true, country: true, billingZip: true } },
        contact: { select: { firstName: true, lastName: true, email: true, phone: true } },
      },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const html = generateDocumentHtml('INVOICE', {
      number: invoice.number,
      date: invoice.date,
      dueDate: invoice.dueDate,
      status: invoice.status,
      terms: invoice.terms,
      notes: invoice.notes,
      account: invoice.account,
      contact: invoice.contact,
      items: invoice.items.map(i => ({
        name: i.product?.name || i.description || 'Item',
        sku: i.product?.sku || '',
        quantity: i.quantity,
        unitPrice: i.unitPrice || i.price,
        discount: 0,
        total: i.total,
      })),
      subtotal: invoice.subtotal,
      discount: 0,
      tax: invoice.tax,
      total: invoice.total,
    });

    if (req.query.format === 'json') {
      return res.json({ invoice, html });
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) { next(err); }
});

module.exports = router;
