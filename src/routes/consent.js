/**
 * Consent capture (GDPR Art. 6, 7 and 21).
 *
 * Every write in this module used to name columns the schema does not have —
 * `type`, `granted`, `expiresAt`, a `contact` relation — so recording consent
 * returned a 500 and the bulk endpoint reported success while writing nothing.
 * The storage vocabulary is `consentType` / `status` / `expiryDate`; the API
 * keeps the friendlier `type` / `granted` and translates.
 *
 * Erasure and portability live in ./privacy.js.
 */

const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();

const GRANTED = 'OptIn';
const WITHDRAWN = 'OptOut';

const isGranted = row => row.status !== WITHDRAWN;

/** Present a stored row in the vocabulary the API has always advertised. */
const toApi = row => (row && {
  ...row,
  type: row.consentType,
  granted: isGranted(row),
  expiresAt: row.expiryDate,
});

const statusFor = granted => (granted === false ? WITHDRAWN : GRANTED);

/** Consent may be attached to a contact, a lead or a person account. */
function subjectFrom(source) {
  const { contactId, leadId, personAccountId, email } = source || {};
  if (!contactId && !leadId && !personAccountId && !email) return null;
  return {
    contactId: contactId || null,
    leadId: leadId || null,
    personAccountId: personAccountId || null,
    email: email || null,
  };
}

// List all consent records
router.get('/', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50, contactId, leadId, type } = req.query;
    const take = Math.min(+limit || 50, 200);
    const where = { deletedAt: null };
    if (contactId) where.contactId = contactId;
    if (leadId) where.leadId = leadId;
    if (type) where.consentType = type;

    const [rows, total] = await Promise.all([
      prisma.consentRecord.findMany({
        where, orderBy: { createdAt: 'desc' }, take, skip: ((+page || 1) - 1) * take,
      }),
      prisma.consentRecord.count({ where }),
    ]);

    // ConsentRecord has no relation to Contact, so the summary is joined here
    // rather than asked of Prisma, which is what used to throw.
    const contactIds = [...new Set(rows.map(r => r.contactId).filter(Boolean))];
    const contacts = contactIds.length
      ? await prisma.contact.findMany({
        where: { id: { in: contactIds } },
        select: { id: true, firstName: true, lastName: true, email: true },
      })
      : [];
    const byId = new Map(contacts.map(c => [c.id, c]));

    res.json({
      data: rows.map(r => ({ ...toApi(r), contact: byId.get(r.contactId) || null })),
      total, page: +page || 1, pages: Math.ceil(total / take),
    });
  } catch (err) { next(err); }
});

// Record consent
router.post('/', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { type, channel, granted, source, expiresAt } = req.body;
    const subject = subjectFrom(req.body);
    if (!subject) return res.status(400).json({ error: 'One of contactId, leadId, personAccountId or email is required' });
    if (!type) return res.status(400).json({ error: 'type is required' });

    const record = await prisma.consentRecord.create({
      data: {
        ...subject,
        consentType: type,
        status: statusFor(granted),
        channel: channel || 'all',
        source: source || 'manual',
        expiryDate: expiresAt ? new Date(expiresAt) : null,
        ipAddress: req.ip || null,
        recordedById: req.userId || null,
      },
    });
    await req.audit({
      action: 'create', module: 'consent', recordId: record.id,
      details: `Consent ${isGranted(record) ? 'granted' : 'withdrawn'}: ${type}`,
    });
    res.status(201).json(toApi(record));
  } catch (err) { next(err); }
});

// Get consent preferences for a contact — latest record per type wins.
router.get('/preferences/:contactId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const records = await prisma.consentRecord.findMany({
      where: { contactId: req.params.contactId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    const preferences = {};
    for (const r of records) {
      if (preferences[r.consentType]) continue;
      preferences[r.consentType] = {
        granted: isGranted(r),
        channel: r.channel,
        updatedAt: r.createdAt,
        source: r.source,
        expiresAt: r.expiryDate,
      };
    }

    // An expired consent is not a consent.
    const now = new Date();
    for (const pref of Object.values(preferences)) {
      if (pref.expiresAt && new Date(pref.expiresAt) < now) pref.granted = false;
    }

    res.json({ contactId: req.params.contactId, preferences, totalRecords: records.length });
  } catch (err) { next(err); }
});

// Update consent preferences
router.put('/preferences/:contactId', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { preferences } = req.body; // { email_marketing: true, sms: false, ... }
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
      return res.status(400).json({ error: 'preferences object required' });
    }

    const records = [];
    for (const [type, granted] of Object.entries(preferences)) {
      records.push(await prisma.consentRecord.create({
        data: {
          contactId: req.params.contactId,
          consentType: type,
          status: statusFor(granted),
          source: 'preference_update',
          ipAddress: req.ip || null,
          recordedById: req.userId || null,
        },
      }));
    }

    await req.audit({
      action: 'update', module: 'consent', recordId: req.params.contactId,
      details: `Updated ${records.length} consent preferences`,
    });
    res.json({ updated: records.length, records: records.map(toApi) });
  } catch (err) { next(err); }
});

// Process opt-out (GDPR right to object)
router.post('/opt-out', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { contactId, types } = req.body;
    if (!contactId) return res.status(400).json({ error: 'contactId required' });

    const allTypes = Array.isArray(types) && types.length
      ? types
      : ['email_marketing', 'sms_marketing', 'phone_marketing', 'third_party_sharing'];

    const records = await prisma.$transaction(allTypes.map(type => prisma.consentRecord.create({
      data: {
        contactId, consentType: type, status: WITHDRAWN, source: 'opt_out',
        ipAddress: req.ip || null, recordedById: req.userId || null,
      },
    })));

    await req.audit({
      action: 'create', module: 'consent', recordId: contactId,
      details: `Opt-out processed: ${allTypes.join(', ')}`,
    });
    res.json({ optedOut: allTypes, records: records.length });
  } catch (err) { next(err); }
});

/**
 * Log a data subject request. Kept for callers that already point here; the
 * request is stored as a real DataSubjectRequest and can be carried out via
 * POST /api/privacy/requests/:id/process.
 */
router.post('/data-request', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { contactId, requestType } = req.body;
    if (!contactId || !requestType) return res.status(400).json({ error: 'contactId and requestType required' });
    if (!['export', 'delete', 'erasure'].includes(requestType)) {
      return res.status(400).json({ error: 'requestType must be export or erasure' });
    }

    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const request = await prisma.dataSubjectRequest.create({
      data: {
        requestType: requestType === 'delete' ? 'erasure' : requestType,
        subjectType: 'contact',
        contactId,
        email: contact.email || null,
        requestedById: req.userId || null,
      },
    });

    await req.audit({ action: 'create', module: 'consent', recordId: contactId, details: `GDPR ${requestType} request logged` });
    res.status(201).json({
      requestId: request.id, contactId, requestType: request.requestType, status: request.status,
      message: 'Request logged. POST /api/privacy/requests/:id/process to carry it out.',
    });
  } catch (err) { next(err); }
});

// Consent audit trail
router.get('/audit/:contactId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const history = await prisma.consentHistory.findMany({
      where: { contactId: req.params.contactId }, orderBy: { createdAt: 'desc' }, take: 50,
    }).catch(() => []);
    res.json(history);
  } catch (err) { next(err); }
});

// Bulk consent update
router.post('/bulk', authenticate, requirePermission('contacts', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { contactIds, purpose, type, granted } = req.body;
    const consentType = type || purpose;
    if (!Array.isArray(contactIds) || !contactIds.length || !consentType) {
      return res.status(400).json({ error: 'contactIds and type required' });
    }

    // There is no unique key on (contactId, consentType), so consent is
    // appended rather than upserted — which is also the correct audit shape:
    // a withdrawal should not overwrite the grant it followed.
    const ids = contactIds.slice(0, 500);
    const created = await prisma.$transaction(ids.map(contactId => prisma.consentRecord.create({
      data: {
        contactId, consentType, status: statusFor(granted), source: 'bulk_update',
        recordedById: req.userId || null,
      },
    })));

    await req.audit({
      action: 'update', module: 'consent', recordId: null,
      details: `Bulk consent ${statusFor(granted)}: ${consentType} for ${created.length} contacts`,
    });
    res.json({ updated: created.length, total: contactIds.length });
  } catch (err) { next(err); }
});

// GDPR data portability (full export) — the deep version lives at /api/privacy/export
router.get('/data-export/:contactId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = req.params.contactId;
    const [contact, activities, cases, emails, notes, consents] = await Promise.all([
      prisma.contact.findUnique({ where: { id } }),
      prisma.activity.findMany({ where: { contactId: id }, select: { id: true, type: true, subject: true, createdAt: true } }),
      prisma.case.findMany({ where: { contactId: id }, select: { id: true, subject: true, status: true, createdAt: true } }),
      prisma.email.findMany({ where: { contactId: id }, select: { id: true, subject: true, sentAt: true } }).catch(() => []),
      // Notes are keyed by (module, recordId); the old parentModule/parentId
      // query always threw and was swallowed into an empty list.
      prisma.note.findMany({ where: { module: { in: ['contacts', 'contact'] }, recordId: id } }).catch(() => []),
      prisma.consentRecord.findMany({ where: { contactId: id, deletedAt: null } }).catch(() => []),
    ]);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json({ contact, activities, cases, emails, notes, consents: consents.map(toApi), exportedAt: new Date(), format: 'JSON' });
  } catch (err) { next(err); }
});

module.exports = router;
