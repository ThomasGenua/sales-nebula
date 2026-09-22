const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();

/** Normalize an email for comparison and suppression checks. */
function normalizeEmail(email) {
  return email ? String(email).trim().toLowerCase() : null;
}

function isValidEmail(email) {
  return !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Simple lead-quality score from data completeness and firmographics. */
function scoreProspect(p) {
  let score = 0;
  if (isValidEmail(p.email)) score += 25;
  if (p.phoneWork || p.phoneMobile) score += 15;
  if (p.accountName) score += 10;
  if (p.title) score += 10;
  if (p.industry) score += 5;
  if (p.linkedIn) score += 5;
  if (p.city && p.country) score += 5;
  if (p.employeeCount > 50) score += 10;
  if (p.annualRevenue > 1000000) score += 10;
  if (p.emailOptOut || p.doNotCall) score -= 20;
  if (p.invalidEmail || p.bouncedCount > 0) score -= 25;
  return Math.max(0, Math.min(100, score));
}

/** Is this address suppressed from outbound sending? */
async function isSuppressed(prisma, email) {
  const e = normalizeEmail(email);
  if (!e) return false;
  try {
    const hit = await prisma.emailSuppression.findFirst({ where: { email: e } });
    if (hit) return true;
    const domain = e.split('@')[1];
    const domainHit = await prisma.emailSuppression.findFirst({ where: { email: `@${domain}` } });
    return !!domainHit;
  } catch { return false; }
}

// ── PROSPECTS ─────────────────────────────────────────────────────────

router.get('/', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { search, status, source, ownerId, industry, minScore, converted, page = 1, limit = 50, sortBy = 'createdAt', sortDir = 'desc' } = req.query;

    const where = { deletedAt: null };
    if (search) where.OR = [
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { accountName: { contains: search, mode: 'insensitive' } },
    ];
    if (status) where.status = status;
    if (source) where.source = source;
    if (ownerId) where.ownerId = ownerId;
    if (industry) where.industry = industry;
    if (minScore) where.score = { gte: +minScore };
    if (converted === 'true') where.convertedAt = { not: null };
    if (converted === 'false') where.convertedAt = null;

    const [data, total] = await Promise.all([
      prisma.prospect.findMany({ where, skip: (+page - 1) * +limit, take: Math.min(+limit, 200), orderBy: { [sortBy]: sortDir } }),
      prisma.prospect.count({ where }),
    ]);
    res.json({ data, total, page: +page, limit: +limit });
  } catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const prospect = await prisma.prospect.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!prospect) return res.status(404).json({ error: 'Prospect not found' });

    const memberships = await prisma.prospectListEntry.findMany({
      where: { prospectId: prospect.id },
      include: { list: { select: { id: true, name: true, type: true } } },
    }).catch(() => []);

    res.json({ ...prospect, lists: memberships.map(m => m.list).filter(Boolean), suppressed: await isSuppressed(prisma, prospect.email) });
  } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('leads', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { firstName, lastName, email, accountName, title, phoneWork, phoneMobile, source, industry, city, state, country, description, employeeCount, annualRevenue, linkedIn } = req.body;

    if (!lastName) return res.status(400).json({ error: 'lastName required' });
    const cleanEmail = normalizeEmail(email);
    if (cleanEmail && !isValidEmail(cleanEmail)) return res.status(400).json({ error: 'email is not a valid address' });

    if (cleanEmail) {
      const dupe = await prisma.prospect.findFirst({ where: { email: cleanEmail, deletedAt: null } });
      if (dupe) return res.status(409).json({ error: 'A prospect with that email already exists', existingId: dupe.id });
    }

    const payload = {
      firstName, lastName, email: cleanEmail, accountName, title,
      phoneWork, phoneMobile, source, industry, city, state, country, description,
      linkedIn,
      employeeCount: employeeCount != null ? +employeeCount : null,
      annualRevenue: annualRevenue != null ? +annualRevenue : null,
      fullName: [firstName, lastName].filter(Boolean).join(' '),
      ownerId: req.body.ownerId || req.user.id,
    };
    payload.score = scoreProspect(payload);

    const prospect = await prisma.prospect.create({ data: payload });
    await req.audit({ action: 'create', module: 'prospects', recordId: prospect.id, details: `Prospect created: ${payload.fullName}` });
    res.status(201).json(prospect);
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, requirePermission('leads', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { id, createdAt, lists, suppressed, ...data } = req.body;
    if (data.email) {
      data.email = normalizeEmail(data.email);
      if (!isValidEmail(data.email)) return res.status(400).json({ error: 'email is not a valid address' });
    }
    if (data.firstName || data.lastName) {
      const existing = await prisma.prospect.findUnique({ where: { id: req.params.id } });
      data.fullName = [data.firstName ?? existing?.firstName, data.lastName ?? existing?.lastName].filter(Boolean).join(' ');
    }
    const merged = { ...(await prisma.prospect.findUnique({ where: { id: req.params.id } })), ...data };
    data.score = scoreProspect(merged);

    const prospect = await prisma.prospect.update({ where: { id: req.params.id }, data });
    res.json(prospect);
  } catch (err) { next(err); }
});

router.delete('/:id', authenticate, requirePermission('leads', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.prospect.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ── IMPORT AND CONVERSION ─────────────────────────────────────────────

router.post('/import', authenticate, requirePermission('leads', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { prospects, listId, source, skipDuplicates = true } = req.body;
    if (!Array.isArray(prospects) || !prospects.length) return res.status(400).json({ error: 'prospects array required' });
    if (prospects.length > 5000) return res.status(400).json({ error: 'Import limit is 5000 rows per request' });

    const imported = [], skipped = [], invalid = [];
    for (const raw of prospects) {
      if (!raw.lastName && !raw.email) { invalid.push({ row: raw, reason: 'needs a lastName or an email' }); continue; }
      const email = normalizeEmail(raw.email);
      if (email && !isValidEmail(email)) { invalid.push({ row: raw, reason: 'invalid email' }); continue; }

      if (skipDuplicates && email) {
        const dupe = await prisma.prospect.findFirst({ where: { email, deletedAt: null } });
        if (dupe) { skipped.push({ email, reason: 'duplicate', existingId: dupe.id }); continue; }
      }

      const payload = {
        firstName: raw.firstName || null,
        lastName: raw.lastName || (email ? email.split('@')[0] : 'Unknown'),
        email, accountName: raw.accountName || raw.company || null,
        title: raw.title || null, phoneWork: raw.phone || raw.phoneWork || null,
        city: raw.city || null, state: raw.state || null, country: raw.country || null,
        industry: raw.industry || null, source: source || raw.source || 'Import',
        description: raw.description || null,
        ownerId: req.user.id,
      };
      payload.fullName = [payload.firstName, payload.lastName].filter(Boolean).join(' ');
      payload.score = scoreProspect(payload);

      try {
        const created = await prisma.prospect.create({ data: payload });
        imported.push({ id: created.id, email: created.email });
        if (listId) {
          await prisma.prospectListEntry.create({ data: { listId, prospectId: created.id, addedBy: req.user.id } }).catch(() => {});
        }
      } catch (e) { invalid.push({ row: raw, reason: String(e.message).slice(0, 100) }); }
    }

    if (listId) {
      await prisma.prospectList.update({ where: { id: listId }, data: { memberCount: { increment: imported.length } } }).catch(() => {});
    }

    await req.audit({ action: 'create', module: 'prospects', recordId: 'import', details: `${imported.length} prospects imported` });
    res.json({ received: prospects.length, imported: imported.length, skipped: skipped.length, invalid: invalid.length, skippedDetail: skipped.slice(0, 50), invalidDetail: invalid.slice(0, 50) });
  } catch (err) { next(err); }
});

router.post('/:id/convert', authenticate, requirePermission('leads', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { target = 'lead' } = req.body;
    if (!['lead', 'contact'].includes(target)) return res.status(400).json({ error: 'target must be lead or contact' });

    const prospect = await prisma.prospect.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!prospect) return res.status(404).json({ error: 'Prospect not found' });
    if (prospect.convertedAt) return res.status(409).json({ error: 'Prospect has already been converted', convertedAt: prospect.convertedAt });

    if (target === 'lead') {
      const lead = await prisma.lead.create({
        data: {
          firstName: prospect.firstName, lastName: prospect.lastName,
          email: prospect.email, phone: prospect.phoneWork || prospect.phoneMobile,
          company: prospect.accountName, title: prospect.title,
          // `leadSource` is a Contact column; on Lead it is `source`. Lead has
          // no industry column at all, so the prospect's is carried in the
          // description rather than silently dropped on conversion.
          source: prospect.source || 'Prospect', status: 'New',
          description: [prospect.description, prospect.industry && `Industry: ${prospect.industry}`]
            .filter(Boolean).join('\n') || null,
          city: prospect.city, state: prospect.state, country: prospect.country,
          ownerId: req.body.ownerId || prospect.ownerId || req.user.id,
        },
      });
      await prisma.prospect.update({ where: { id: prospect.id }, data: { convertedLeadId: lead.id, convertedAt: new Date(), status: 'Converted' } });
      await req.audit({ action: 'update', module: 'prospects', recordId: prospect.id, details: 'Converted to lead' });
      return res.status(201).json({ target: 'lead', record: lead });
    }

    const contact = await prisma.contact.create({
      data: {
        firstName: prospect.firstName, lastName: prospect.lastName,
        email: prospect.email, phone: prospect.phoneWork, mobile: prospect.phoneMobile,
        title: prospect.title, department: prospect.department,
        description: prospect.description,
        ownerId: req.body.ownerId || prospect.ownerId || req.user.id,
        accountId: req.body.accountId || null,
      },
    });
    await prisma.prospect.update({ where: { id: prospect.id }, data: { convertedContactId: contact.id, convertedAt: new Date(), status: 'Converted' } });
    res.status(201).json({ target: 'contact', record: contact });
  } catch (err) { next(err); }
});

// Merge duplicates, keeping the surviving record's non-empty fields
router.post('/:id/merge', authenticate, requirePermission('leads', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { duplicateIds } = req.body;
    if (!Array.isArray(duplicateIds) || !duplicateIds.length) return res.status(400).json({ error: 'duplicateIds array required' });
    if (duplicateIds.includes(req.params.id)) return res.status(400).json({ error: 'Cannot merge a record into itself' });

    const survivor = await prisma.prospect.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!survivor) return res.status(404).json({ error: 'Prospect not found' });

    const duplicates = await prisma.prospect.findMany({ where: { id: { in: duplicateIds }, deletedAt: null } });
    const filled = { ...survivor };
    for (const dupe of duplicates) {
      for (const [k, v] of Object.entries(dupe)) {
        if (['id', 'createdAt', 'updatedAt', 'deletedAt'].includes(k)) continue;
        if ((filled[k] === null || filled[k] === undefined || filled[k] === '') && v != null && v !== '') filled[k] = v;
      }
      // Carry list memberships across before the duplicate is retired
      const entries = await prisma.prospectListEntry.findMany({ where: { prospectId: dupe.id } }).catch(() => []);
      for (const e of entries) {
        await prisma.prospectListEntry.create({ data: { listId: e.listId, prospectId: survivor.id, addedBy: req.user.id } }).catch(() => {});
      }
      await prisma.prospect.update({ where: { id: dupe.id }, data: { deletedAt: new Date(), duplicateOfId: survivor.id } });
    }

    const { id, createdAt, updatedAt, deletedAt, ...updateData } = filled;
    updateData.score = scoreProspect(filled);
    const merged = await prisma.prospect.update({ where: { id: survivor.id }, data: updateData });

    await req.audit({ action: 'update', module: 'prospects', recordId: survivor.id, details: `Merged ${duplicates.length} duplicates` });
    res.json({ survivor: merged, mergedCount: duplicates.length });
  } catch (err) { next(err); }
});

router.get('/duplicates/find', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const prospects = await prisma.prospect.findMany({
      where: { deletedAt: null, email: { not: null } },
      select: { id: true, email: true, firstName: true, lastName: true, accountName: true, score: true, createdAt: true },
      take: 10000,
    });

    const byEmail = new Map();
    for (const p of prospects) {
      const key = normalizeEmail(p.email);
      if (!key) continue;
      if (!byEmail.has(key)) byEmail.set(key, []);
      byEmail.get(key).push(p);
    }

    const groups = [...byEmail.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([email, list]) => ({
        email, count: list.length,
        suggestedSurvivor: list.sort((a, b) => (b.score - a.score) || (new Date(a.createdAt) - new Date(b.createdAt)))[0].id,
        records: list,
      }));

    res.json({ duplicateGroups: groups.length, totalDuplicates: groups.reduce((s, g) => s + g.count - 1, 0), groups: groups.slice(0, 100) });
  } catch (err) { next(err); }
});

// ── TARGET LISTS ──────────────────────────────────────────────────────

router.get('/lists/all', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const lists = await prisma.prospectList.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(req.query.limit, 10) || 100, 300),
    });
    res.json(lists);
  } catch (err) { next(err); }
});

router.post('/lists', authenticate, requirePermission('campaigns', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, listType, filterJson, isDynamic } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const validTypes = ['Default', 'Seed', 'Test', 'Suppression', 'Exempt'];
    if (listType && !validTypes.includes(listType)) return res.status(400).json({ error: `listType must be one of: ${validTypes.join(', ')}` });

    const list = await prisma.prospectList.create({
      data: { name, description, type: listType || 'Default', filterJson: filterJson || null, isDynamic: !!isDynamic, ownerId: req.user.id },
    });
    await req.audit({ action: 'create', module: 'prospects', recordId: list.id, details: `Target list created: ${name}` });
    res.status(201).json(list);
  } catch (err) { next(err); }
});

router.get('/lists/:id/members', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 100 } = req.query;
    const [entries, total] = await Promise.all([
      prisma.prospectListEntry.findMany({
        where: { listId: req.params.id },
        skip: (+page - 1) * +limit, take: Math.min(+limit, 500),
        orderBy: { addedAt: 'desc' },
      }),
      prisma.prospectListEntry.count({ where: { listId: req.params.id } }),
    ]);

    const prospectIds = entries.map(e => e.prospectId).filter(Boolean);
    const prospects = prospectIds.length
      ? await prisma.prospect.findMany({ where: { id: { in: prospectIds } } })
      : [];
    const byId = new Map(prospects.map(p => [p.id, p]));

    res.json({ total, page: +page, members: entries.map(e => ({ entryId: e.id, addedAt: e.createdAt, prospect: byId.get(e.prospectId) || null })) });
  } catch (err) { next(err); }
});

router.post('/lists/:id/members', authenticate, requirePermission('campaigns', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { prospectIds, contactIds, leadIds } = req.body;
    const list = await prisma.prospectList.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (list.isDynamic) return res.status(400).json({ error: 'This is a dynamic list; edit its filter instead of adding members' });

    let added = 0;
    for (const [ids, field] of [[prospectIds, 'prospectId'], [contactIds, 'contactId'], [leadIds, 'leadId']]) {
      for (const id of ids || []) {
        await prisma.prospectListEntry.create({ data: { listId: list.id, [field]: id, addedBy: req.user.id } })
          .then(() => added++).catch(() => {});
      }
    }

    const total = await prisma.prospectListEntry.count({ where: { listId: list.id } });
    await prisma.prospectList.update({ where: { id: list.id }, data: { memberCount: total } }).catch(() => {});
    res.status(201).json({ added, total });
  } catch (err) { next(err); }
});

router.delete('/lists/:id/members/:entryId', authenticate, requirePermission('campaigns', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.prospectListEntry.delete({ where: { id: req.params.entryId } });
    const total = await prisma.prospectListEntry.count({ where: { listId: req.params.id } });
    await prisma.prospectList.update({ where: { id: req.params.id }, data: { memberCount: total } }).catch(() => {});
    res.json({ removed: true, total });
  } catch (err) { next(err); }
});

// Populate a list from a prospect filter
router.post('/lists/:id/populate', authenticate, requirePermission('campaigns', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const list = await prisma.prospectList.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!list) return res.status(404).json({ error: 'List not found' });

    const filter = req.body.filter || list.filterJson || {};
    const where = { deletedAt: null, convertedAt: null };
    if (filter.status) where.status = filter.status;
    if (filter.industry) where.industry = filter.industry;
    if (filter.source) where.source = filter.source;
    if (filter.country) where.country = filter.country;
    if (filter.minScore) where.score = { gte: +filter.minScore };
    if (filter.excludeOptOut !== false) where.emailOptOut = false;
    if (filter.requireEmail !== false) where.email = { not: null };

    const prospects = await prisma.prospect.findMany({ where, select: { id: true, email: true }, take: Math.min(parseInt(req.body.limit, 10) || 5000, 20000) });

    let added = 0, suppressed = 0;
    for (const p of prospects) {
      if (await isSuppressed(prisma, p.email)) { suppressed++; continue; }
      await prisma.prospectListEntry.create({ data: { listId: list.id, prospectId: p.id, addedBy: req.user.id } })
        .then(() => added++).catch(() => {});
    }

    const total = await prisma.prospectListEntry.count({ where: { listId: list.id } });
    await prisma.prospectList.update({ where: { id: list.id }, data: { memberCount: total, filterJson: filter, lastBuiltAt: new Date() } }).catch(() => {});

    await req.audit({ action: 'update', module: 'prospects', recordId: list.id, details: `List populated: ${added} added` });
    res.json({ matched: prospects.length, added, suppressed, listTotal: total });
  } catch (err) { next(err); }
});

router.delete('/lists/:id', authenticate, requirePermission('campaigns', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.prospectListEntry.deleteMany({ where: { listId: req.params.id } });
    await prisma.prospectList.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ── SUPPRESSION ───────────────────────────────────────────────────────

router.get('/suppression', authenticate, requirePermission('campaigns', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 100, search } = req.query;
    const where = {};
    if (search) where.email = { contains: search, mode: 'insensitive' };
    const [data, total] = await Promise.all([
      prisma.emailSuppression.findMany({ where, skip: (+page - 1) * +limit, take: Math.min(+limit, 500), orderBy: { suppressedAt: 'desc' } }),
      prisma.emailSuppression.count({ where }),
    ]);
    res.json({ data, total, page: +page });
  } catch (err) { next(err); }
});

router.post('/suppression', authenticate, requirePermission('campaigns', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { emails, reason } = req.body;
    const list = Array.isArray(emails) ? emails : (req.body.email ? [req.body.email] : []);
    if (!list.length) return res.status(400).json({ error: 'email or emails required' });

    let added = 0;
    for (const raw of list) {
      const email = normalizeEmail(raw);
      // A leading @ suppresses an entire domain
      if (!email || (!isValidEmail(email) && !email.startsWith('@'))) continue;
      await prisma.emailSuppression.create({ data: { email, reason: reason || 'Manual', addedById: req.user.id } })
        .then(() => added++).catch(() => {});
    }

    // Flag matching prospects so they drop out of future list builds
    for (const raw of list) {
      const email = normalizeEmail(raw);
      if (email && !email.startsWith('@')) {
        await prisma.prospect.updateMany({ where: { email }, data: { emailOptOut: true } }).catch(() => {});
      }
    }

    await req.audit({ action: 'create', module: 'prospects', recordId: 'suppression', details: `${added} addresses suppressed` });
    res.status(201).json({ added, requested: list.length });
  } catch (err) { next(err); }
});

router.delete('/suppression/:id', authenticate, requirePermission('campaigns', 'edit'), async (req, res, next) => {
  try {
    await req.app.locals.prisma.emailSuppression.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

router.post('/suppression/check', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { emails } = req.body;
    if (!Array.isArray(emails)) return res.status(400).json({ error: 'emails array required' });
    const result = {};
    for (const e of emails.slice(0, 1000)) result[e] = await isSuppressed(prisma, e);
    res.json(result);
  } catch (err) { next(err); }
});

// ── ANALYTICS ─────────────────────────────────────────────────────────

router.get('/analytics/summary', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const prospects = await prisma.prospect.findMany({
      where: { deletedAt: null },
      select: { status: true, source: true, industry: true, score: true, convertedAt: true, emailOptOut: true, email: true, country: true },
      take: 20000,
    });

    const converted = prospects.filter(p => p.convertedAt).length;
    const tally = (key) => prospects.reduce((a, p) => { const k = p[key] || 'Unspecified'; a[k] = (a[k] || 0) + 1; return a; }, {});

    res.json({
      total: prospects.length,
      converted,
      conversionRate: prospects.length ? +((converted / prospects.length) * 100).toFixed(1) : 0,
      optedOut: prospects.filter(p => p.emailOptOut).length,
      missingEmail: prospects.filter(p => !p.email).length,
      avgScore: prospects.length ? Math.round(prospects.reduce((s, p) => s + (p.score || 0), 0) / prospects.length) : 0,
      highQuality: prospects.filter(p => (p.score || 0) >= 70).length,
      byStatus: tally('status'),
      bySource: tally('source'),
      byIndustry: tally('industry'),
      byCountry: tally('country'),
    });
  } catch (err) { next(err); }
});

// Recompute scores after a scoring model change
router.post('/rescore', authenticate, requirePermission('leads', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const prospects = await prisma.prospect.findMany({ where: { deletedAt: null }, take: 20000 });
    let updated = 0;
    for (const p of prospects) {
      const score = scoreProspect(p);
      if (score !== p.score) { await prisma.prospect.update({ where: { id: p.id }, data: { score } }); updated++; }
    }
    res.json({ evaluated: prospects.length, updated });
  } catch (err) { next(err); }
});

module.exports = router;
