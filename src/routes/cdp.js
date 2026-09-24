const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { canReach, reachableWhere, linkRefusal } = require('../middleware/access');
const { isAdmin } = require('../middleware/rowSecurity');
const { currencyContext, sumInBase } = require('../utils/currency');
const { columnsFrom } = require('../utils/modelFields');
const router = Router();
router.use(authenticate);

// A profile is its contact's or its lead's. UnifiedProfile keeps their ids as
// plain columns, with no relation to filter through.
const PROFILE_SUBJECTS = [
  { key: 'contactId', module: 'contacts', model: 'contact' },
  { key: 'leadId', module: 'leads', model: 'lead' },
];

/**
 * Of `profiles`, those the caller may see: an admin, all; anyone else, those
 * whose contact or lead is a live record they can reach, in a module they
 * may read. Contacts read alone opened every profile, whoever's it was.
 */
async function visibleProfiles(req, profiles) {
  if (isAdmin(req.user)) return profiles;
  const reached = new Set();
  for (const { key, module, model } of PROFILE_SUBJECTS) {
    const ids = [...new Set(profiles.map(p => p[key]).filter(Boolean))];
    if (!ids.length || !permits(req, module, 'read')) continue;
    const found = await req.app.locals.prisma[model].findMany({ where: await reachableWhere(req, module, model, { id: { in: ids } }), select: { id: true } });
    for (const r of found) reached.add(`${key}:${r.id}`);
  }
  return profiles.filter(p => PROFILE_SUBJECTS.some(({ key }) => p[key] && reached.has(`${key}:${p[key]}`)));
}

// Unified Profiles
// Profiles carry people's emails, phones and identifiers; these reads (and
// resolve, which returns one by email) took a session alone.
router.get('/profiles', requirePermission('contacts', 'read'), async (req, res, next) => {
  try {
    const { email, segment, minScore, limit = 50 } = req.query;
    const where = {};
    if (email) where.email = email;
    if (segment) where.segments = { has: segment };
    if (minScore) where.score = { gte: parseFloat(minScore) };
    // Only visible profiles, read a batch at a time until the page is full.
    const take = Math.min(parseInt(limit) || 50, 200);
    const data = [];
    for (let skip = 0; data.length < take; skip += 500) {
      const batch = await req.app.locals.prisma.unifiedProfile.findMany({ where, skip, take: 500, orderBy: [{ score: 'desc' }, { id: 'asc' }] });
      data.push(...(await visibleProfiles(req, batch)));
      if (batch.length < 500) break;
    }
    res.json({ data: data.slice(0, take) });
  } catch (err) { next(err); }
});
router.get('/profiles/:id', requirePermission('contacts', 'read'), async (req, res, next) => {
  try {
    const profile = await req.app.locals.prisma.unifiedProfile.findUnique({ where: { id: req.params.id } });
    if (!profile || !(await visibleProfiles(req, [profile])).length) return res.status(404).json({ error: 'Not found' });
    res.json(profile);
  } catch (err) { next(err); }
});
// Finds or creates a profile, so it takes the gate merge uses for profile writes.
// It did so for any contact or lead id, a lead's with no leads permission, and
// a match by email was anyone's profile. The contact and lead must be ones the
// caller can see, and a match one of the profiles they may see.
router.post('/profiles/resolve', requirePermission('contacts', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { email, phone, contactId, leadId } = req.body;
    const keys = [email ? { email } : null, contactId ? { contactId } : null, leadId ? { leadId } : null].filter(Boolean);
    if (!keys.length) return res.status(400).json({ error: 'email, contactId or leadId required' });
    if (leadId && !permits(req, 'leads', 'read')) return res.status(403).json({ error: 'Insufficient permissions for leads' });
    const linkProblem = await linkRefusal(req, 'unifiedProfile', { contactId, leadId });
    if (linkProblem) return res.status(400).json({ error: linkProblem, code: 'LINK_NOT_VISIBLE' });
    let [profile] = await visibleProfiles(req, await prisma.unifiedProfile.findMany({ where: { OR: keys } }));
    if (!profile) {
      // One with neither a contact nor a lead is an admin's alone to see, so
      // anyone else would make one they could not open, and another each call.
      if (!contactId && !leadId && !isAdmin(req.user)) {
        return res.status(400).json({ error: 'No profile you can see matches; name its contactId or leadId to create one' });
      }
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
    // Both must be profiles the caller may see: any profile's identifiers were
    // folded into one they could read, and the profile deleted.
    if (!target || !source || (await visibleProfiles(req, [target, source])).length < 2) return res.status(404).json({ error: 'Profile not found' });
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
// It writes the segment onto profiles, so contacts edit, not read; and a
// missing name or criteria, or a criterion of the wrong type, was a 500.
router.post('/segments/calculate', requirePermission('contacts', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, criteria } = req.body;
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name required' });
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) return res.status(400).json({ error: 'criteria must be an object' });
    if ((criteria.minScore != null && !Number.isFinite(criteria.minScore))
        || (criteria.minTouchpoints != null && !Number.isInteger(criteria.minTouchpoints))) {
      return res.status(400).json({ error: 'criteria.minScore must be a number and criteria.minTouchpoints a whole number' });
    }
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
// A stream is integration configuration (its source and field mapping), which
// admin edit writes, so reading it is admin read; ingesting records customer
// data, so it takes contacts edit. Both answered anyone signed in.
router.get('/streams', requirePermission('admin', 'read'), async (req, res, next) => {
  try { res.json({ data: await req.app.locals.prisma.dataStream.findMany() }); }
  catch (err) { next(err); }
});
// The stream's own columns; the body went to the create whole.
router.post('/streams', requirePermission('admin', 'edit'), async (req, res, next) => {
  try { res.status(201).json(await req.app.locals.prisma.dataStream.create({ data: columnsFrom('dataStream', req.body) })); }
  catch (err) { next(err); }
});
router.post('/streams/:id/ingest', requirePermission('contacts', 'edit'), async (req, res, next) => {
  try {
    const stream = await req.app.locals.prisma.dataStream.findUnique({ where: { id: req.params.id } });
    // A stream that does not exist was answered as inactive, 400.
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    if (!stream.active) return res.status(400).json({ error: 'Stream inactive' });
    const records = req.body.records || [];
    await req.app.locals.prisma.dataStream.update({ where: { id: stream.id }, data: { lastSyncAt: new Date(), recordCount: { increment: records.length } } });
    res.json({ ingested: records.length });
  } catch (err) { next(err); }
});

module.exports = router;

// Customer profile
// GET /profiles/:id above answers first, so this is not reached; guarded as a
// contact read all the same, in case the order changes.
router.get('/profiles/:contactId', authenticate, requirePermission('contacts', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!(await canReach(req, 'contacts', 'contact', req.params.contactId))) return res.status(404).json({ error: 'Not found' });
    const contact = await prisma.contact.findUnique({ where: { id: req.params.contactId }, include: { account: { select: { name: true, industry: true } } } });
    if (!contact) return res.status(404).json({ error: 'Not found' });
    const [deals, cases, activities, events] = await Promise.all([
      prisma.deal.findMany({ where: { contactId: contact.id, deletedAt: null }, select: { id: true, name: true, stage: true, value: true, currency: true } }),
      prisma.case.count({ where: { contactId: contact.id, deletedAt: null } }),
      prisma.activity.findMany({ where: { contactId: contact.id, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 10 }),
      prisma.cdpEvent.findMany({ where: { contactId: contact.id }, orderBy: { createdAt: 'desc' }, take: 20 }).catch(() => []),
    ]);
    const ctx = await currencyContext(prisma);
    const lifetime = sumInBase(deals.filter(d => d.stage === 'Closed Won'), ctx);
    res.json({ contact, account: contact.account, currency: ctx.base, deals, caseCount: cases, recentActivities: activities, events, lifetimeValue: lifetime, engagementScore: Math.min(100, activities.length * 8 + deals.length * 15) });
  } catch (err) { next(err); }
});

// Track event
// Recorded an event on any contact id for anyone signed in. Recording customer
// events takes contacts edit, and the contact must be a live one the caller
// can see. CdpEvent.contactId has no relation, so linkRefusal cannot check it.
router.post('/events', authenticate, requirePermission('contacts', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { contactId, eventType, properties, source } = req.body;
    if (!contactId || !eventType) return res.status(400).json({ error: 'contactId and eventType required' });
    const contact = await prisma.contact.findFirst({ where: await reachableWhere(req, 'contacts', 'contact', { id: String(contactId) }), select: { id: true } });
    if (!contact) return res.status(400).json({ error: 'contactId does not name a contact you can see', code: 'LINK_NOT_VISIBLE' });
    const event = await prisma.cdpEvent.create({ data: { contactId: contact.id, type: eventType, properties, source: source || 'api', createdAt: new Date() } });
    res.status(201).json(event);
  } catch (err) { next(err); }
});

// Segment contacts
// Listed any contact's name and email for anyone signed in; now contacts read,
// and only contacts the caller can see.
router.post('/segments/evaluate', authenticate, requirePermission('contacts', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { criteria } = req.body;
    const where = { deletedAt: null };
    if (criteria?.leadSource) where.leadSource = criteria.leadSource;
    if (criteria?.hasDeals) where.deals = { some: { deletedAt: null } };
    if (criteria?.city) where.mailingCity = { contains: criteria.city, mode: 'insensitive' };
    const contacts = await prisma.contact.findMany({ where: await reachableWhere(req, 'contacts', 'contact', where), select: { id: true, firstName: true, lastName: true, email: true }, take: 500 });
    res.json({ criteria, matchCount: contacts.length, contacts: contacts.slice(0, 50) });
  } catch (err) { next(err); }
});

// Segment builder
// Returned any contact's name and email for anyone signed in; now contacts
// read, and the sample holds only contacts the caller can see. The stored
// memberCount stays the segment's size, not one user's view of it.
router.post('/segments/:id/evaluate', authenticate, requirePermission('contacts', 'read'), async (req, res, next) => {
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
    const [memberCount, contacts] = await Promise.all([
      prisma.contact.count({ where }),
      prisma.contact.findMany({ where: await reachableWhere(req, 'contacts', 'contact', where), take: 1000, select: { id: true, firstName: true, lastName: true, email: true } }),
    ]);
    await prisma.segment.update({ where: { id: segment.id }, data: { memberCount, lastEvaluatedAt: new Date() } });
    res.json({ segmentId: segment.id, matchCount: contacts.length, sample: contacts.slice(0, 20) });
  } catch (err) { next(err); }
});

// Journey analytics
// Analytics, so reports read, as the funnel and cohort reports take; it
// answered anyone signed in. It holds step names and counts, no people.
router.get('/journeys/:id/analytics', authenticate, requirePermission('reports', 'read'), async (req, res, next) => {
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
// A person's contact, lead, cases and activity, by email, went to anyone
// signed in. It now takes contacts and leads read, and finds only records the
// caller can see; cases only with cases read.
router.post('/profiles/unify', authenticate, requirePermission('contacts', 'read'), requirePermission('leads', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    const byEmail = { email: { equals: email, mode: 'insensitive' } };
    const [contact, lead] = await Promise.all([
      prisma.contact.findFirst({ where: await reachableWhere(req, 'contacts', 'contact', byEmail) }),
      prisma.lead.findFirst({ where: await reachableWhere(req, 'leads', 'lead', byEmail) }),
    ]);
    // A campaign member names its contact or lead by id; it has no relation
    // to filter through, so look the person up first.
    const memberOf = [contact && { contactId: contact.id }, lead && { leadId: lead.id }].filter(Boolean);
    const [cases, activities, campaignMembers] = await Promise.all([
      permits(req, 'cases', 'read')
        ? prisma.case.findMany({ where: await reachableWhere(req, 'cases', 'case', { contactEmail: email }), select: { id: true, subject: true, status: true } })
        : [],
      prisma.activity.findMany({ where: { contact: { is: await reachableWhere(req, 'contacts', 'contact', { email }) } }, take: 10 }),
      memberOf.length ? prisma.campaignMember.findMany({ where: { OR: memberOf }, include: { campaign: { select: { name: true } } } }) : [],
    ]);
    res.json({ email, contact, lead, cases, recentActivities: activities, campaigns: campaignMembers, unifiedAt: new Date() });
  } catch (err) { next(err); }
});
