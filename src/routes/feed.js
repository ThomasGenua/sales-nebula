const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();

// Get activity feed for any record
router.get('/:module/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module: mod, id } = req.params;
    const { limit = 50, before } = req.query;
    const where = { parentModule: mod, parentId: id };
    if (before) where.createdAt = { lt: new Date(before) };
    
    const entries = await prisma.feedItem.findMany({
      where, orderBy: { createdAt: 'desc' }, take: +limit,
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });
    res.json({ data: entries, module: mod, recordId: id });
  } catch (err) { next(err); }
});

// Add feed entry
router.post('/:module/:id', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module: mod, id } = req.params;
    const { type, body, visibility } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'body required' });
    const entry = await prisma.feedItem.create({
      data: {
        parentModule: mod, parentId: id,
        type: type || 'TextPost', body: body.trim(),
        visibility: visibility || 'AllUsers',
        userId: req.user.id,
      },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });
    // Emit real-time event
    try { req.app.locals.emit?.('feed:new', { module: mod, recordId: id, entry }); } catch (e) {}
    res.status(201).json(entry);
  } catch (err) { next(err); }
});

// Comment on feed entry
router.post('/:entryId/comment', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { body } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'body required' });
    const parent = await prisma.feedItem.findUnique({ where: { id: req.params.entryId } });
    if (!parent) return res.status(404).json({ error: 'Feed entry not found' });
    const comment = await prisma.feedComment.create({
      data: { feedItemId: req.params.entryId, body: body.trim(), userId: req.user.id },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });
    res.status(201).json(comment);
  } catch (err) { next(err); }
});

// Like/unlike feed entry
router.post('/:entryId/like', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.feedLike.findFirst({ where: { feedItemId: req.params.entryId, userId: req.user.id } });
    if (existing) {
      await prisma.feedLike.delete({ where: { id: existing.id } });
      res.json({ liked: false });
    } else {
      await prisma.feedLike.create({ data: { feedItemId: req.params.entryId, userId: req.user.id } });
      res.json({ liked: true });
    }
  } catch (err) { next(err); }
});

// Delete feed entry
router.delete('/:entryId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const entry = await prisma.feedItem.findUnique({ where: { id: req.params.entryId } });
    if (!entry) return res.status(404).json({ error: 'Not found' });
    if (entry.userId !== req.user.id) return res.status(403).json({ error: 'Can only delete own entries' });
    await prisma.feedItem.delete({ where: { id: req.params.entryId } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;

// Feed for specific record type
router.get('/module/:module', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { limit = 30 } = req.query;
    const items = await prisma.feedItem.findMany({
      where: { parentModule: req.params.module },
      orderBy: { createdAt: 'desc' }, take: +limit,
    });
    res.json(items);
  } catch (err) { next(err); }
});

// Mentions
router.get('/mentions', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const mentions = await prisma.feedItem.findMany({
      where: { body: { contains: req.user.id } },
      orderBy: { createdAt: 'desc' }, take: 20,
    }).catch(() => []);
    res.json(mentions);
  } catch (err) { next(err); }
});

// Feed stats for a record
router.get('/:recordId/stats', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [total, comments, likes] = await Promise.all([
      prisma.feedItem.count({ where: { parentId: req.params.recordId } }),
      prisma.feedComment.count({ where: { feedItem: { parentId: req.params.recordId } } }).catch(() => 0),
      prisma.feedLike.count({ where: { feedItem: { parentId: req.params.recordId } } }).catch(() => 0),
    ]);
    res.json({ recordId: req.params.recordId, totalPosts: total, totalComments: comments, totalLikes: likes });
  } catch (err) { next(err); }
});

// Bulk post to multiple records
router.post('/bulk', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { recordIds, body, module } = req.body;
    if (!recordIds?.length || !body) return res.status(400).json({ error: 'recordIds and body required' });
    const posts = await Promise.all(recordIds.slice(0, 50).map(id =>
      prisma.feedItem.create({ data: { parentId: id, parentModule: module || 'general', body, type: 'text', authorId: req.user.id } })
    ));
    res.status(201).json({ created: posts.length });
  } catch (err) { next(err); }
});

// Analytics / Stats
router.get('/analytics/summary', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const thirtyDays = new Date(Date.now() - 30 * 86400000);
    const modelName = 'Feed';
    // Generic stats endpoint
    const stats = {
      module: 'feed',
      generatedAt: new Date(),
      environment: process.env.NODE_ENV || 'development',
    };
    res.json(stats);
  } catch (err) { next(err); }
});

// Bulk status update
router.post('/bulk/status', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { ids, status } = req.body;
    if (!ids?.length || !status) return res.status(400).json({ error: 'ids and status required' });
    const updated = await Promise.all(ids.slice(0, 100).map(async (id) => {
      try { return await prisma.$executeRaw`UPDATE "feed" SET status = ${status} WHERE id = ${id}`; }
      catch (e) { return null; }
    }));
    await req.audit({ action: 'bulk_update', module: 'feed', details: `Bulk status update: ${ids.length} records to ${status}` });
    res.json({ updated: updated.filter(Boolean).length, requested: ids.length });
  } catch (err) { next(err); }
});
