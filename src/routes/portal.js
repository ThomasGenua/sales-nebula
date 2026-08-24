const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();

// Get portal configuration
router.get('/config', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    let config = await prisma.portalConfig.findFirst();
    if (!config) config = { enabled: false, name: 'Customer Portal', allowSelfRegistration: true, theme: 'default', modules: ['cases', 'knowledge', 'orders'] };
    res.json(config);
  } catch (err) { next(err); }
});

// Update portal configuration
router.put('/config', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.portalConfig.findFirst();
    const config = existing
      ? await prisma.portalConfig.update({ where: { id: existing.id }, data: req.body })
      : await prisma.portalConfig.create({ data: req.body });
    await req.audit({ action: 'update', module: 'portal', recordId: config.id, details: 'Portal config updated' });
    res.json(config);
  } catch (err) { next(err); }
});

// List portal users
router.get('/users', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50, search } = req.query;
    const where = { isPortalUser: true };
    if (search) where.OR = [{ firstName: { contains: search, mode: 'insensitive' } }, { lastName: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }];
    const [data, total] = await Promise.all([
      prisma.user.findMany({ where, take: +limit, skip: (+page - 1) * +limit, select: { id: true, firstName: true, lastName: true, email: true, active: true, lastLogin: true, createdAt: true } }),
      prisma.user.count({ where }),
    ]);
    res.json({ data, total, page: +page, pages: Math.ceil(total / +limit) });
  } catch (err) { next(err); }
});

// Create portal user from contact
router.post('/users', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const bcrypt = require('bcryptjs');
    const { contactId, password } = req.body;
    if (!contactId || !password) return res.status(400).json({ error: 'contactId and password required' });
    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (!contact.email) return res.status(400).json({ error: 'Contact has no email address' });
    const existing = await prisma.user.findUnique({ where: { email: contact.email } });
    if (existing) return res.status(409).json({ error: 'User already exists with this email' });
    const portalRole = await prisma.role.findFirst({ where: { name: { contains: 'Portal', mode: 'insensitive' } } });
    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        firstName: contact.firstName, lastName: contact.lastName, email: contact.email,
        password: hashedPassword, isPortalUser: true, contactId: contact.id,
        ...(portalRole && { roleId: portalRole.id }),
      },
    });
    await req.audit({ action: 'create', module: 'portal', recordId: user.id, details: `Portal user created for contact ${contact.id}` });
    res.status(201).json({ id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName });
  } catch (err) { next(err); }
});

// Deactivate portal user
router.post('/users/:id/deactivate', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const user = await prisma.user.update({ where: { id: req.params.id }, data: { active: false } });
    await req.audit({ action: 'update', module: 'portal', recordId: user.id, details: 'Portal user deactivated' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Portal user's accessible cases
router.get('/my/cases', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { contactId: true } });
    if (!user?.contactId) return res.json({ data: [] });
    const cases = await prisma.case.findMany({
      where: { contactId: user.contactId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, caseNumber: true, subject: true, status: true, priority: true, createdAt: true, updatedAt: true },
    });
    res.json({ data: cases });
  } catch (err) { next(err); }
});

// Portal user submits case
router.post('/my/cases', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { contactId: true } });
    if (!user?.contactId) return res.status(403).json({ error: 'No associated contact' });
    const c = await prisma.case.create({
      data: { subject: req.body.subject, description: req.body.description, priority: req.body.priority || 'Medium', status: 'New', origin: 'Portal', contactId: user.contactId },
    });
    res.status(201).json(c);
  } catch (err) { next(err); }
});

module.exports = router;

// Portal knowledge base (public)
router.get('/knowledge', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { q, category, limit = 20 } = req.query;
    const where = { status: 'Published', deletedAt: null };
    if (q) where.OR = [{ title: { contains: q, mode: 'insensitive' } }, { body: { contains: q, mode: 'insensitive' } }];
    if (category) where.category = category;
    const articles = await prisma.knowledgeArticle.findMany({ where, select: { id: true, title: true, category: true, summary: true, viewCount: true }, orderBy: { viewCount: 'desc' }, take: +limit });
    res.json(articles);
  } catch (err) { next(err); }
});

// Portal user profile update
router.put('/users/:id/profile', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { firstName, lastName, phone, timezone, language } = req.body;
    const updated = await prisma.portalUser.update({ where: { id: req.params.id }, data: { firstName, lastName, phone, timezone, language } });
    res.json(updated);
  } catch (err) { next(err); }
});

// Portal analytics
router.get('/:id/analytics', authenticate, requirePermission('admin', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const thirtyDays = new Date(Date.now() - 30 * 86400000);
    const [totalUsers, activeUsers, casesSubmitted, articlesViewed] = await Promise.all([
      prisma.portalUser.count({ where: { portalId: req.params.id } }),
      prisma.portalUser.count({ where: { portalId: req.params.id, lastLoginAt: { gte: thirtyDays } } }),
      prisma.case.count({ where: { origin: 'Portal', createdAt: { gte: thirtyDays } } }),
      prisma.knowledgeArticle.aggregate({ where: { viewCount: { gt: 0 } }, _sum: { viewCount: true } }).catch(() => ({ _sum: { viewCount: 0 } })),
    ]);
    res.json({ totalUsers, activeUsers, casesSubmitted, articlesViewed: articlesViewed._sum?.viewCount || 0, selfServiceRate: totalUsers > 0 ? ((totalUsers - activeUsers) / totalUsers * 100).toFixed(1) + '%' : '0%' });
  } catch (err) { next(err); }
});

// Portal branding
router.put('/:id/branding', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { logo, primaryColor, headerText, footerText, customCss } = req.body;
    const portal = await prisma.portalConfig.update({ where: { id: req.params.id }, data: { logo, primaryColor, headerText, footerText, customCss } });
    res.json(portal);
  } catch (err) { next(err); }
});
