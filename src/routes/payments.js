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
    res.json(await service.checkout(db, await db.invoice.findUnique({
      where: {
        id: req.params.id
      }
    }), req.userId, req.body.amount));
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
module.exports = router;
