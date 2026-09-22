const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { queryWithIncludes } = require('../utils/modelFields');

const router = Router();

// List marketplace listings
router.get('/', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50, search, category } = req.query;
    const where = { deletedAt: null, listed: true };
    if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }];
    if (category) where.category = category;
    const [data, total] = await Promise.all([
      prisma.marketplaceListing.findMany({ where, orderBy: { installCount: 'desc' }, take: +limit, skip: (+page - 1) * +limit }),
      prisma.marketplaceListing.count({ where }),
    ]);
    res.json({ data, total, page: +page, pages: Math.ceil(total / +limit) });
  } catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try { const prisma = req.app.locals.prisma; const l = await prisma.marketplaceListing.findUnique({ where: { id: req.params.id } }); if (!l) return res.status(404).json({ error: 'Not found' }); res.json(l); } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, author, category, pricing, version, features } = req.body;
    if (!name || !author) return res.status(400).json({ error: 'name and author required' });
    const listing = await prisma.marketplaceListing.create({ data: { name, description, author, category, pricing: pricing || 'Free', version: version || '1.0.0', features: features || [], listed: false } });
    res.status(201).json(listing);
  } catch (err) { next(err); }
});

// Install app
router.post('/:id/install', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const listing = await prisma.marketplaceListing.findUnique({ where: { id: req.params.id } });
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    const existing = await prisma.installedApp.findFirst({ where: { appId: req.params.id } });
    if (existing) return res.status(409).json({ error: 'Already installed' });
    const installed = await prisma.installedApp.create({
      data: { appId: req.params.id, userId: req.user.id, version: listing.version, status: 'Active' },
    });
    await prisma.marketplaceListing.update({ where: { id: req.params.id }, data: { installCount: { increment: 1 } } });
    await req.audit({ action: 'create', module: 'marketplace', recordId: listing.id, details: `Installed: ${listing.name}` });
    res.status(201).json(installed);
  } catch (err) { next(err); }
});

// Uninstall
router.delete('/:id/uninstall', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const installed = await prisma.installedApp.findFirst({ where: { appId: req.params.id } });
    if (!installed) return res.status(404).json({ error: 'Not installed' });
    await prisma.installedApp.delete({ where: { id: installed.id } });
    await req.audit({ action: 'delete', module: 'marketplace', recordId: req.params.id, details: 'App uninstalled' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Installed apps
router.get('/installed', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const apps = await queryWithIncludes(prisma, 'installedApp', 'findMany', {
      include: { listing: true, installedBy: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { installedAt: 'desc' },
    });
    res.json(apps);
  } catch (err) { next(err); }
});

// Reviews
router.get('/:id/reviews', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const reviews = await queryWithIncludes(prisma, 'marketplaceReview', 'findMany', {
      where: { appId: req.params.id },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const avgRating = reviews.length ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1) : null;
    res.json({ reviews, averageRating: avgRating, totalReviews: reviews.length });
  } catch (err) { next(err); }
});

router.post('/:id/reviews', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { rating, title, body } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating (1-5) required' });
    const review = await prisma.marketplaceReview.create({
      data: { appId: req.params.id, userId: req.user.id, rating, title, body },
    });
    // Update listing avg rating
    const reviews = await prisma.marketplaceReview.findMany({ where: { appId: req.params.id } });
    const avgRating = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
    await prisma.marketplaceListing.update({ where: { id: req.params.id }, data: { rating: parseFloat(avgRating.toFixed(1)) } });
    res.status(201).json(review);
  } catch (err) { next(err); }
});

module.exports = router;

// App settings
router.get('/installed/:appId/settings', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const install = await prisma.appInstallation.findFirst({ where: { appId: req.params.appId } }).catch(() => null);
    res.json({ appId: req.params.appId, settings: install?.settings || {}, installedAt: install?.createdAt });
  } catch (err) { next(err); }
});

router.put('/installed/:appId/settings', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const updated = await prisma.appInstallation.updateMany({ where: { appId: req.params.appId }, data: { settings: req.body } });
    res.json({ updated: updated.count });
  } catch (err) { next(err); }
});

// Featured apps
router.get('/featured', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const featured = await prisma.appListing.findMany({ where: { featured: true, active: true }, take: 10, orderBy: { installCount: 'desc' } });
    res.json(featured);
  } catch (err) { next(err); }
});

// App dependencies check
router.get('/:id/dependencies', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const app = await prisma.appListing.findUnique({ where: { id: req.params.id } });
    if (!app) return res.status(404).json({ error: 'Not found' });
    const deps = app.dependencies || [];
    const installed = await prisma.installedApp.findMany({ where: { userId: req.user.id } });
    const installedIds = installed.map(i => i.appId);
    res.json({ appId: app.id, dependencies: deps.map(d => ({ ...d, installed: installedIds.includes(d.appId) })), allMet: deps.every(d => installedIds.includes(d.appId)) });
  } catch (err) { next(err); }
});

// Featured / trending apps
router.get('/featured/trending', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const trending = await prisma.appListing.findMany({ where: { active: true, deletedAt: null }, orderBy: { installCount: 'desc' }, take: 10, select: { id: true, name: true, description: true, category: true, rating: true, installCount: true, pricing: true, author: true } });
    res.json(trending);
  } catch (err) { next(err); }
});
