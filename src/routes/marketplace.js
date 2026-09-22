/**
 * App marketplace.
 *
 * The module was built on two models at once. AppListing carries everything an
 * app has — name, slug, author, category, pricing, version, rating, installs —
 * while MarketplaceListing is a thin promotion record (appId, featured, badge).
 * Most routes wrote app details into MarketplaceListing, which has none of
 * those columns, so creating, listing and installing apps all failed; the
 * featured and trending routes read AppListing with filters it does not have.
 * Apps now live in AppListing, and "featured" means an AppListing that a
 * MarketplaceListing promotes.
 *
 * Installs were likewise split: the install route wrote InstalledApp while the
 * settings routes read AppInstallation, which nothing ever wrote. Both use
 * InstalledApp now. And /installed and /featured were declared after /:id, so
 * they were read as ids; named routes now come first.
 */

const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { queryWithIncludes, looksLikeId } = require('../utils/modelFields');

const router = Router();
router.use(authenticate);

const PUBLISHED = 'Published';

const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'app';

// ─── Named routes first ───

// Installed apps
router.get('/installed', async (req, res, next) => {
  try {
    const apps = await queryWithIncludes(req.app.locals.prisma, 'installedApp', 'findMany', {
      include: { listing: true, installedBy: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(apps);
  } catch (err) { next(err); }
});

// App settings live on the installation.
router.get('/installed/:appId/settings', async (req, res, next) => {
  try {
    const install = await req.app.locals.prisma.installedApp.findFirst({ where: { appId: req.params.appId } });
    if (!install) return res.status(404).json({ error: 'App is not installed' });
    res.json({ appId: req.params.appId, settings: install.settings || {}, installedAt: install.createdAt });
  } catch (err) { next(err); }
});

router.put('/installed/:appId/settings', requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const updated = await req.app.locals.prisma.installedApp.updateMany({
      where: { appId: req.params.appId }, data: { settings: req.body || {} },
    });
    if (!updated.count) return res.status(404).json({ error: 'App is not installed' });
    res.json({ updated: updated.count });
  } catch (err) { next(err); }
});

// Featured apps: those a MarketplaceListing promotes.
router.get('/featured', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const promoted = await prisma.marketplaceListing.findMany({ where: { featured: true }, select: { appId: true, badge: true } });
    const badges = new Map(promoted.map(p => [p.appId, p.badge]));
    const apps = await prisma.appListing.findMany({
      where: { id: { in: [...badges.keys()] }, status: PUBLISHED, deletedAt: null },
      orderBy: { installCount: 'desc' }, take: 10,
    });
    res.json(apps.map(a => ({ ...a, badge: badges.get(a.id) || null })));
  } catch (err) { next(err); }
});

router.get('/featured/trending', async (req, res, next) => {
  try {
    const trending = await req.app.locals.prisma.appListing.findMany({
      where: { status: PUBLISHED, deletedAt: null },
      orderBy: { installCount: 'desc' }, take: 10,
      select: { id: true, name: true, description: true, category: true, rating: true, installCount: true },
    });
    res.json(trending);
  } catch (err) { next(err); }
});

// ─── Listings ───

router.get('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50, search, category, pricing } = req.query;
    const take = Math.min(+limit || 50, 200);
    const where = { deletedAt: null, status: PUBLISHED };
    if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }];
    if (category) where.category = category;
    if (pricing) where.pricing = pricing;
    const [data, total] = await Promise.all([
      prisma.appListing.findMany({ where, orderBy: { installCount: 'desc' }, take, skip: ((+page || 1) - 1) * take }),
      prisma.appListing.count({ where }),
    ]);
    res.json({ data, total, page: +page || 1, pages: Math.ceil(total / take) });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    if (!looksLikeId('appListing', req.params.id)) return next();
    const app = await req.app.locals.prisma.appListing.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!app) return res.status(404).json({ error: 'Not found' });
    res.json(app);
  } catch (err) { next(err); }
});

router.post('/', requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, author, category, pricing, version, features, status } = req.body;
    if (!name || !author) return res.status(400).json({ error: 'name and author required' });

    // The slug is unique; a clash gets a short suffix rather than a 500.
    let slug = slugify(name);
    if (await prisma.appListing.findUnique({ where: { slug } })) slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;

    const app = await prisma.appListing.create({
      data: {
        name, slug, description, author, features: features || [],
        ...(category && { category }), ...(pricing && { pricing }), ...(version && { version }),
        status: status || PUBLISHED,
      },
    });
    await req.audit({ action: 'create', module: 'marketplace', recordId: app.id, details: `Listed: ${app.name}` });
    res.status(201).json(app);
  } catch (err) { next(err); }
});

// ─── Installs ───

router.post('/:id/install', requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const app = await prisma.appListing.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!app) return res.status(404).json({ error: 'Listing not found' });
    if (await prisma.installedApp.findFirst({ where: { appId: app.id } })) return res.status(409).json({ error: 'Already installed' });

    const installed = await prisma.installedApp.create({
      data: { appId: app.id, userId: req.userId, version: app.version, status: 'Active' },
    });
    await prisma.appListing.update({ where: { id: app.id }, data: { installCount: { increment: 1 } } });
    await req.audit({ action: 'create', module: 'marketplace', recordId: app.id, details: `Installed: ${app.name}` });
    res.status(201).json(installed);
  } catch (err) { next(err); }
});

router.delete('/:id/uninstall', requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const installed = await prisma.installedApp.findFirst({ where: { appId: req.params.id } });
    if (!installed) return res.status(404).json({ error: 'Not installed' });
    await prisma.installedApp.delete({ where: { id: installed.id } });
    await prisma.appListing.updateMany({ where: { id: req.params.id, installCount: { gt: 0 } }, data: { installCount: { decrement: 1 } } });
    await req.audit({ action: 'delete', module: 'marketplace', recordId: req.params.id, details: 'App uninstalled' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.get('/:id/dependencies', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const app = await prisma.appListing.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!app) return res.status(404).json({ error: 'Not found' });
    // AppListing declares no dependencies; report none rather than inventing them.
    const installed = await prisma.installedApp.findMany({ where: { userId: req.userId }, select: { appId: true } });
    res.json({ appId: app.id, dependencies: [], installedCount: installed.length, allMet: true });
  } catch (err) { next(err); }
});

// ─── Reviews ───

router.get('/:id/reviews', async (req, res, next) => {
  try {
    const reviews = await queryWithIncludes(req.app.locals.prisma, 'marketplaceReview', 'findMany', {
      where: { appId: req.params.id },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const avgRating = reviews.length ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1) : null;
    res.json({ reviews, averageRating: avgRating, totalReviews: reviews.length });
  } catch (err) { next(err); }
});

router.post('/:id/reviews', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating (1-5) required' });
    const app = await prisma.appListing.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!app) return res.status(404).json({ error: 'Listing not found' });

    const review = await prisma.marketplaceReview.create({
      data: { appId: app.id, userId: req.userId, rating, title: req.body.title, body: req.body.body },
    });
    const agg = await prisma.marketplaceReview.aggregate({ where: { appId: app.id }, _avg: { rating: true }, _count: true });
    await prisma.appListing.update({
      where: { id: app.id },
      data: { rating: Number((agg._avg.rating || 0).toFixed(1)), reviewCount: agg._count },
    });
    res.status(201).json(review);
  } catch (err) { next(err); }
});

module.exports = router;
