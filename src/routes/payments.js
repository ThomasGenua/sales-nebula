const {
  Router
} = require('express');
const {
  authenticate,
  requirePermission
} = require('../middleware/auth');
const {
  recordAccess
} = require('../middleware/access');
const service = require('../services/payments');
const router = Router();
router.use(authenticate);
router.param('id', recordAccess('invoices', 'invoice'));
router.get('/:id', requirePermission('invoices', 'read'), async (req, res, next) => {
  try {
    const db = req.app.locals.prisma,
      invoice = await db.invoice.findUnique({
        where: {
          id: req.params.id
        }
      });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    res.json({
      ...(await service.balance(db, invoice)),
      checkouts: await db.paymentCheckout.findMany({
        where: {
          invoiceId: invoice.id
        },
        orderBy: {
          createdAt: 'desc'
        },
        take: 50
      }),
      remindersEnabled: invoice.remindersEnabled,
      nextReminderAt: invoice.nextReminderAt,
      lastReminderError: invoice.lastReminderError
    });
  } catch (e) {
    next(e);
  }
});
router.post('/:id/record', requirePermission('invoices', 'edit'), async (req, res, next) => {
  try {
    if (typeof req.body.reference !== 'string' || !req.body.reference.trim() || req.body.reference.length > 150) return res.status(400).json({
      error: 'A payment reference is required'
    });
    const db = req.app.locals.prisma,
      invoice = await db.invoice.findUnique({
        where: {
          id: req.params.id
        }
      });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    res.json(await service.recordPayment(db, invoice.id, {
      amountMinor: service.minor(req.body.amount),
      currency: invoice.currency,
      provider: 'manual',
      reference: 'manual:' + req.body.reference,
      createdById: req.userId
    }, {
      req,
      userId: req.userId
    }));
  } catch (e) {
    next(e);
  }
});
router.post('/:id/checkout', requirePermission('invoices', 'edit'), async (req, res, next) => {
  try {
    const db = req.app.locals.prisma;
    const invoice = await db.invoice.findUnique({
      where: {
        id: req.params.id
      }
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    res.json(await service.checkout(db, invoice, req.userId, req.body.amount));
  } catch (e) {
    next(e);
  }
});
router.post('/:id/reconcile', requirePermission('invoices', 'edit'), async (req, res, next) => {
  try {
    const db = req.app.locals.prisma,
      row = await db.paymentCheckout.findFirst({
        where: {
          invoiceId: req.params.id,
          sessionId: String(req.body.sessionId)
        }
      });
    if (!row) return res.status(404).json({
      error: 'Checkout not found'
    });
    res.json(await service.reconcile(db, row.sessionId));
  } catch (e) {
    next(e);
  }
});
router.post('/:id/reminders', requirePermission('invoices', 'edit'), async (req, res, next) => {
  try {
    if (typeof req.body.enabled !== 'boolean') return res.status(400).json({
      error: 'Choose whether reminders are enabled'
    });
    const {
      record
    } = await require('../services/recordWrites').updateRecord(req.app.locals.prisma, 'invoices', req.params.id, {
      remindersEnabled: req.body.enabled,
      remindersOwnerId: req.userId,
      nextReminderAt: req.body.enabled ? new Date() : null
    }, {
      req,
      userId: req.userId,
      managedFields: true
    });
    res.json(record);
  } catch (e) {
    next(e);
  }
});
const adjustments = require('../services/billingAdjustments');
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
router.post('/:id/credit-notes', requirePermission('invoices', 'edit'), wrap(async (req, res) => res.status(201).json(await adjustments.creditNote(req.app.locals.prisma, req.params.id, req.body, { req, userId: req.userId }))));
router.post('/:id/refunds', requirePermission('invoices', 'edit'), wrap(async (req, res) => res.status(201).json(await adjustments.refund(req.app.locals.prisma, req.params.id, req.body, { req, userId: req.userId }))));
router.post('/:id/reconcile-ledger', requirePermission('invoices', 'edit'), wrap(async (req, res) => res.json(await adjustments.reconcileInvoice(req.app.locals.prisma, req.params.id))));
router.get('/:id/credit-notes/:adjustmentId/pdf', requirePermission('invoices', 'read'), wrap(async (req, res) => {
  const db = req.app.locals.prisma, note = await db.invoiceAdjustment.findFirst({ where: { id: req.params.adjustmentId, invoiceId: req.params.id, kind: 'CreditNote', status: 'Issued' } });
  if (!note) return res.status(404).json({ error: 'Credit note not found' });
  const invoice = await db.invoice.findUnique({ where: { id: req.params.id } });
  const doc = new (require('pdfkit'))({ size: 'A4', margin: 54 });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="credit-note-' + note.id + '.pdf"', 'Cache-Control': 'no-store' });
  doc.on('error', e => res.destroy(e)); doc.pipe(res);
  doc.fontSize(24).text('Credit note').moveDown(); doc.fontSize(11).text('Reference: ' + note.reference).text('Invoice: ' + invoice.number).text('Issued: ' + note.createdAt.toISOString().slice(0, 10)).moveDown();
  doc.fontSize(18).text(note.currency + ' ' + (note.amountMinor / 100).toFixed(2)).moveDown(); doc.fontSize(11).text('Reason: ' + note.reason).moveDown().text('This credit reduces the invoice amount owed. A refund, when applicable, is recorded separately in the payment ledger.'); doc.end();
}));
module.exports = router;
