const { Router } = require('express');
const { authenticate, requirePermission, hasPermission, permits, validatePassword } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { reachableWhere } = require('../middleware/access');
const { createNumbered, CASE_NUMBER } = require('../utils/numbering');
const { columnsFrom } = require('../utils/modelFields');

const router = Router();

// Get portal configuration
router.get('/config', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    let config = await prisma.portalConfig.findFirst({ where: { deletedAt: null } });
    // Until one is saved, the model's own fields and defaults: this named
    // fields the model does not have and said self-registration was on.
    if (!config) config = { name: 'Customer Portal', type: 'Customer', active: false, selfRegistration: false, theme: null, features: ['cases', 'knowledge'] };
    res.json(config);
  } catch (err) { next(err); }
});

// Update portal configuration
router.put('/config', authenticate, requirePermission('admin', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.portalConfig.findFirst({ where: { deletedAt: null } });
    const data = columnsFrom('portalConfig', req.body);
    const config = existing
      ? await prisma.portalConfig.update({ where: { id: existing.id }, data })
      : await prisma.portalConfig.create({ data });
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
      prisma.user.findMany({ where, take: +limit, skip: (+page - 1) * +limit, select: { id: true, firstName: true, lastName: true, email: true, active: true, lastLoginAt: true, createdAt: true } }),
      prisma.user.count({ where }),
    ]);
    res.json({ data, total, page: +page, pages: Math.ceil(total / +limit) });
  } catch (err) { next(err); }
});

/**
 * The role portal accounts get: none of the staff permissions. An install
 * without a role named like "Portal" failed every portal account with a
 * missing roleId, and one whose name merely contained the word could hand
 * customers a staff role. Portal accounts are held to the portal by
 * authenticate() in any case.
 */
async function portalAccountRole(prisma) {
  return prisma.role.upsert({
    where: { name: 'Customer Portal' },
    update: {},
    create: { name: 'Customer Portal', description: 'Customer portal accounts: no staff access' },
  });
}

// Create portal user from contact
router.post('/users', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const bcrypt = require('bcryptjs');
    const { contactId, password } = req.body;
    if (!contactId || !password) return res.status(400).json({ error: 'contactId and password required' });
    // A live contact the caller can see. Any contact id, deleted or hidden
    // from the caller, opened a login on it, with the contact's name, email
    // and cases behind it.
    if (!permits(req, 'contacts', 'read')) return res.status(403).json({ error: 'Insufficient permissions for contacts' });
    const contact = await prisma.contact.findFirst({ where: await reachableWhere(req, 'contacts', 'contact', { id: String(contactId) }) });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (!contact.email) return res.status(400).json({ error: 'Contact has no email address' });
    // Stored lowercased like every other account address, and checked against
    // existing accounts in any case; the contact's own casing was kept.
    const email = contact.email.trim().toLowerCase();
    const existing = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })
      .catch(() => prisma.user.findUnique({ where: { email } })); // SQLite: no case-insensitive mode
    if (existing) return res.status(409).json({ error: 'User already exists with this email' });
    const { valid, errors } = validatePassword(String(password));
    if (!valid) return res.status(400).json({ error: errors.join('. ') });
    const portalRole = await portalAccountRole(prisma);
    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        firstName: contact.firstName, lastName: contact.lastName, email,
        password: hashedPassword, isPortalUser: true, contactId: contact.id, roleId: portalRole.id,
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
    // Portal accounts only: this took any user id, so the admin: edit that
    // the default Sales Rep role has was enough to disable an administrator.
    const { count } = await prisma.user.updateMany({ where: { id: req.params.id, isPortalUser: true }, data: { active: false } });
    if (!count) return res.status(404).json({ error: 'Portal user not found' });
    await req.audit({ action: 'update', module: 'portal', recordId: req.params.id, details: 'Portal user deactivated' });
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
    // A case needs a subject; without one this was a 500.
    if (typeof req.body.subject !== 'string' || !req.body.subject.trim()) return res.status(400).json({ error: 'subject is required' });
    const c = await createNumbered(prisma, 'case', CASE_NUMBER, {
      data: { subject: req.body.subject, description: req.body.description, priority: req.body.priority || 'Medium', status: 'New', origin: 'Portal', contactId: user.contactId },
    });
    res.status(201).json(c);
  } catch (err) { next(err); }
});

module.exports = router;

// Portal knowledge base (public)
// Public articles only: this listed, and searched the bodies of, every
// published article, the Internal ones (the default visibility) included.
const PORTAL_ARTICLES = { status: 'Published', visibility: 'Public', deletedAt: null };

router.get('/knowledge', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { q, category, limit = 20 } = req.query;
    const where = { ...PORTAL_ARTICLES };
    if (q) where.OR = [{ title: { contains: q, mode: 'insensitive' } }, { body: { contains: q, mode: 'insensitive' } }];
    if (category) where.category = category;
    const articles = await prisma.knowledgeArticle.findMany({ where, select: { id: true, title: true, category: true, summary: true, viewCount: true }, orderBy: { viewCount: 'desc' }, take: +limit });
    res.json(articles);
  } catch (err) { next(err); }
});

// One article with its body, under the same rules: the list has no body and
// nothing else in the portal served one.
router.get('/knowledge/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const article = await prisma.knowledgeArticle.findFirst({
      where: { ...PORTAL_ARTICLES, id: String(req.params.id) },
      select: { id: true, title: true, category: true, summary: true, body: true, viewCount: true, updatedAt: true },
    });
    if (!article) return res.status(404).json({ error: 'Not found' });
    res.json(article);
  } catch (err) { next(err); }
});

// Portal user profile update: the account itself, or an administrator. This
// let anyone signed in rewrite any PortalUser row, while portal accounts are
// Users, so it never reached them.
router.put('/users/:id/profile', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const self = req.params.id === req.user.id;
    if (!self && !hasPermission(req.user, 'admin', 'edit')) return res.status(403).json({ error: 'Not your profile' });
    const account = await prisma.user.findFirst({ where: { id: req.params.id, isPortalUser: true }, select: { id: true, contactId: true } });
    if (!account) return res.status(404).json({ error: 'Portal user not found' });

    const { firstName, lastName, phone } = req.body || {};
    const data = {};
    if (typeof firstName === 'string' && firstName.trim()) data.firstName = firstName.trim();
    if (typeof lastName === 'string' && lastName.trim()) data.lastName = lastName.trim();
    const updated = await prisma.user.update({
      where: { id: account.id },
      data,
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    // The phone number lives on the customer's contact.
    if (typeof phone === 'string' && account.contactId) {
      await prisma.contact.update({ where: { id: account.contactId }, data: { phone: phone.trim() || null } });
    }
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
