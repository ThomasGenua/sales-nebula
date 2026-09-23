const { createCrudRouter } = require('../utils/crud');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { canReach, reachableWhere } = require('../middleware/access');
const { editableFields } = require('../utils/modelFields');
const { currencyContext, sumInBase } = require('../utils/currency');

const router = createCrudRouter('contact', 'contacts', {
  include: {
    account: { select: { id: true, name: true } },
    customValues: { include: { customField: true } },
  },
  searchFilter: (q) => ({
    OR: [
      { firstName: { contains: q, mode: 'insensitive' } },
      { lastName: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
    ],
  }),
  validate: (data) => {
    const errors = {};
    if (!data.firstName?.trim()) errors.firstName = 'Required';
    if (!data.lastName?.trim()) errors.lastName = 'Required';
    return { valid: Object.keys(errors).length === 0, errors };
  },
  customRoutes: (router) => {
    // GET /api/contacts/:id/timeline
    router.get('/:id/timeline', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const id = req.params.id;
        const [activities, emails, cases, quotes] = await Promise.all([
          prisma.activity.findMany({ where: { contactId: id }, orderBy: { date: 'desc' }, take: 20 }),
          prisma.email.findMany({ where: { contactId: id }, orderBy: { createdAt: 'desc' }, take: 20 }),
          prisma.case.findMany({ where: { contactId: id }, orderBy: { createdAt: 'desc' }, take: 10 }),
          prisma.quote.findMany({ where: { contactId: id }, orderBy: { createdAt: 'desc' }, take: 10 }),
        ]);
        res.json({ activities, emails, cases, quotes });
      } catch (err) { next(err); }
    });

    // POST /api/contacts/:id/merge
    // It deletes a contact, so it takes the module's full permission, as DELETE does.
    router.post('/:id/merge', requirePermission('contacts', 'full'), async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const primaryId = req.params.id;
        const { mergeId, fields } = req.body;
        // Without one, the re-link below matched every contact's records.
        if (!mergeId || typeof mergeId !== 'string') return res.status(400).json({ error: 'mergeId required' });
        if (mergeId === primaryId) return res.status(400).json({ error: 'Cannot merge contact into itself' });
        // The router checks :id alone. This contact gives up its records and is
        // deleted, so the caller needs the row access DELETE asks for.
        if (!(await canReach(req, 'contacts', 'contact', mergeId, 'Full'))) {
          return res.status(404).json({ error: 'Not found' });
        }

        // Update primary with selected fields: its own columns, not its id,
        // owner or a nested write into another table.
        const data = editableFields('contact', fields);
        if (Object.keys(data).length) await prisma.contact.update({ where: { id: primaryId }, data });

        // Re-link all relations from merged record to primary
        await Promise.all([
          prisma.deal.updateMany({ where: { contactId: mergeId }, data: { contactId: primaryId } }),
          prisma.activity.updateMany({ where: { contactId: mergeId }, data: { contactId: primaryId } }),
          prisma.email.updateMany({ where: { contactId: mergeId }, data: { contactId: primaryId } }),
          prisma.case.updateMany({ where: { contactId: mergeId }, data: { contactId: primaryId } }),
        ]);

        // Delete merged record
        await prisma.contact.delete({ where: { id: mergeId } });

        const result = await prisma.contact.findUnique({ where: { id: primaryId }, include: { account: true } });
        res.json(result);
      } catch (err) { next(err); }
    });

    // POST /api/contacts/import-csv
    router.post('/import-csv', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const { records } = req.body;
        if (!records || !Array.isArray(records)) return res.status(400).json({ error: 'records array required' });

        // Each row as the contact's own columns, owned by the importer. Raw
        // rows set ids, timestamps and another rep as owner.
        const data = records.map(row => ({ ...editableFields('contact', row), ownerId: req.userId }));
        const created = await prisma.contact.createMany({ data, skipDuplicates: true });
        res.json({ success: true, imported: created.count });
      } catch (err) { next(err); }
    });

    // GET /api/contacts/:id/duplicates
    router.get('/:id/duplicates', async (req, res, next) => {
      try {
        const prisma = req.app.locals.prisma;
        const contact = await prisma.contact.findUnique({ where: { id: req.params.id } });
        if (!contact) return res.status(404).json({ error: 'Not found' });

        // Whole records, so only contacts the caller could open anyway.
        const dupes = await prisma.contact.findMany({
          where: await reachableWhere(req, 'contacts', 'contact', {
            id: { not: contact.id },
            OR: [
              { AND: [{ firstName: contact.firstName }, { lastName: contact.lastName }] },
              ...(contact.email ? [{ email: contact.email }] : []),
              ...(contact.phone ? [{ phone: contact.phone }] : []),
            ],
          }),
        });
        res.json(dupes);
      } catch (err) { next(err); }
    });
  },
});

// Duplicate check
router.get('/duplicates/check', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { email, phone, firstName, lastName } = req.query;
    const conditions = [];
    if (email) conditions.push({ email: { equals: email, mode: 'insensitive' } });
    if (phone) conditions.push({ phone });
    if (firstName && lastName) conditions.push({ AND: [{ firstName: { equals: firstName, mode: 'insensitive' } }, { lastName: { equals: lastName, mode: 'insensitive' } }] });
    if (!conditions.length) return res.json({ duplicates: [] });
    // Whole records, so only contacts the caller could open anyway.
    const dupes = await prisma.contact.findMany({ where: await reachableWhere(req, 'contacts', 'contact', { OR: conditions }), take: 10 });
    res.json({ duplicates: dupes, count: dupes.length });
  } catch (err) { next(err); }
});

// Contact relationships
router.get('/:id/relationships', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [deals, cases, activities, account] = await Promise.all([
      prisma.deal.findMany({ where: { contactId: req.params.id, deletedAt: null }, select: { id: true, name: true, stage: true, value: true, currency: true }, take: 20 }),
      prisma.case.findMany({ where: { contactId: req.params.id, deletedAt: null }, select: { id: true, subject: true, status: true, priority: true }, take: 20 }),
      prisma.activity.findMany({ where: { contactId: req.params.id, deletedAt: null }, select: { id: true, subject: true, type: true, status: true }, take: 20, orderBy: { createdAt: 'desc' } }),
      prisma.contact.findUnique({ where: { id: req.params.id }, select: { account: { select: { id: true, name: true } } } }).then(c => c?.account),
    ]);
    const ctx = await currencyContext(prisma);
    res.json({ account, deals, cases, activities, summary: { dealCount: deals.length, caseCount: cases.length, activityCount: activities.length, currency: ctx.base, totalDealValue: sumInBase(deals, ctx) } });
  } catch (err) { next(err); }
});

// Convert contact to lead
router.post('/:id/convert-to-lead', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const contact = await prisma.contact.findUnique({ where: { id: req.params.id } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    const lead = await prisma.lead.create({
      data: { firstName: contact.firstName, lastName: contact.lastName, email: contact.email, phone: contact.phone, company: contact.department || '', title: contact.title, status: 'New', source: contact.leadSource || 'Existing Contact', ownerId: req.user.id },
    });
    await req.audit({ action: 'create', module: 'leads', recordId: lead.id, details: `Converted from contact ${contact.id}` });
    res.status(201).json(lead);
  } catch (err) { next(err); }
});

module.exports = router;
