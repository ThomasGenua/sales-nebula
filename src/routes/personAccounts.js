const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { canReach, reachableWhere } = require('../middleware/access');
const { auditMiddleware } = require('../middleware/audit');
const { createCrudRouter } = require('../utils/crud');
const { editableFields } = require('../utils/modelFields');
const {
  createRecord, updateRecord, deleteRecord, runAfter, batchClient,
} = require('../services/recordWrites');

const router = createCrudRouter('personAccount', 'personAccounts', {
  // A person account has no company column: searching on it made every
  // search answer 500.
  searchFilter: (q) => ({
    OR: [
      { firstName: { contains: q, mode: 'insensitive' } },
      { lastName: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
    ],
  }),
  validate: (data) => {
    const errors = {};
    // Both names are required columns; a missing first name answered 500.
    if (!data.firstName?.trim()) errors.firstName = 'First name required';
    if (!data.lastName?.trim()) errors.lastName = 'Last name required';
    return { valid: Object.keys(errors).length === 0, errors };
  },
});

// Convert person account to business account + contact
// It creates an account and a contact, so it takes those modules' edit
// permission too, as converting a lead does.
router.post('/:id/convert', authenticate, requirePermission('personAccounts', 'edit'), requirePermission('accounts', 'edit'), requirePermission('contacts', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const pa = await prisma.personAccount.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!pa) return res.status(404).json({ error: 'Person account not found' });
    // Converting again made a second account and contact.
    if (pa.convertedAccountId) return res.status(409).json({ error: 'This person account has already been converted', accountId: pa.convertedAccountId, contactId: pa.convertedContactId });

    // From the columns a person account has (company, website, industry, the
    // street parts and title are not among them), owned by whoever converts
    // it: with no owner, a Private default hid both from them. All three
    // writes go through the modules' rules (services/recordWrites) in one
    // transaction, the contact made on its account rather than linked after,
    // and their workflows and webhooks run once it commits. The person
    // account was marked converted outside the transaction, so a failure
    // there left an account and contact it did not know about.
    const after = [];
    const write = { userId: req.userId, source: 'person account conversion', emit: req.app.locals.emit, after, prisma };
    const { account, contact } = await prisma.$transaction(async tx => {
      const { record: account } = await createRecord(tx, 'accounts', {
        name: `${pa.firstName} ${pa.lastName}`,
        phone: pa.phone, address: pa.billingAddress || pa.mailingAddress,
        ownerId: req.userId,
      }, write);
      const { record: contact } = await createRecord(tx, 'contacts', {
        firstName: pa.firstName, lastName: pa.lastName, email: pa.email,
        phone: pa.phone, mobilePhone: pa.mobilePhone, address: pa.mailingAddress,
        accountId: account.id, ownerId: req.userId,
      }, write);
      await updateRecord(tx, 'personAccounts', pa, { convertedAccountId: account.id, convertedContactId: contact.id, status: 'Converted' }, write);
      return { account, contact };
    });
    await runAfter(after);
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
    // Fill blank fields from secondary (of the columns a person account has)
    const updates = {};
    for (const field of ['email', 'phone', 'mobilePhone', 'mailingAddress', 'billingAddress', 'birthdate', 'gender']) {
      if (!primary[field] && secondary[field]) updates[field] = secondary[field];
    }
    // Email is unique, so the one merged away gives its up first: taking it
    // while the secondary still held it failed every such merge. The one
    // merged away is deleted as a delete is, into the recycle bin with its
    // webhook (it was only marked deleted), and the survivor changes as an
    // edit would (services/recordWrites).
    const after = [];
    const write = { req, userId: req.userId, source: `merge of ${secondaryId}`, after, prisma };
    const merged = await prisma.$transaction(async tx => {
      if (updates.email) await tx.personAccount.update({ where: { id: secondaryId }, data: { email: null } });
      await deleteRecord(tx, 'personAccounts', secondary, { ...write, source: `merged into ${primaryId}` });
      return (await updateRecord(tx, 'personAccounts', primary, updates, write)).record;
    });
    await runAfter(after);
    res.json({ merged, removedId: secondaryId });
  } catch (err) { next(err); }
});

// Stats
router.get('/stats/overview', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Over the live person accounts the caller may see; this counted everyone's.
    const visible = where => reachableWhere(req, 'personAccounts', 'personAccount', where);
    const [total, converted, active] = await Promise.all([
      prisma.personAccount.count({ where: await visible() }),
      prisma.personAccount.count({ where: await visible({ status: 'Converted' }) }),
      prisma.personAccount.count({ where: await visible({ status: 'Active' }) }),
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
    // Owned by its creator: an account's owner is ownerId, so with only
    // createdById a Private default hid the household from them. Made, and
    // its members moved into it, as on their own pages (services/recordWrites).
    const write = { req, userId: req.userId, source: 'household' };
    const { record: household } = await createRecord(prisma, 'accounts', { name: householdName || `${person.lastName} Household`, type: 'Household', ownerId: req.user.id }, write);
    await updateRecord(prisma, 'personAccounts', person, { householdId: household.id }, write);
    for (const mId of memberIds) { await updateRecord(prisma, 'personAccounts', mId, { householdId: household.id }, write).catch(() => {}); }
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
    // security lets the caller see. A person account has no contactId: its
    // contact is the one it converted to, and its account the one it is
    // linked to or converted to, so cases and emails never showed.
    const contactId = person.convertedContactId;
    const accountId = person.accountId || person.convertedAccountId;
    const links = [{ contactId }, { accountId }].filter(c => c.contactId || c.accountId);
    const [activities, cases, emails] = await Promise.all([
      permits(req, 'activities', 'read') && links.length
        ? prisma.activity.findMany({ where: await reachableWhere(req, 'activities', 'activity', { OR: links }), orderBy: { createdAt: 'desc' }, take: 20 }) : [],
      permits(req, 'cases', 'read') && contactId
        ? prisma.case.findMany({ where: await reachableWhere(req, 'cases', 'case', { contactId }), orderBy: { createdAt: 'desc' }, take: 10 }) : [],
      permits(req, 'emails', 'read') && contactId
        ? prisma.email.findMany({ where: await reachableWhere(req, 'emails', 'email', { contactId }), orderBy: { createdAt: 'desc' }, take: 10 }) : [],
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
    // Each row's own columns, linked only to records the importer can see;
    // rows went to Prisma whole. Made as on its own page
    // (services/recordWrites): rules, an owner from the assignment rules or
    // else the importer, workflows and webhooks.
    const db = batchClient(prisma);
    const write = { req, userId: req.userId, source: 'bulk import', linkCache: new Map() };
    for (const rec of records.slice(0, 200)) {
      try {
        const { record: pa } = await createRecord(db, 'personAccounts', editableFields('personAccount', rec), write);
        results.push({ id: pa.id, status: 'created' });
      } catch (e) { results.push({ data: rec, status: 'error', error: e.message }); }
    }
    res.json({ processed: results.length, created: results.filter(r => r.status === 'created').length, errors: results.filter(r => r.status === 'error').length, results });
  } catch (err) { next(err); }
});

module.exports = router;
