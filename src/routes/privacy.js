/**
 * Data subject rights: access, portability and erasure.
 *
 * The consent module records what a person agreed to. This one records what
 * they asked us to do about it, and — unlike the endpoint it replaces — carries
 * it out instead of filing the request as "pending" forever.
 */

const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { resolveSubject, exportSubject, eraseSubject } = require('../services/dataErasure');

const router = Router();

const REQUEST_TYPES = ['export', 'erasure', 'rectification', 'restriction'];

/** A subject is identified by any one of four things; reject a request naming none. */
function readSubjectInput(source) {
  const { contactId, leadId, personAccountId, email } = source || {};
  if (!contactId && !leadId && !personAccountId && !email) return null;
  return { contactId, leadId, personAccountId, email };
}

function subjectTypeOf(input) {
  if (input.contactId) return 'contact';
  if (input.leadId) return 'lead';
  if (input.personAccountId) return 'personAccount';
  return 'email';
}

// ─── REQUESTS ───

// List data subject requests
router.get('/requests', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50, status, requestType } = req.query;
    const where = {};
    if (status) where.status = status;
    if (requestType) where.requestType = requestType;
    // Skip and page count by the capped size: past 200, pages skipped rows.
    const take = Math.min(+limit || 50, 200);
    const [data, total] = await Promise.all([
      prisma.dataSubjectRequest.findMany({
        where, orderBy: { requestedAt: 'desc' },
        take, skip: ((+page || 1) - 1) * take,
      }),
      prisma.dataSubjectRequest.count({ where }),
    ]);
    res.json({ data, total, page: +page || 1, pages: Math.ceil(total / take) });
  } catch (err) { next(err); }
});

// Log a request without acting on it — a subject may have 30 days to be verified.
router.post('/requests', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const input = readSubjectInput(req.body);
    if (!input) return res.status(400).json({ error: 'One of contactId, leadId, personAccountId or email is required' });

    const requestType = req.body.requestType;
    if (!REQUEST_TYPES.includes(requestType)) {
      return res.status(400).json({ error: `requestType must be one of ${REQUEST_TYPES.join(', ')}` });
    }

    const request = await prisma.dataSubjectRequest.create({
      data: {
        requestType,
        subjectType: subjectTypeOf(input),
        contactId: input.contactId || null,
        leadId: input.leadId || null,
        personAccountId: input.personAccountId || null,
        email: input.email || null,
        strategy: req.body.strategy || null,
        notes: req.body.notes || null,
        requestedById: req.userId || null,
      },
    });
    await req.audit({ action: 'create', module: 'privacy', recordId: request.id, details: `${requestType} request logged` });
    res.status(201).json(request);
  } catch (err) { next(err); }
});

router.get('/requests/:id', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const request = await req.app.locals.prisma.dataSubjectRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: 'Request not found' });
    res.json(request);
  } catch (err) { next(err); }
});

// ─── ACCESS & PORTABILITY (Art. 15, 20) ───

// Everything held about one person, in one bundle: admin: full, as erasing
// it is. admin: read, which the default Read Only role has, was enough.
router.post('/export', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const input = readSubjectInput(req.body);
    if (!input) return res.status(400).json({ error: 'One of contactId, leadId, personAccountId or email is required' });

    const subject = await resolveSubject(prisma, input);
    if (!subject.found) return res.status(404).json({ error: 'No data subject matched that identifier' });

    const bundle = await exportSubject(prisma, subject);
    await req.audit({
      action: 'export', module: 'privacy',
      recordId: subject.contactId || subject.leadId || subject.personAccountId,
      details: `Subject access request: ${bundle.recordCount} records exported`,
    });
    res.json(bundle);
  } catch (err) { next(err); }
});

// ─── ERASURE (Art. 17) ───

/**
 * Erasure is not reversible, so it takes `confirm: true` as well as the
 * subject: a stray POST should not cost a customer record.
 */
router.post('/erase', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  const prisma = req.app.locals.prisma;
  let request = null;
  try {
    const input = readSubjectInput(req.body);
    if (!input) return res.status(400).json({ error: 'One of contactId, leadId, personAccountId or email is required' });
    if (req.body.confirm !== true) {
      return res.status(400).json({ error: 'Erasure is irreversible; pass confirm: true to proceed', code: 'CONFIRMATION_REQUIRED' });
    }

    const strategy = req.body.strategy || 'anonymize';
    if (!['anonymize', 'purge'].includes(strategy)) {
      return res.status(400).json({ error: 'strategy must be anonymize or purge' });
    }

    const subject = await resolveSubject(prisma, input);
    if (!subject.found) return res.status(404).json({ error: 'No data subject matched that identifier' });

    // A named request must be an erasure still to do. An export or an already
    // processed request was marked a completed erasure, and an unknown id
    // erased with no request logged at all.
    if (req.body.requestId) {
      const logged = await prisma.dataSubjectRequest.findUnique({ where: { id: String(req.body.requestId) } });
      if (!logged || logged.requestType !== 'erasure') return res.status(404).json({ error: 'Erasure request not found' });
      if (logged.status === 'completed') return res.status(409).json({ error: 'Request has already been processed' });
      request = logged;
    } else {
      request = await prisma.dataSubjectRequest.create({
        data: {
          requestType: 'erasure', subjectType: subjectTypeOf(input), strategy,
          contactId: subject.contactId, leadId: subject.leadId,
          personAccountId: subject.personAccountId, email: subject.emails[0] || input.email || null,
          requestedById: req.userId || null, notes: req.body.notes || null,
        },
      });
    }

    const result = await eraseSubject(prisma, subject, { strategy, actorId: req.userId });

    if (request) {
      request = await prisma.dataSubjectRequest.update({
        where: { id: request.id },
        data: { status: 'completed', strategy, processedAt: new Date(), processedById: req.userId || null, result },
      });
    }

    await req.audit({
      action: 'erase', module: 'privacy',
      recordId: subject.contactId || subject.leadId || subject.personAccountId,
      details: `Erasure (${strategy}): ${result.rowsTouched} rows across ${result.modelsTouched} models`,
    });

    res.json({ request, result });
  } catch (err) {
    if (request) {
      await prisma.dataSubjectRequest.update({
        where: { id: request.id },
        data: { status: 'failed', error: String(err.message).slice(0, 500), processedAt: new Date() },
      }).catch(() => {});
    }
    next(err);
  }
});

/** Carry out a request that was logged earlier and has since been verified. */
router.post('/requests/:id/process', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  const prisma = req.app.locals.prisma;
  const request = await prisma.dataSubjectRequest.findUnique({ where: { id: req.params.id } }).catch(() => null);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status === 'completed') return res.status(409).json({ error: 'Request has already been processed' });

  try {
    const subject = await resolveSubject(prisma, request);
    if (!subject.found) return res.status(404).json({ error: 'No data subject matched that request' });

    let result;
    if (request.requestType === 'export') {
      result = await exportSubject(prisma, subject);
    } else if (request.requestType === 'erasure') {
      result = await eraseSubject(prisma, subject, { strategy: request.strategy || 'anonymize', actorId: req.userId });
    } else {
      return res.status(400).json({ error: `${request.requestType} requests are handled manually`, code: 'MANUAL_REQUEST' });
    }

    const updated = await prisma.dataSubjectRequest.update({
      where: { id: request.id },
      data: { status: 'completed', processedAt: new Date(), processedById: req.userId || null, result },
    });
    await req.audit({ action: 'process', module: 'privacy', recordId: request.id, details: `${request.requestType} request processed` });
    res.json({ request: updated, result });
  } catch (err) {
    await prisma.dataSubjectRequest.update({
      where: { id: request.id },
      data: { status: 'failed', error: String(err.message).slice(0, 500), processedAt: new Date() },
    }).catch(() => {});
    next(err);
  }
});

module.exports = router;
