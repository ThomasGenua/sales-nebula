const { Router } = require('express');
const { pickModelFields, lineItemFields, scalarOrderBy } = require('../utils/modelFields');
const { authenticate, requirePermission } = require('../middleware/auth');
const { recordAccess, reachableWhere, canReach, linkRefusal, visibleLinks } = require('../middleware/access');
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

const sameValue = (a, b) => String(a instanceof Date ? a.toISOString() : a) === String(b instanceof Date ? b.toISOString() : b);

/**
 * `data` with `total` (what the PDF and the stats read) and `totalAmount`
 * (what the list page reads) kept equal, whichever the caller changed; each
 * writer set one. Lines, when sent, give the subtotal, and the total is it
 * plus tax; they were saved and the totals left at 0.
 */
function invoiceAmounts(data, lines, current = {}) {
  const out = { ...data };
  if (lines) {
    out.subtotal = lines.reduce((sum, line) => sum + line.total, 0);
    out.total = out.subtotal + (Number(out.tax ?? current.tax) || 0);
  }
  const totalChanged = out.total !== undefined && !sameValue(out.total, current.total);
  const twinChanged = out.totalAmount !== undefined && !sameValue(out.totalAmount, current.totalAmount);
  if (twinChanged && !totalChanged) out.total = out.totalAmount;
  else if (out.total !== undefined) out.totalAmount = out.total;
  return out;
}

/**
 * Why these lines may not be saved, or null: each names a live product the
 * caller can see, other than the products the invoice already has (`kept`).
 */
async function lineProblem(req, lines, kept = new Set()) {
  const seen = new Map();
  for (const line of lines) {
    if (!line.productId) return 'Each line needs a productId';
    if (kept.has(line.productId)) continue;
    const problem = await linkRefusal(req, 'invoiceItem', { productId: line.productId }, null, seen);
    if (problem) return problem;
  }
  return null;
}

// A line as its columns, to tell whether a set of lines changed.
const lineKey = l => [l.productId, l.description ?? null, l.quantity, l.unitPrice, l.total].join('|');

router.get('/', requirePermission('invoices', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { status, page = 1, limit = 50, search, sortBy, sortDir = 'desc' } = req.query;
    const take = Math.min(parseInt(limit) || 50, 200);
    const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;
    let where = {};
    if (status && status !== 'All') where.status = status;
    // By either number column; an invoice made with invoiceNumber was not found by it.
    if (search) where.OR = ['number', 'invoiceNumber'].map(f => ({ [f]: { contains: String(search), mode: 'insensitive' } }));
    // Invoices the caller may see, sorted on one of an invoice's own columns.
    where = await reachableWhere(req, 'invoices', 'invoice', where);
    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({ where, include, orderBy: scalarOrderBy('invoice', sortBy, sortDir) || { createdAt: 'desc' }, skip, take }),
      prisma.invoice.count({ where }),
    ]);
    // Linked records as far as the caller may see them, as the CRUD lists do.
    await visibleLinks(req, 'invoice', invoices, include);
    res.json({ data: invoices, meta: { total, page: parseInt(page), limit: take, pages: Math.ceil(total / take) } });
  } catch (err) { next(err); }
});

router.get('/:id', requirePermission('invoices', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // A live invoice, as the list shows: a deleted one still opened here.
    const invoice = await prisma.invoice.findFirst({ where: await reachableWhere(req, 'invoices', 'invoice', { id: req.params.id }), include });
    if (!invoice) return res.status(404).json({ error: 'Not found' });
    res.json(await visibleLinks(req, 'invoice', invoice, include));
  } catch (err) { next(err); }
});

router.post('/', requirePermission('invoices', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // The server sets the id, timestamps and deletion, as the CRUD routers do.
    const { items, id, createdAt, updatedAt, deletedAt, ...rest } = req.body || {};
    // Same reason as the shared CRUD router: one stray key (an "amount" that the
    // model spells subtotal/total) made Prisma reject the entire input.
    const { data } = pickModelFields('invoice', rest);
    const linkProblem = await invoiceLinkProblem(req, data);
    if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
    // Each line cut down to an invoice item's columns; they went in as sent.
    const lines = Array.isArray(items) ? items.map(i => lineItemFields(i, { discount: false })) : [];
    const badLine = await lineProblem(req, lines);
    if (badLine) return res.status(400).json({ error: badLine, code: 'LINK_NOT_VISIBLE' });
    const invoice = await createNumbered(prisma, 'invoice', INVOICE_NUMBER, {
      data: { ...invoiceAmounts(data, lines.length ? lines : null), items: { create: lines } },
      include,
    });
    await req.audit({ action: 'create', module: 'invoices', recordId: invoice.id });
    res.status(201).json(invoice);
  } catch (err) { next(err); }
});

router.put('/:id', requirePermission('invoices', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Not deletedAt either, as the CRUD routers keep it: edit permission set
    // it, deleting (or restoring) what DELETE needs full permission for.
    const { items, id, createdAt, updatedAt, deletedAt, ...rest } = req.body || {};
    // Real columns only, and no nested writes: the body went to Prisma whole.
    const { data } = pickModelFields('invoice', rest);
    const current = await prisma.invoice.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!current) return res.status(404).json({ error: 'Not found' });
    const linkProblem = await invoiceLinkProblem(req, data, current);
    if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
    // The page sends an invoice's lines back with every edit. They are
    // replaced, and the totals worked out from them, only when they changed,
    // so marking an invoice sent neither reworks its amounts nor re-checks
    // the lines it has.
    const sent = Array.isArray(items) ? items.map(i => lineItemFields(i, { discount: false })) : null;
    const stored = sent ? await prisma.invoiceItem.findMany({ where: { invoiceId: req.params.id } }) : [];
    const lines = sent && sent.map(lineKey).sort().join() !== stored.map(lineKey).sort().join() ? sent : null;
    const badLine = lines && await lineProblem(req, lines, new Set(stored.map(i => i.productId)));
    if (badLine) return res.status(400).json({ error: badLine, code: 'LINK_NOT_VISIBLE' });
    const writes = [];
    if (lines) writes.push(prisma.invoiceItem.deleteMany({ where: { invoiceId: req.params.id } }));
    writes.push(prisma.invoice.update({
      where: { id: req.params.id },
      data: { ...invoiceAmounts(data, lines && lines.length ? lines : null, current), ...(lines && { items: { create: lines } }) },
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
    // A soft delete into the recycle bin, as the CRUD modules delete. The row
    // was removed outright, so the bin, which lists invoices, never got one
    // to restore.
    const invoice = await prisma.invoice.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!invoice) return res.status(404).json({ error: 'Not found' });
    await prisma.invoice.update({ where: { id: invoice.id }, data: { deletedAt: new Date() } });
    await prisma.recycleBinItem.create({
      data: { module: 'invoices', recordId: invoice.id, recordData: invoice, deletedById: req.userId, expiresAt: new Date(Date.now() + 30 * 86400000) },
    }).catch(() => { /* Recycle bin is best-effort */ });
    await req.audit({ action: 'delete', module: 'invoices', recordId: invoice.id, details: `Deleted ${invoice.number}` });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Stats
router.get('/stats/summary', requirePermission('invoices', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Over the invoices the caller may see.
    const invoices = await prisma.invoice.findMany({ where: await reachableWhere(req, 'invoices', 'invoice'), include: { items: true } });
    // An invoice's amount is its total. This summed item price and discount,
    // which invoice items do not have, so every total came out NaN (null),
    // and read tax, an amount, as a percentage. Lines with no stored total
    // still count, at the lines' total plus tax.
    const calcTotal = (inv) => inv.total || (inv.items.reduce((s, i) => s + (i.total || 0), 0) + (inv.tax || 0));
    // Still owed: sent, or marked overdue by the daily job, which took them
    // out of outstanding. Overdue: owed and past due; a draft or cancelled
    // invoice is neither.
    const outstanding = invoices.filter(i => ['Sent', 'Overdue'].includes(i.status));
    const paid = invoices.filter(i => i.status === 'Paid');
    const overdue = outstanding.filter(i => i.status === 'Overdue' || (i.dueDate && new Date(i.dueDate) < new Date()));
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
