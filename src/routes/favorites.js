const { Router } = require('express');
const { authenticate } = require('../middleware/auth');

const router = Router();

const TRACKED_MODULES = [
  'contacts', 'leads', 'deals', 'accounts', 'cases', 'activities',
  'quotes', 'invoices', 'contracts', 'orders', 'products', 'campaigns',
  'documents', 'projects', 'reports', 'dashboards', 'prospects', 'bugs',
];

const MODEL_FOR = {
  contacts: 'contact', leads: 'lead', deals: 'deal', accounts: 'account',
  cases: 'case', activities: 'activity', quotes: 'quote', invoices: 'invoice',
  contracts: 'contract', orders: 'order', products: 'product', campaigns: 'campaign',
  documents: 'document', projects: 'project', prospects: 'prospect', bugs: 'bug',
};

/** Best-effort display name across differently shaped models. */
function displayName(record) {
  if (!record) return null;
  return record.name
    || record.subject
    || record.title
    || [record.firstName, record.lastName].filter(Boolean).join(' ')
    || record.quoteNumber || record.invoiceNumber || record.caseNumber
    || null;
}

async function resolveName(prisma, module, recordId) {
  const model = MODEL_FOR[module];
  if (!model) return null;
  try {
    const record = await prisma[model].findUnique({ where: { id: recordId } });
    return displayName(record);
  } catch { return null; }
}

// ── FAVORITES ─────────────────────────────────────────────────────────

router.get('/', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const where = { userId: req.user.id };
    if (req.query.module) where.module = req.query.module;

    const favorites = await prisma.favorite.findMany({
      where,
      orderBy: [{ pinned: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: Math.min(parseInt(req.query.limit, 10) || 100, 300),
    });

    const grouped = {};
    for (const f of favorites) (grouped[f.module] = grouped[f.module] || []).push(f);

    res.json({
      total: favorites.length,
      pinned: favorites.filter(f => f.pinned),
      byModule: grouped,
      favorites,
    });
  } catch (err) { next(err); }
});

router.post('/', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId, recordName, recordUrl, pinned } = req.body;
    if (!module || !recordId) return res.status(400).json({ error: 'module and recordId required' });
    if (!TRACKED_MODULES.includes(module)) return res.status(400).json({ error: `Unsupported module: ${module}` });

    const existing = await prisma.favorite.findFirst({ where: { userId: req.user.id, module, recordId } });
    if (existing) return res.status(409).json({ error: 'Already favorited', favorite: existing });

    const count = await prisma.favorite.count({ where: { userId: req.user.id } });
    if (count >= 300) return res.status(400).json({ error: 'Favorite limit reached (300). Remove some first.' });

    const name = recordName || await resolveName(prisma, module, recordId);
    const last = await prisma.favorite.findFirst({ where: { userId: req.user.id }, orderBy: { sortOrder: 'desc' } });

    const favorite = await prisma.favorite.create({
      data: {
        userId: req.user.id, module, recordId,
        recordName: name, recordUrl: recordUrl || `/${module}/${recordId}`,
        pinned: !!pinned, sortOrder: (last?.sortOrder ?? -1) + 1,
      },
    });
    res.status(201).json(favorite);
  } catch (err) { next(err); }
});

// Add or remove in one call, which is what a star button needs
router.post('/toggle', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId, recordName } = req.body;
    if (!module || !recordId) return res.status(400).json({ error: 'module and recordId required' });

    const existing = await prisma.favorite.findFirst({ where: { userId: req.user.id, module, recordId } });
    if (existing) {
      await prisma.favorite.delete({ where: { id: existing.id } });
      return res.json({ favorited: false, module, recordId });
    }

    const name = recordName || await resolveName(prisma, module, recordId);
    const favorite = await prisma.favorite.create({
      data: { userId: req.user.id, module, recordId, recordName: name, recordUrl: `/${module}/${recordId}` },
    });
    res.json({ favorited: true, favorite });
  } catch (err) { next(err); }
});

// Bulk membership check so a list view can render stars in one request
router.post('/check', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordIds } = req.body;
    if (!module || !Array.isArray(recordIds)) return res.status(400).json({ error: 'module and recordIds required' });

    const favorites = await prisma.favorite.findMany({
      where: { userId: req.user.id, module, recordId: { in: recordIds.slice(0, 500) } },
      select: { recordId: true },
    });
    const set = new Set(favorites.map(f => f.recordId));
    res.json(Object.fromEntries(recordIds.map(id => [id, set.has(id)])));
  } catch (err) { next(err); }
});

router.delete('/:module/:recordId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const result = await prisma.favorite.deleteMany({ where: { userId: req.user.id, module: req.params.module, recordId: req.params.recordId } });
    res.json({ removed: result.count });
  } catch (err) { next(err); }
});

router.post('/:id/pin', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const favorite = await prisma.favorite.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!favorite) return res.status(404).json({ error: 'Favorite not found' });
    const updated = await prisma.favorite.update({ where: { id: favorite.id }, data: { pinned: req.body.pinned !== false } });
    res.json(updated);
  } catch (err) { next(err); }
});

router.post('/reorder', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
    let updated = 0;
    for (const [i, id] of order.entries()) {
      await prisma.favorite.updateMany({ where: { id, userId: req.user.id }, data: { sortOrder: i } }).then(r => { updated += r.count; }).catch(() => {});
    }
    res.json({ updated });
  } catch (err) { next(err); }
});

// ── RECENTLY VIEWED ───────────────────────────────────────────────────

router.get('/recent', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const where = { userId: req.user.id };
    if (req.query.module) where.module = req.query.module;

    const recent = await prisma.recentlyViewed.findMany({
      where, orderBy: { viewedAt: 'desc' },
      take: Math.min(parseInt(req.query.limit, 10) || 20, 100),
    });
    res.json({ count: recent.length, recent });
  } catch (err) { next(err); }
});

// Record a view. Repeat views bump the counter rather than adding rows.
router.post('/track', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId, recordName, action } = req.body;
    if (!module || !recordId) return res.status(400).json({ error: 'module and recordId required' });
    if (!TRACKED_MODULES.includes(module)) return res.json({ tracked: false, reason: 'module not tracked' });

    const name = recordName || await resolveName(prisma, module, recordId);
    const existing = await prisma.recentlyViewed.findFirst({ where: { userId: req.user.id, module, recordId } });

    if (existing) {
      await prisma.recentlyViewed.update({
        where: { id: existing.id },
        data: { viewedAt: new Date(), viewCount: { increment: 1 }, action: action || existing.action, recordName: name || existing.recordName },
      });
    } else {
      await prisma.recentlyViewed.create({
        data: { userId: req.user.id, module, recordId, recordName: name, action: action || 'view' },
      });
      // Trim the tail so the table does not grow without bound
      const count = await prisma.recentlyViewed.count({ where: { userId: req.user.id } });
      if (count > 200) {
        const oldest = await prisma.recentlyViewed.findMany({
          where: { userId: req.user.id }, orderBy: { viewedAt: 'asc' }, take: count - 200, select: { id: true },
        });
        await prisma.recentlyViewed.deleteMany({ where: { id: { in: oldest.map(o => o.id) } } });
      }
    }

    // Aggregate popularity, useful for ranking and for the admin view
    try {
      const stat = await prisma.viewStat.findFirst({ where: { module, recordId } });
      if (stat) {
        await prisma.viewStat.update({ where: { id: stat.id }, data: { totalViews: { increment: 1 }, lastViewedAt: new Date() } });
      } else {
        await prisma.viewStat.create({ data: { module, recordId, totalViews: 1, uniqueUsers: 1 } });
      }
    } catch { /* stats are advisory */ }

    res.json({ tracked: true });
  } catch (err) { next(err); }
});

router.delete('/recent', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const where = { userId: req.user.id };
    if (req.query.module) where.module = req.query.module;
    const result = await prisma.recentlyViewed.deleteMany({ where });
    res.json({ cleared: result.count });
  } catch (err) { next(err); }
});

// What this user returns to most often
router.get('/most-viewed', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rows = await prisma.recentlyViewed.findMany({
      where: { userId: req.user.id, viewCount: { gt: 1 } },
      orderBy: { viewCount: 'desc' },
      take: Math.min(parseInt(req.query.limit, 10) || 10, 50),
    });
    res.json(rows);
  } catch (err) { next(err); }
});

// Popular records org-wide
router.get('/trending', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const since = new Date(Date.now() - (parseInt(req.query.days, 10) || 7) * 86400000);
    const where = { lastViewedAt: { gte: since } };
    if (req.query.module) where.module = req.query.module;

    const stats = await prisma.viewStat.findMany({
      where, orderBy: { totalViews: 'desc' },
      take: Math.min(parseInt(req.query.limit, 10) || 20, 100),
    });

    const enriched = [];
    for (const s of stats) {
      enriched.push({ ...s, recordName: await resolveName(prisma, s.module, s.recordId) });
    }
    res.json(enriched);
  } catch (err) { next(err); }
});

// Combined payload for the sidebar, so the shell loads in one call
router.get('/sidebar', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [pinned, favorites, recent] = await Promise.all([
      prisma.favorite.findMany({ where: { userId: req.user.id, pinned: true }, orderBy: { sortOrder: 'asc' }, take: 10 }),
      prisma.favorite.findMany({ where: { userId: req.user.id, pinned: false }, orderBy: { sortOrder: 'asc' }, take: 15 }),
      prisma.recentlyViewed.findMany({ where: { userId: req.user.id }, orderBy: { viewedAt: 'desc' }, take: 10 }),
    ]);
    res.json({ pinned, favorites, recent });
  } catch (err) { next(err); }
});

module.exports = router;
