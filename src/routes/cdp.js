const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const router = Router();
router.use(authenticate);

// Unified Profiles
router.get('/profiles', async (req, res, next) => {
  try {
    const { email, segment, minScore, limit = 50 } = req.query;
    const where = {};
    if (email) where.email = email;
    if (segment) where.segments = { has: segment };
    if (minScore) where.score = { gte: parseFloat(minScore) };
    res.json({ data: await req.app.locals.prisma.unifiedProfile.findMany({ where, take: Math.min(parseInt(limit), 200), orderBy: { score: 'desc' } }) });
  } catch (err) { next(err); }
});
router.get('/profiles/:id', async (req, res, next) => {
  try {
    const profile = await req.app.locals.prisma.unifiedProfile.findUnique({ where: { id: req.params.id } });
    if (!profile) return res.status(404).json({ error: 'Not found' });
    res.json(profile);
  } catch (err) { next(err); }
});
router.post('/profiles/resolve', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { email, phone, contactId, leadId } = req.body;
    let profile = await prisma.unifiedProfile.findFirst({ where: { OR: [email ? { email } : null, contactId ? { contactId } : null, leadId ? { leadId } : null].filter(Boolean) } });
    if (!profile) {
      profile = await prisma.unifiedProfile.create({ data: { email, phone, contactId, leadId, identifiers: [{ source: 'crm', type: 'email', value: email }] } });
    }
    res.json(profile);
  } catch (err) { next(err); }
});
router.post('/profiles/:id/merge', requirePermission('contacts', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { sourceId } = req.body;
    const [target, source] = await Promise.all([
      prisma.unifiedProfile.findUnique({ where: { id: req.params.id } }),
      prisma.unifiedProfile.findUnique({ where: { id: sourceId } }),
    ]);
    if (!target || !source) return res.status(404).json({ error: 'Profile not found' });
    const merged = await prisma.unifiedProfile.update({
      where: { id: target.id },
      data: {
        identifiers: [...(target.identifiers || []), ...(source.identifiers || [])],
        segments: [...new Set([...(target.segments || []), ...(source.segments || [])])],
        touchpoints: target.touchpoints + source.touchpoints,
        lifetime_value: target.lifetime_value + source.lifetime_value,
      },
    });
    await prisma.unifiedProfile.delete({ where: { id: sourceId } });
    res.json(merged);
  } catch (err) { next(err); }
});

// Segments
router.post('/segments/calculate', requirePermission('contacts', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, criteria } = req.body;
    const where = {};
    if (criteria.minScore) where.score = { gte: criteria.minScore };
    if (criteria.minTouchpoints) where.touchpoints = { gte: criteria.minTouchpoints };
    const profiles = await prisma.unifiedProfile.findMany({ where });
    for (const p of profiles) {
      const segments = [...new Set([...(p.segments || []), name])];
      await prisma.unifiedProfile.update({ where: { id: p.id }, data: { segments } });
    }
    res.json({ segment: name, profileCount: profiles.length });
  } catch (err) { next(err); }
});

// Data Streams
router.get('/streams', async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.dataStream.findMany() }); }
  catch (err) { next(err); }
});
router.post('/streams', requirePermission('admin', 'edit'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.dataStream.create({ data: req.body })); }
  catch (err) { next(err); }
});
router.post('/streams/:id/ingest', async (req, res, next) => {
  try {
    const stream = await req.app.locals.prisma.dataStream.findUnique({ where: { id: req.params.id } });
    if (!stream || !stream.active) return res.status(400).json({ error: 'Stream inactive' });
    const records = req.body.records || [];
    await req.app.locals.prisma.dataStream.update({ where: { id: stream.id }, data: { lastSyncAt: new Date(), recordCount: { increment: records.length } } });
    res.json({ ingested: records.length });
  } catch (err) { next(err); }
});

module.exports = router;

// Customer profile
router.get('/profiles/:contactId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const contact = await prisma.contact.findUnique({ where: { id: req.params.contactId }, include: { account: { select: { name: true, industry: true } } } });
    if (!contact) return res.status(404).json({ error: 'Not found' });
    const [deals, cases, activities, events] = await Promise.all([
      prisma.deal.findMany({ where: { contactId: contact.id, deletedAt: null }, select: { id: true, name: true, stage: true, value: true } }),
      prisma.case.count({ where: { contactId: contact.id, deletedAt: null } }),
      prisma.activity.findMany({ where: { contactId: contact.id, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 10 }),
      prisma.cdpEvent.findMany({ where: { contactId: contact.id }, orderBy: { createdAt: 'desc' }, take: 20 }).catch(() => []),
    ]);
    const lifetime = deals.filter(d => d.stage === 'Closed Won').reduce((s, d) => s + (d.value || 0), 0);
    res.json({ contact, account: contact.account, deals, caseCount: cases, recentActivities: activities, events, lifetimeValue: lifetime, engagementScore: Math.min(100, activities.length * 8 + deals.length * 15) });
  } catch (err) { next(err); }
});

// Track event
router.post('/events', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { contactId, eventType, properties, source } = req.body;
    if (!contactId || !eventType) return res.status(400).json({ error: 'contactId and eventType required' });
    const event = await prisma.cdpEvent.create({ data: { contactId, type: eventType, properties, source: source || 'api', createdAt: new Date() } });
    res.status(201).json(event);
  } catch (err) { next(err); }
});

// Segment contacts
router.post('/segments/evaluate', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { criteria } = req.body;
    const where = { deletedAt: null };
    if (criteria?.leadSource) where.leadSource = criteria.leadSource;
    if (criteria?.hasDeals) where.deals = { some: { deletedAt: null } };
    if (criteria?.city) where.mailingCity = { contains: criteria.city, mode: 'insensitive' };
    const contacts = await prisma.contact.findMany({ where, select: { id: true, firstName: true, lastName: true, email: true }, take: 500 });
    res.json({ criteria, matchCount: contacts.length, contacts: contacts.slice(0, 50) });
  } catch (err) { next(err); }
});

// Segment builder
router.post('/segments/:id/evaluate', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const segment = await prisma.segment.findUnique({ where: { id: req.params.id } });
    if (!segment) return res.status(404).json({ error: 'Segment not found' });
    const criteria = segment.criteria || {};
    const where = { deletedAt: null };
    if (criteria.leadSource) where.leadSource = criteria.leadSource;
    if (criteria.status) where.status = criteria.status;
    if (criteria.industry) where.industry = criteria.industry;
    if (criteria.createdAfter) where.createdAt = { gte: new Date(criteria.createdAfter) };
    const contacts = await prisma.contact.findMany({ where, take: 1000, select: { id: true, firstName: true, lastName: true, email: true } });
    await prisma.segment.update({ where: { id: segment.id }, data: { memberCount: contacts.length, lastEvaluatedAt: new Date() } });
    res.json({ segmentId: segment.id, matchCount: contacts.length, sample: contacts.slice(0, 20) });
  } catch (err) { next(err); }
});

// Journey analytics
router.get('/journeys/:id/analytics', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const journey = await prisma.journey.findUnique({ where: { id: req.params.id } });
    if (!journey) return res.status(404).json({ error: 'Journey not found' });
    const steps = journey.steps || [];
    // Progress through a journey's steps is not recorded anywhere. These
    // counts were Math.random(), different on every request; null says
    // "not tracked" rather than inventing a funnel.
    const analytics = steps.map((step, i) => ({
      stepIndex: i, name: step.name || `Step ${i + 1}`, type: step.type,
      entered: null, completed: null, dropped: null, avgDurationHrs: null,
    }));
    res.json({ journeyId: journey.id, name: journey.name, status: journey.status, totalEnrolled: journey.enrolledCount || 0, stepTracking: false, steps: analytics });
  } catch (err) { next(err); }
});

// Profile unification
router.post('/profiles/unify', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    const [contact, lead] = await Promise.all([
      prisma.contact.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null } }),
      prisma.lead.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null } }),
    ]);
    // A campaign member names its contact or lead by id; it has no relation
    // to filter through, so look the person up first.
    const memberOf = [contact && { contactId: contact.id }, lead && { leadId: lead.id }].filter(Boolean);
    const [cases, activities, campaignMembers] = await Promise.all([
      prisma.case.findMany({ where: { contactEmail: email }, select: { id: true, subject: true, status: true } }),
      prisma.activity.findMany({ where: { OR: [{ contact: { email } }] }, take: 10 }),
      memberOf.length ? prisma.campaignMember.findMany({ where: { OR: memberOf }, include: { campaign: { select: { name: true } } } }) : [],
    ]);
    res.json({ email, contact, lead, cases, recentActivities: activities, campaigns: campaignMembers, unifiedAt: new Date() });
  } catch (err) { next(err); }
});
