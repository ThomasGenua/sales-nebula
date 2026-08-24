const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();

// List all consent records
router.get('/', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50, contactId, type } = req.query;
    const where = { deletedAt: null };
    if (contactId) where.contactId = contactId;
    if (type) where.type = type;
    const [data, total] = await Promise.all([
      prisma.consentRecord.findMany({ where, orderBy: { createdAt: 'desc' }, take: +limit, skip: (+page - 1) * +limit, include: { contact: { select: { id: true, firstName: true, lastName: true, email: true } } } }),
      prisma.consentRecord.count({ where }),
    ]);
    res.json({ data, total, page: +page, pages: Math.ceil(total / +limit) });
  } catch (err) { next(err); }
});

// Record consent
router.post('/', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { contactId, type, channel, granted, source, expiresAt } = req.body;
    if (!contactId || !type) return res.status(400).json({ error: 'contactId and type required' });
    const record = await prisma.consentRecord.create({
      data: { contactId, type, channel: channel || 'all', granted: granted !== false, source: source || 'manual', expiresAt: expiresAt ? new Date(expiresAt) : null, recordedById: req.user.id },
    });
    await req.audit({ action: 'create', module: 'consent', recordId: record.id, details: `Consent ${granted !== false ? 'granted' : 'withdrawn'}: ${type}` });
    res.status(201).json(record);
  } catch (err) { next(err); }
});

// Get consent preferences for contact
router.get('/preferences/:contactId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const records = await prisma.consentRecord.findMany({
      where: { contactId: req.params.contactId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    // Build consent summary - latest record per type wins
    const preferences = {};
    for (const r of records) {
      if (!preferences[r.type]) {
        preferences[r.type] = { granted: r.granted, channel: r.channel, updatedAt: r.createdAt, source: r.source, expiresAt: r.expiresAt };
      }
    }
    // Check for expired consents
    const now = new Date();
    for (const [type, pref] of Object.entries(preferences)) {
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
    if (!preferences || typeof preferences !== 'object') return res.status(400).json({ error: 'preferences object required' });
    const records = [];
    for (const [type, granted] of Object.entries(preferences)) {
      const record = await prisma.consentRecord.create({
        data: { contactId: req.params.contactId, type, granted: !!granted, source: 'preference_update', recordedById: req.user.id },
      });
      records.push(record);
    }
    await req.audit({ action: 'update', module: 'consent', recordId: req.params.contactId, details: `Updated ${records.length} consent preferences` });
    res.json({ updated: records.length, records });
  } catch (err) { next(err); }
});

// Process opt-out (GDPR right to object)
router.post('/opt-out', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { contactId, types } = req.body;
    if (!contactId) return res.status(400).json({ error: 'contactId required' });
    const allTypes = types || ['email_marketing', 'sms_marketing', 'phone_marketing', 'third_party_sharing'];
    const records = await prisma.$transaction(
      allTypes.map(type => prisma.consentRecord.create({
        data: { contactId, type, granted: false, source: 'opt_out', recordedById: req.user.id },
      }))
    );
    await req.audit({ action: 'create', module: 'consent', recordId: contactId, details: `Opt-out processed: ${allTypes.join(', ')}` });
    res.json({ optedOut: allTypes, records: records.length });
  } catch (err) { next(err); }
});

// GDPR data export request
router.post('/data-request', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { contactId, requestType } = req.body; // requestType: 'export' or 'delete'
    if (!contactId || !requestType) return res.status(400).json({ error: 'contactId and requestType required' });
    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    // Log the data subject request
    const request = await prisma.consentRecord.create({
      data: { contactId, type: `dsr_${requestType}`, granted: true, source: 'data_subject_request', recordedById: req.user.id },
    });
    await req.audit({ action: 'create', module: 'consent', recordId: contactId, details: `GDPR ${requestType} request logged` });
    res.status(201).json({ requestId: request.id, contactId, requestType, status: 'pending', message: 'Data subject request has been logged for processing' });
  } catch (err) { next(err); }
});

module.exports = router;

// Consent audit trail
router.get('/audit/:contactId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const history = await prisma.consentHistory.findMany({ where: { contactId: req.params.contactId }, orderBy: { createdAt: 'desc' }, take: 50 }).catch(() => []);
    res.json(history);
  } catch (err) { next(err); }
});

// Bulk consent update
router.post('/bulk', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { contactIds, purpose, granted } = req.body;
    if (!contactIds?.length || !purpose) return res.status(400).json({ error: 'contactIds and purpose required' });
    let updated = 0;
    for (const id of contactIds.slice(0, 500)) {
      try {
        await prisma.consentRecord.upsert({ where: { contactId_purpose: { contactId: id, purpose } }, update: { granted, updatedAt: new Date() }, create: { contactId: id, purpose, granted } });
        updated++;
      } catch (e) {}
    }
    res.json({ updated, total: contactIds.length });
  } catch (err) { next(err); }
});

// GDPR data portability (full export)
router.get('/data-export/:contactId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = req.params.contactId;
    const [contact, activities, cases, emails, notes] = await Promise.all([
      prisma.contact.findUnique({ where: { id } }),
      prisma.activity.findMany({ where: { contactId: id }, select: { id: true, type: true, subject: true, createdAt: true } }),
      prisma.case.findMany({ where: { contactId: id }, select: { id: true, subject: true, status: true, createdAt: true } }),
      prisma.email.findMany({ where: { contactId: id }, select: { id: true, subject: true, sentAt: true } }).catch(() => []),
      prisma.note.findMany({ where: { parentModule: 'contacts', parentId: id } }).catch(() => []),
    ]);
    res.json({ contact, activities, cases, emails, notes, exportedAt: new Date(), format: 'JSON' });
  } catch (err) { next(err); }
});
