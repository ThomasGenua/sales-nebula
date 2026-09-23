const { Router } = require('express');
const { authenticate, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { canReach, reachableWhere } = require('../middleware/access');
const { isAdmin } = require('../middleware/rowSecurity');
const { crudModelFor } = require('../utils/crud');
const { queryWithIncludes } = require('../utils/modelFields');
const { summaryRoute } = require('../utils/moduleStatus');

const router = Router();

/**
 * The model behind a record module the caller may read, or null once it has
 * answered. Posting took any module and record id with a session alone.
 */
function feedModel(req, res, module) {
  const modelName = typeof module === 'string' ? crudModelFor(module) : null;
  if (!modelName) { res.status(400).json({ error: `Feed posts are not available for ${module}` }); return null; }
  if (!permits(req, module, 'read')) { res.status(403).json({ error: `Insufficient permissions for ${module}` }); return null; }
  return modelName;
}

// Get activity feed for any record
router.get('/:module/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module: mod, id } = req.params;
    const { limit = 50, before } = req.query;
    const where = { parentModule: mod, parentId: id };
    if (before) where.createdAt = { lt: new Date(before) };
    
    const entries = await queryWithIncludes(prisma, 'feedItem', 'findMany', {
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
    const modelName = feedModel(req, res, mod);
    if (!modelName) return;
    if (!(await canReach(req, mod, modelName, id))) return res.status(404).json({ error: 'Record not found' });
    const { type, body, visibility } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'body required' });
    const entry = await queryWithIncludes(prisma, 'feedItem', 'create', {
      data: {
        parentModule: mod, parentId: id,
        type: type || 'TextPost', body: body.trim(),
        visibility: visibility || 'AllUsers',
        authorId: req.user.id,
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
    const comment = await queryWithIncludes(prisma, 'feedComment', 'create', {
      data: { feedItemId: req.params.entryId, body: body.trim(), authorId: req.user.id },
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
    // The author column is authorId; FeedItem has no userId, so this refused everyone.
    if (entry.authorId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'Can only delete own entries' });
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
    // FeedLike has no relation to its item, only feedItemId, so find the
    // record's items first.
    const items = await prisma.feedItem.findMany({ where: { parentId: req.params.recordId }, select: { id: true } });
    const itemIds = items.map(i => i.id);
    const [comments, likes] = await Promise.all([
      prisma.feedComment.count({ where: { feedItem: { parentId: req.params.recordId } } }),
      itemIds.length ? prisma.feedLike.count({ where: { feedItemId: { in: itemIds } } }) : 0,
    ]);
    const total = items.length;
    res.json({ recordId: req.params.recordId, totalPosts: total, totalComments: comments, totalLikes: likes });
  } catch (err) { next(err); }
});

// Bulk post to multiple records
router.post('/bulk', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { recordIds, body, module } = req.body;
    // The module is needed to check the records; the old default, 'general', named none.
    if (!Array.isArray(recordIds) || !recordIds.length || !body || !module) {
      return res.status(400).json({ error: 'recordIds, body and module required' });
    }
    const modelName = feedModel(req, res, module);
    if (!modelName) return;
    // Only the records the caller can see.
    const visible = await prisma[modelName].findMany({
      where: await reachableWhere(req, module, modelName, { id: { in: recordIds.slice(0, 50).map(String) } }),
      select: { id: true },
    });
    const posts = await Promise.all(visible.map(({ id }) =>
      prisma.feedItem.create({ data: { parentId: id, parentModule: module, body, type: 'text', authorId: req.user.id } })
    ));
    res.status(201).json({ created: posts.length });
  } catch (err) { next(err); }
});

// Totals from the module's own table.
summaryRoute(router, { module: 'feed', model: 'feedItem' });

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
