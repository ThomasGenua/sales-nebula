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
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { SAFE_METHODS, moduleAccess, canReach, reachableWhere } = require('../middleware/access');
const { buildAccessFilter, isAdmin } = require('../middleware/rowSecurity');

const router = Router();

// Consent rows and exports are contacts' personal data: contacts read to look,
// contacts edit to record, and a contact a route names must be one the caller
// can reach. All but /bulk took a session alone, for any contact.
router.use(authenticate, moduleAccess('contacts'));
router.param('contactId', async (req, res, next, contactId) => {
  try {
    const minLevel = SAFE_METHODS.has(req.method) ? 'Read' : 'Edit';
    if (await canReach(req, 'contacts', 'contact', contactId, minLevel)) return next();
    res.status(404).json({ error: 'Contact not found' });
  } catch (err) { next(err); }
});

/** For a contact named in the body: 404 unless the caller may change it. */
async function editableContact(req, res, contactId) {
  if (await canReach(req, 'contacts', 'contact', contactId, 'Edit')) return true;
  res.status(404).json({ error: 'Contact not found' });
  return false;
}

// The records a consent row can name, and the modules they answer to.
const SUBJECTS = [
  { key: 'contactId', module: 'contacts', model: 'contact', label: 'Contact' },
  { key: 'leadId', module: 'leads', model: 'lead', label: 'Lead' },
  { key: 'personAccountId', module: 'personAccounts', model: 'personAccount', label: 'Person account' },
];

/**
 * Which of `emails` are on a live contact, lead or person account the caller
 * can reach at `minLevel`, in a module they hold at that level.
 */
async function reachableAddresses(req, emails, minLevel = 'Read') {
  const found = new Set();
  if (!emails.length) return found;
  for (const { module, model } of SUBJECTS) {
    if (!permits(req, module, minLevel === 'Read' ? 'read' : 'edit')) continue;
    const rows = await req.app.locals.prisma[model].findMany({
      where: await reachableWhere(req, module, model, { email: { in: emails } }, minLevel),
      select: { email: true },
    });
    rows.forEach(r => found.add(r.email));
  }
  return found;
}

/**
 * `where` conditions for the consent rows the caller may see. Each record a
 * row names must be one they can reach, in a module they may read. A row
 * naming only an address is shown to an admin, or when that address is on a
 * contact, lead or person account the caller can reach: an address alone is
 * no record row security can judge, and one on nobody's record is nobody's
 * to show. Only the contact was checked, so rows naming a lead, a person
 * account or just an email went to anyone with contacts read.
 */
async function visibleConsent(req) {
  const prisma = req.app.locals.prisma;
  const conditions = [];
  for (const { key, module, model } of SUBJECTS) {
    if (!permits(req, module, 'read')) { conditions.push({ [key]: null }); continue; }
    // ConsentRecord has no relations, so the records it names are looked up first.
    const filter = await buildAccessFilter(prisma, req.user, module, { modelName: model });
    if (!filter) continue;
    const visible = await prisma[model].findMany({ where: filter, select: { id: true } });
    conditions.push({ OR: [{ [key]: null }, { [key]: { in: visible.map(r => r.id) } }] });
  }
  if (isAdmin(req.user)) return conditions;
  const addressed = await prisma.consentRecord.findMany({
    where: { contactId: null, leadId: null, personAccountId: null, deletedAt: null, email: { not: null } },
    select: { email: true },
    distinct: ['email'],
  });
  const known = await reachableAddresses(req, addressed.map(r => r.email));
  conditions.push({ OR: [{ contactId: { not: null } }, { leadId: { not: null } }, { personAccountId: { not: null } }, { email: { in: [...known] } }] });
  return conditions;
}

/**
 * For a consent row about to be recorded: the caller must be able to change
 * every record it names (403 without the module, 404 for a record they cannot
 * reach), and a row naming only an address needs that address on a contact,
 * lead or person account they can change, unless they are an admin. Only the
 * contact was checked, so consent went on anyone's lead or person account,
 * or any address.
 */
async function editableSubject(req, res, subject) {
  for (const { key, module, model, label } of SUBJECTS) {
    if (!subject[key]) continue;
    if (!permits(req, module, 'edit')) { res.status(403).json({ error: `Insufficient permissions for ${module}` }); return false; }
    if (!(await canReach(req, module, model, subject[key], 'Edit'))) { res.status(404).json({ error: `${label} not found` }); return false; }
  }
  if (subject.contactId || subject.leadId || subject.personAccountId || isAdmin(req.user)) return true;
  if ((await reachableAddresses(req, [String(subject.email)], 'Edit')).size) return true;
  res.status(404).json({ error: 'No contact, lead or person account you can reach has that email' });
  return false;
}

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

    // Only rows whose contact, lead, person account or lone address the
    // caller can reach (visibleConsent).
    const scope = await visibleConsent(req);
    if (scope.length) where.AND = scope;

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
    if (!(await editableSubject(req, res, subject))) return;

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
    if (!(await editableContact(req, res, contactId))) return;

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
    if (!(await editableContact(req, res, contactId))) return;

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
// Consent is appended, never overwritten (see /bulk), so the contact's consent
// rows are its trail. This read ConsentHistory, which nothing writes, and so
// always answered with an empty list.
router.get('/audit/:contactId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rows = await prisma.consentRecord.findMany({
      where: { contactId: req.params.contactId, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 50,
    });
    res.json(rows.map(r => ({
      id: r.id, contactId: r.contactId, type: r.consentType, channel: r.channel,
      action: isGranted(r) ? 'granted' : 'withdrawn', source: r.source, ipAddress: r.ipAddress, createdAt: r.createdAt,
    })));
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

    // Every contact must be a live one the caller may change, or nothing is
    // written: any contact's consent could be rewritten by id.
    const ids = contactIds.slice(0, 500).map(String);
    const reachable = await prisma.contact.findMany({
      where: await reachableWhere(req, 'contacts', 'contact', { id: { in: ids } }, 'Edit'),
      select: { id: true },
    });
    const found = new Set(reachable.map(c => c.id));
    const notFound = [...new Set(ids.filter(id => !found.has(id)))];
    if (notFound.length) return res.status(404).json({ error: 'Contact not found', notFound });

    // There is no unique key on (contactId, consentType), so consent is
    // appended rather than upserted — which is also the correct audit shape:
    // a withdrawal should not overwrite the grant it followed.
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
