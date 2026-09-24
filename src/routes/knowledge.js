const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { columnsFrom } = require('../utils/modelFields');

const router = Router();
router.use(authenticate, auditMiddleware);

// ─── ARTICLES ───

router.get('/', requirePermission('knowledge', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { category, status, search, visibility, tag } = req.query;
    let where = {};
    if (category) where.category = category;
    if (status) where.status = status;
    if (visibility) where.visibility = visibility;
    if (tag) where.tags = { has: tag };
    if (search) where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { body: { contains: search, mode: 'insensitive' } },
      { summary: { contains: search, mode: 'insensitive' } },
      { tags: { has: search } },
    ];
    const articles = await prisma.knowledgeArticle.findMany({
      where,
      include: { author: { select: { id: true, firstName: true, lastName: true } }, _count: { select: { attachments: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    res.json({ data: articles });
  } catch (err) { next(err); }
});

router.get('/:id', requirePermission('knowledge', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const article = await prisma.knowledgeArticle.findUnique({
      where: { id: req.params.id },
      include: { author: { select: { id: true, firstName: true, lastName: true } }, attachments: true },
    });
    if (!article) return res.status(404).json({ error: 'Not found' });

    // Increment view count
    await prisma.knowledgeArticle.update({ where: { id: req.params.id }, data: { viewCount: { increment: 1 } } });

    // Find related articles (same category or shared tags)
    const related = await prisma.knowledgeArticle.findMany({
      where: {
        id: { not: article.id },
        status: 'Published',
        OR: [
          { category: article.category },
          ...(article.tags.length > 0 ? [{ tags: { hasSome: article.tags } }] : []),
        ],
      },
      select: { id: true, title: true, category: true, summary: true },
      take: 5,
    });

    res.json({ ...article, viewCount: article.viewCount + 1, related });
  } catch (err) { next(err); }
});

// Lookup by slug. Portal accounts never reach /api/knowledge, so this takes
// knowledge read like the reads above; it served Internal articles to anyone.
router.get('/slug/:slug', requirePermission('knowledge', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const article = await prisma.knowledgeArticle.findUnique({
      where: { slug: req.params.slug },
      include: { author: { select: { firstName: true, lastName: true } } },
    });
    if (!article || article.status !== 'Published') return res.status(404).json({ error: 'Not found' });
    await prisma.knowledgeArticle.update({ where: { id: article.id }, data: { viewCount: { increment: 1 } } });
    res.json(article);
  } catch (err) { next(err); }
});

router.post('/', requirePermission('knowledge', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // The article's own columns: relation keys in the body were nested writes.
    const data = { ...columnsFrom('knowledgeArticle', req.body), authorId: req.userId };
    // Auto-generate slug from title
    if (!data.slug) {
      data.slug = data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      // Ensure uniqueness
      const existing = await prisma.knowledgeArticle.findUnique({ where: { slug: data.slug } });
      if (existing) data.slug += '-' + Date.now().toString(36);
    }
    if (data.status === 'Published' && !data.publishedAt) data.publishedAt = new Date();
    const article = await prisma.knowledgeArticle.create({ data, include: { author: { select: { id: true, firstName: true, lastName: true } } } });
    await req.audit({ action: 'create', module: 'knowledge', recordId: article.id, details: `Created article: ${article.title}` });
    res.status(201).json(article);
  } catch (err) { next(err); }
});

router.put('/:id', requirePermission('knowledge', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const data = columnsFrom('knowledgeArticle', req.body);
    delete data.authorId;
    if (data.status === 'Published' && !data.publishedAt) data.publishedAt = new Date();
    const article = await prisma.knowledgeArticle.update({ where: { id: req.params.id }, data });
    res.json(article);
  } catch (err) { next(err); }
});

// Publish
router.post('/:id/publish', requirePermission('knowledge', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const article = await prisma.knowledgeArticle.update({
      where: { id: req.params.id },
      data: { status: 'Published', publishedAt: new Date() },
    });
    res.json(article);
  } catch (err) { next(err); }
});

// New version (clone and increment)
router.post('/:id/new-version', requirePermission('knowledge', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const original = await prisma.knowledgeArticle.findUnique({ where: { id: req.params.id } });
    if (!original) return res.status(404).json({ error: 'Not found' });

    // Archive old version
    await prisma.knowledgeArticle.update({ where: { id: original.id }, data: { status: 'Archived' } });

    // Create new version
    const newArticle = await prisma.knowledgeArticle.create({
      data: {
        title: original.title,
        slug: original.slug + '-v' + (original.version + 1),
        body: original.body,
        summary: original.summary,
        category: original.category,
        visibility: original.visibility,
        authorId: req.userId,
        version: original.version + 1,
        tags: original.tags,
        status: 'Draft',
      },
    });
    res.status(201).json(newArticle);
  } catch (err) { next(err); }
});

// Vote helpful/not helpful, on an article the voter may read
router.post('/:id/vote', requirePermission('knowledge', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { helpful } = req.body;
    const update = helpful ? { helpfulYes: { increment: 1 } } : { helpfulNo: { increment: 1 } };
    const article = await prisma.knowledgeArticle.update({ where: { id: req.params.id }, data: update });
    res.json({ helpfulYes: article.helpfulYes, helpfulNo: article.helpfulNo });
  } catch (err) { next(err); }
});

router.delete('/:id', requirePermission('knowledge', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.knowledgeArticle.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── CATEGORIES ───

router.get('/categories/all', requirePermission('knowledge', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const categories = await prisma.knowledgeCategory.findMany({ orderBy: { sortOrder: 'asc' } });
    // Compute article counts
    for (const cat of categories) {
      cat.articleCount = await prisma.knowledgeArticle.count({ where: { category: cat.name, status: 'Published' } });
    }
    res.json({ data: categories });
  } catch (err) { next(err); }
});

router.post('/categories', requirePermission('knowledge', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const cat = await prisma.knowledgeCategory.create({ data: columnsFrom('knowledgeCategory', req.body) });
    res.status(201).json(cat);
  } catch (err) { next(err); }
});

// ─── STATS ───

router.get('/stats/overview', requirePermission('knowledge', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [total, published, draft, totalViews] = await Promise.all([
      prisma.knowledgeArticle.count(),
      prisma.knowledgeArticle.count({ where: { status: 'Published' } }),
      prisma.knowledgeArticle.count({ where: { status: 'Draft' } }),
      prisma.knowledgeArticle.aggregate({ _sum: { viewCount: true } }),
    ]);
    const topArticles = await prisma.knowledgeArticle.findMany({
      where: { status: 'Published' },
      orderBy: { viewCount: 'desc' },
      take: 10,
      select: { id: true, title: true, viewCount: true, helpfulYes: true, helpfulNo: true, category: true },
    });
    res.json({ total, published, draft, totalViews: totalViews._sum.viewCount || 0, topArticles });
  } catch (err) { next(err); }
});

module.exports = router;
