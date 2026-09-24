const { Router } = require('express');
const { pickModelFields, lineItemFields, scalarOrderBy } = require('../utils/modelFields');
const { authenticate, requirePermission } = require('../middleware/auth');
const { recordAccess, reachableWhere, canReach, linkRefusal, visibleLinks } = require('../middleware/access');
const { auditMiddleware } = require('../middleware/audit');
const { generateDocumentHtml } = require('../utils/documentTemplate');
const { currencyContext } = require('../utils/currency');
const { createNumbered, QUOTE_NUMBER, INVOICE_NUMBER } = require('../utils/numbering');
const { fireWebhookEvent } = require('../services/webhooks');

const router = Router();
router.use(authenticate, auditMiddleware);
// A quote named in the path must be one row security lets the caller see, or
// change for a write; these took any quote id with the module permission alone.
router.param('id', recordAccess('quotes', 'quote'));

const include = {
  items: { include: { product: { select: { id: true, name: true, sku: true } } } },
  deal: { select: { id: true, name: true } },
  account: { select: { id: true, name: true } },
  contact: { select: { id: true, firstName: true, lastName: true } },
};

const sameValue = (a, b) => String(a instanceof Date ? a.toISOString() : a) === String(b instanceof Date ? b.toISOString() : b);

/**
 * `data` with the columns a quote carries twice kept equal: `total` (what the
 * PDF, invoices and orders read) and `totalAmount` (what the list page and
 * the quote extras read), and `validUntil` and `expirationDate`. Each writer
 * set one, so a quote made on the page had no expiry on its PDF and one made
 * here showed no total on the page. Whichever of a pair the caller changed
 * wins. Lines, when sent, give the subtotal, and the total is it less the
 * discount plus tax, as the PDF sets it out; they were saved and the totals
 * left at 0.
 */
function quoteAmounts(data, lines, current = {}) {
  const out = { ...data };
  if (lines) {
    out.subtotal = lines.reduce((sum, line) => sum + line.total, 0);
    out.total = out.subtotal - (Number(out.discount ?? current.discount) || 0) + (Number(out.tax ?? current.tax) || 0);
  }
  for (const [kept, twin] of [['total', 'totalAmount'], ['validUntil', 'expirationDate']]) {
    const keptChanged = out[kept] !== undefined && !sameValue(out[kept], current[kept]);
    const twinChanged = out[twin] !== undefined && !sameValue(out[twin], current[twin]);
    if (twinChanged && !keptChanged) out[kept] = out[twin];
    else if (out[kept] !== undefined) out[twin] = out[kept];
  }
  return out;
}

/**
 * Why these lines may not be saved, or null: each names a live product the
 * caller can see, other than the products the quote already has (`kept`).
 */
async function lineProblem(req, lines, kept = new Set()) {
  const seen = new Map();
  for (const line of lines) {
    if (!line.productId) return 'Each line needs a productId';
    if (kept.has(line.productId)) continue;
    const problem = await linkRefusal(req, 'quoteItem', { productId: line.productId }, null, seen);
    if (problem) return problem;
  }
  return null;
}

// A line as its columns, to tell whether a set of lines changed.
const lineKey = l => [l.productId, l.description ?? null, l.quantity, l.unitPrice, l.discount ?? 0, l.total].join('|');

router.get('/', requirePermission('quotes', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50, status, search, sortBy, sortDir = 'desc' } = req.query;
    const take = Math.min(parseInt(limit) || 50, 200);
    const skip = (Math.max(parseInt(page) || 1, 1) - 1) * take;
    let where = {};
    if (status && status !== 'All') where.status = status;
    // By number or name: the page lists quotes by name, and a search matched
    // the number alone.
    if (search) where.OR = ['number', 'quoteNumber', 'name'].map(f => ({ [f]: { contains: String(search), mode: 'insensitive' } }));
    // Quotes the caller may see, sorted on one of a quote's own columns.
    where = await reachableWhere(req, 'quotes', 'quote', where);
    const [quotes, total] = await Promise.all([
      prisma.quote.findMany({ where, include, orderBy: scalarOrderBy('quote', sortBy, sortDir) || { createdAt: 'desc' }, skip, take }),
      prisma.quote.count({ where }),
    ]);
    // Linked records as far as the caller may see them, as the CRUD lists do.
    await visibleLinks(req, 'quote', quotes, include);
    res.json({ data: quotes, meta: { total, page: parseInt(page), limit: take, pages: Math.ceil(total / take) } });
  } catch (err) { next(err); }
});

router.get('/:id', requirePermission('quotes', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // A live quote, as the list shows: a deleted one still opened here.
    const quote = await prisma.quote.findFirst({ where: await reachableWhere(req, 'quotes', 'quote', { id: req.params.id }), include });
    if (!quote) return res.status(404).json({ error: 'Not found' });
    res.json(await visibleLinks(req, 'quote', quote, include));
  } catch (err) { next(err); }
});

router.post('/', requirePermission('quotes', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // The server sets the id, timestamps and deletion, as the CRUD routers do.
    const { items, id, createdAt, updatedAt, deletedAt, ...rest } = req.body || {};
    // Same as invoices: keep only real columns and coerce date-only strings,
    // so a plain "2026-12-31" from a date input does not 500 the create.
    const { data } = pickModelFields('quote', rest);
    const linkProblem = await linkRefusal(req, 'quote', data);
    if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });

    // The items were written with name and price, which quote items do not
    // have, so a quote with lines never saved.
    const lines = Array.isArray(items) ? items.map(i => lineItemFields(i)) : [];
    const badLine = await lineProblem(req, lines);
    if (badLine) return res.status(400).json({ error: badLine, code: 'LINK_NOT_VISIBLE' });
    const quote = await createNumbered(prisma, 'quote', QUOTE_NUMBER, {
      data: {
        ...quoteAmounts(data, lines.length ? lines : null),
        items: { create: lines },
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
    // Not deletedAt either, as the CRUD routers keep it: edit permission set
    // it, deleting (or restoring) what DELETE needs full permission for.
    const { items, id, createdAt, updatedAt, deletedAt, ...rest } = req.body || {};
    // Real columns only, and no nested writes: the body went to Prisma whole.
    const { data } = pickModelFields('quote', rest);
    const current = await prisma.quote.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!current) return res.status(404).json({ error: 'Not found' });
    const linkProblem = await linkRefusal(req, 'quote', data, current);
    if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
    // The page sends a quote's lines back with every edit. They are replaced,
    // and the totals worked out from them, only when they changed, so editing
    // a status neither reworks the amounts nor re-checks the lines it has.
    const sent = Array.isArray(items) ? items.map(i => lineItemFields(i)) : null;
    const stored = sent ? await prisma.quoteItem.findMany({ where: { quoteId: req.params.id } }) : [];
    const lines = sent && sent.map(lineKey).sort().join() !== stored.map(lineKey).sort().join() ? sent : null;
    const badLine = lines && await lineProblem(req, lines, new Set(stored.map(i => i.productId)));
    if (badLine) return res.status(400).json({ error: badLine, code: 'LINK_NOT_VISIBLE' });

    // Replace the items and update the quote together.
    const writes = [];
    if (lines) writes.push(prisma.quoteItem.deleteMany({ where: { quoteId: req.params.id } }));
    writes.push(prisma.quote.update({
      where: { id: req.params.id },
      data: { ...quoteAmounts(data, lines && lines.length ? lines : null, current), ...(lines && { items: { create: lines } }) },
      include,
    }));
    const quote = (await prisma.$transaction(writes)).pop();
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
    await fireWebhookEvent(prisma, 'quote.accepted', { id: quote.id, number: quote.number, total: quote.total });
    res.json(quote);
  } catch (err) { next(err); }
});

// Create invoice from quote
router.post('/:id/create-invoice', requirePermission('invoices', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const quote = await prisma.quote.findFirst({ where: { id: req.params.id, deletedAt: null }, include: { items: true } });
    if (!quote) return res.status(404).json({ error: 'Quote not found' });

    // Invoice items are product, description, quantity, unit price and total;
    // the name, price and discount these were written with are not columns,
    // so a quote with lines never became an invoice. A line's total already
    // has its discount off, and the quote's discount comes off the subtotal.
    // The invoice's amounts are the quote's; they were left at 0.
    const invoice = await createNumbered(prisma, 'invoice', INVOICE_NUMBER, {
      data: {
        quoteId: quote.id,
        accountId: quote.accountId,
        contactId: quote.contactId,
        subtotal: quote.total - quote.tax,
        tax: quote.tax,
        total: quote.total,
        totalAmount: quote.total,
        notes: quote.notes,
        terms: quote.terms,
        items: {
          create: quote.items.map(i => ({
            productId: i.productId, description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, total: i.total,
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
    if (!(await canReach(req, 'quotes', 'quote', req.params.id, 'Full'))) return res.status(404).json({ error: 'Not found' });
    // A soft delete into the recycle bin, as the CRUD modules delete. The row
    // was removed outright: the bin, which lists quotes, never got one to
    // restore, and the quote's invoices lost their link to it.
    const quote = await prisma.quote.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!quote) return res.status(404).json({ error: 'Not found' });
    await prisma.quote.update({ where: { id: quote.id }, data: { deletedAt: new Date() } });
    await prisma.recycleBinItem.create({
      data: { module: 'quotes', recordId: quote.id, recordData: quote, deletedById: req.userId, expiresAt: new Date(Date.now() + 30 * 86400000) },
    }).catch(() => { /* Recycle bin is best-effort */ });
    await req.audit({ action: 'delete', module: 'quotes', recordId: quote.id, details: `Deleted ${quote.number}` });
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
        // Account keeps its postcode as billingZip; asking for zip failed every PDF.
        account: { select: { name: true, address: true, city: true, state: true, country: true, billingZip: true } },
        contact: { select: { firstName: true, lastName: true, email: true, phone: true } },
      },
    });
    if (!quote) return res.status(404).json({ error: 'Quote not found' });

    // In the organisation's currency; a line with no product is named by its
    // description (a quote item has no name, so it printed "Item").
    const html = generateDocumentHtml('QUOTE', {
      currency: (await currencyContext(prisma)).base,
      number: quote.number,
      date: quote.createdAt,
      validUntil: quote.validUntil,
      status: quote.status,
      terms: quote.terms,
      notes: quote.notes,
      account: quote.account,
      contact: quote.contact,
      items: quote.items.map(i => ({
        name: i.product?.name || i.description || 'Item',
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
