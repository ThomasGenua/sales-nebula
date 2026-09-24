const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { canReach, reachableWhere, linkRefusal } = require('../middleware/access');
const { auditMiddleware } = require('../middleware/audit');
const { createCrudRouter } = require('../utils/crud');
const { columnsFrom } = require('../utils/modelFields');

const router = createCrudRouter('personAccount', 'personAccounts', {
  searchFilter: (q) => ({
    OR: [
      { firstName: { contains: q, mode: 'insensitive' } },
      { lastName: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { company: { contains: q, mode: 'insensitive' } },
    ],
  }),
  validate: (data) => {
    const errors = {};
    if (!data.lastName?.trim()) errors.lastName = 'Last name required';
    return { valid: Object.keys(errors).length === 0, errors };
  },
});

// Convert person account to business account + contact
router.post('/:id/convert', authenticate, requirePermission('personAccounts', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const pa = await prisma.personAccount.findUnique({ where: { id: req.params.id } });
    if (!pa) return res.status(404).json({ error: 'Person account not found' });

    const [account, contact] = await prisma.$transaction([
      prisma.account.create({
        data: {
          name: pa.company || `${pa.firstName} ${pa.lastName}`,
          phone: pa.phone, website: pa.website, industry: pa.industry,
          billingStreet: pa.street, billingCity: pa.city, billingState: pa.state,
          billingZip: pa.zip, billingCountry: pa.country,
        },
      }),
      prisma.contact.create({
        data: {
          firstName: pa.firstName, lastName: pa.lastName, email: pa.email,
          phone: pa.phone, mobilePhone: pa.mobilePhone, title: pa.title,
        },
      }),
    ]);
    // Link contact to account
    await prisma.contact.update({ where: { id: contact.id }, data: { accountId: account.id } });
    await prisma.personAccount.update({ where: { id: pa.id }, data: { convertedAccountId: account.id, convertedContactId: contact.id, status: 'Converted' } });
    await req.audit({ action: 'update', module: 'personAccounts', recordId: pa.id, details: 'Converted to account + contact' });
    res.json({ account, contact, personAccountId: pa.id });
  } catch (err) { next(err); }
});

// Merge person accounts
router.post('/merge', authenticate, requirePermission('personAccounts', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { primaryId, secondaryId } = req.body;
    if (typeof primaryId !== 'string' || typeof secondaryId !== 'string') return res.status(400).json({ error: 'primaryId and secondaryId required' });
    if (primaryId === secondaryId) return res.status(400).json({ error: 'Cannot merge an account into itself' });
    // Both ids come from the body, so the router's record check never saw
    // them: the caller must be able to change the one kept and delete the
    // one merged away.
    if (!(await canReach(req, 'personAccounts', 'personAccount', primaryId, 'Edit'))
      || !(await canReach(req, 'personAccounts', 'personAccount', secondaryId, 'Full'))) {
      return res.status(404).json({ error: 'One or both accounts not found' });
    }
    const [primary, secondary] = await Promise.all([
      prisma.personAccount.findUnique({ where: { id: primaryId } }),
      prisma.personAccount.findUnique({ where: { id: secondaryId } }),
    ]);
    if (!primary || !secondary) return res.status(404).json({ error: 'One or both accounts not found' });
    // Fill blank fields from secondary
    const updates = {};
    for (const field of ['email', 'phone', 'mobilePhone', 'title', 'company', 'industry']) {
      if (!primary[field] && secondary[field]) updates[field] = secondary[field];
    }
    const merged = await prisma.personAccount.update({ where: { id: primaryId }, data: updates });
    await prisma.personAccount.update({ where: { id: secondaryId }, data: { deletedAt: new Date() } });
    res.json({ merged, removedId: secondaryId });
  } catch (err) { next(err); }
});

// Stats
router.get('/stats/overview', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [total, converted, active] = await Promise.all([
      prisma.personAccount.count({ where: { deletedAt: null } }),
      prisma.personAccount.count({ where: { status: 'Converted', deletedAt: null } }),
      prisma.personAccount.count({ where: { status: 'Active', deletedAt: null } }),
    ]);
    res.json({ total, converted, active, conversionRate: total ? ((converted / total) * 100).toFixed(1) : 0 });
  } catch (err) { next(err); }
});

module.exports = router;

// Household management
router.post('/:id/household', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { householdName, members } = req.body;
    const person = await prisma.personAccount.findUnique({ where: { id: req.params.id } });
    if (!person) return res.status(404).json({ error: 'Not found' });
    // The household is an account, and its members must be people the caller
    // may change; any person account id was moved into it.
    if (!permits(req, 'accounts', 'edit')) return res.status(403).json({ error: 'Insufficient permissions for accounts' });
    const memberIds = Array.isArray(members) ? members.map(String) : [];
    for (const mId of memberIds) {
      if (!(await canReach(req, 'personAccounts', 'personAccount', mId, 'Edit'))) return res.status(404).json({ error: 'Member not found' });
    }
    const household = await prisma.account.create({ data: { name: householdName || `${person.lastName} Household`, type: 'Household', createdById: req.user.id } });
    await prisma.personAccount.update({ where: { id: req.params.id }, data: { householdId: household.id } });
    for (const mId of memberIds) { await prisma.personAccount.update({ where: { id: mId }, data: { householdId: household.id } }).catch(() => {}); }
    res.json({ householdId: household.id, householdName: household.name, primaryMember: person.id });
  } catch (err) { next(err); }
});

// Duplicate detection
router.get('/:id/duplicates', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const person = await prisma.personAccount.findUnique({ where: { id: req.params.id } });
    if (!person) return res.status(404).json({ error: 'Not found' });
    // Only people the caller could open; this listed anyone's contact details.
    const duplicates = await prisma.personAccount.findMany({
      where: await reachableWhere(req, 'personAccounts', 'personAccount', {
        id: { not: person.id },
        // `{ email: undefined }` filters on nothing, so a person with no email
        // matched every other one.
        OR: [
          ...(person.email ? [{ email: { equals: person.email, mode: 'insensitive' } }] : []),
          { AND: [{ firstName: { equals: person.firstName, mode: 'insensitive' } }, { lastName: { equals: person.lastName, mode: 'insensitive' } }] },
          ...(person.phone ? [{ phone: person.phone }] : []),
        ],
      }),
      take: 10,
    });
    res.json({ source: { id: person.id, name: `${person.firstName} ${person.lastName}`, email: person.email }, potentialDuplicates: duplicates.map(d => ({ id: d.id, name: `${d.firstName} ${d.lastName}`, email: d.email, phone: d.phone, matchType: d.email === person.email ? 'email' : (d.firstName === person.firstName && d.lastName === person.lastName) ? 'name' : 'phone' })) });
  } catch (err) { next(err); }
});

// Activity timeline
router.get('/:id/timeline', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const person = await prisma.personAccount.findUnique({ where: { id: req.params.id } });
    if (!person) return res.status(404).json({ error: 'Not found' });
    // Each module's items only with its read permission, and only those row
    // security lets the caller see.
    const links = [{ contactId: person.contactId }, { accountId: person.accountId }].filter(c => c.contactId || c.accountId);
    const [activities, cases, emails] = await Promise.all([
      permits(req, 'activities', 'read') && links.length
        ? prisma.activity.findMany({ where: await reachableWhere(req, 'activities', 'activity', { OR: links }), orderBy: { createdAt: 'desc' }, take: 20 }) : [],
      permits(req, 'cases', 'read') && person.contactId
        ? prisma.case.findMany({ where: await reachableWhere(req, 'cases', 'case', { contactId: person.contactId }), orderBy: { createdAt: 'desc' }, take: 10 }) : [],
      permits(req, 'emails', 'read') && person.contactId
        ? prisma.email.findMany({ where: { contactId: person.contactId }, orderBy: { createdAt: 'desc' }, take: 10 }) : [],
    ]);
    const timeline = [
      ...activities.map(a => ({ type: 'activity', id: a.id, subject: a.subject, date: a.createdAt, activityType: a.type })),
      ...cases.map(c => ({ type: 'case', id: c.id, subject: c.subject, date: c.createdAt, status: c.status })),
      ...emails.map(e => ({ type: 'email', id: e.id, subject: e.subject, date: e.createdAt, status: e.status })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ personId: person.id, timelineItems: timeline.length, timeline });
  } catch (err) { next(err); }
});

// Bulk import person accounts
router.post('/bulk-import', authenticate, requirePermission('personAccounts', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { records } = req.body;
    if (!records?.length) return res.status(400).json({ error: 'records array required' });
    const results = [];
    const seen = new Map();
    for (const rec of records.slice(0, 200)) {
      try {
        // Each row's own columns, owned by the importer, linked only to records
        // the importer can see; rows went to Prisma whole.
        const data = { ...columnsFrom('personAccount', rec), ownerId: req.user.id, createdById: req.user.id };
        const refusal = await linkRefusal(req, 'personAccount', data, null, seen);
        if (refusal) throw new Error(refusal);
        const pa = await prisma.personAccount.create({ data });
        results.push({ id: pa.id, status: 'created' });
      } catch (e) { results.push({ data: rec, status: 'error', error: e.message }); }
    }
    res.json({ processed: results.length, created: results.filter(r => r.status === 'created').length, errors: results.filter(r => r.status === 'error').length, results });
  } catch (err) { next(err); }
});

module.exports = router;
