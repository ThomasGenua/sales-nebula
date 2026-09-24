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

/**
 * The posts the caller wrote, or that sit on records they may read, as
 * notes.js does for notes. The general feeds (a module's, mentions, a
 * record's stats) and comments and likes took every post with a session.
 */
async function readablePosts(req, posts) {
  if (isAdmin(req.user)) return posts;
  const prisma = req.app.locals.prisma;
  const others = new Map(); // module -> record ids
  for (const p of posts) {
    if (p.authorId === req.user.id || !p.parentModule || !p.parentId) continue;
    if (!others.has(p.parentModule)) others.set(p.parentModule, new Set());
    others.get(p.parentModule).add(p.parentId);
  }
  const readable = new Set();
  for (const [module, ids] of others) {
    const modelName = crudModelFor(module);
    if (!modelName || !permits(req, module, 'read')) continue;
    const rows = await prisma[modelName].findMany({ where: await reachableWhere(req, module, modelName, { id: { in: [...ids] } }), select: { id: true } });
    rows.forEach(r => readable.add(`${module}:${r.id}`));
  }
  return posts.filter(p => p.authorId === req.user.id || readable.has(`${p.parentModule}:${p.parentId}`));
}

// How many recent posts a general feed reads to find those the caller may see.
const RECENT = 500;

// Comment on feed entry
// On a post the caller can see; this took any post id.
router.post('/:entryId/comment', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { body } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'body required' });
    const parent = await prisma.feedItem.findUnique({ where: { id: req.params.entryId } });
    if (!parent || !(await readablePosts(req, [parent])).length) return res.status(404).json({ error: 'Feed entry not found' });
    const comment = await queryWithIncludes(prisma, 'feedComment', 'create', {
      data: { feedItemId: req.params.entryId, body: body.trim(), authorId: req.user.id },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });
    res.status(201).json(comment);
  } catch (err) { next(err); }
});

// Like/unlike feed entry
// On a post the caller can see; this took any id, a post's or not.
router.post('/:entryId/like', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const entry = await prisma.feedItem.findUnique({ where: { id: req.params.entryId } });
    if (!entry || !(await readablePosts(req, [entry])).length) return res.status(404).json({ error: 'Feed entry not found' });
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
// Every post in the module went to anyone signed in. Now the caller's own and
// those on records they can see, from the most recent posts.
router.get('/module/:module', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { limit = 30 } = req.query;
    const items = await prisma.feedItem.findMany({
      where: { parentModule: req.params.module },
      orderBy: { createdAt: 'desc' }, take: RECENT,
    });
    res.json((await readablePosts(req, items)).slice(0, +limit || 30));
  } catch (err) { next(err); }
});

// Mentions
// Of the posts naming the caller, those they may see; a mention on a record
// they cannot open handed them the post.
router.get('/mentions', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const mentions = await prisma.feedItem.findMany({
      where: { body: { contains: req.user.id } },
      orderBy: { createdAt: 'desc' }, take: RECENT,
    }).catch(() => []);
    res.json((await readablePosts(req, mentions)).slice(0, 20));
  } catch (err) { next(err); }
});

// Feed stats for a record
// Counted every post, comment and like on any record id for anyone signed in.
// The id names no module, so each post is judged by its own: only those the
// caller may see are counted.
router.get('/:recordId/stats', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // FeedLike has no relation to its item, only feedItemId, so find the
    // record's items first.
    const items = await readablePosts(req, await prisma.feedItem.findMany({
      where: { parentId: req.params.recordId },
      select: { id: true, authorId: true, parentModule: true, parentId: true },
    }));
    const itemIds = items.map(i => i.id);
    const [comments, likes] = itemIds.length ? await Promise.all([
      prisma.feedComment.count({ where: { feedItemId: { in: itemIds } } }),
      prisma.feedLike.count({ where: { feedItemId: { in: itemIds } } }),
    ]) : [0, 0];
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

/**
 * Catch-all record routes, registered last on purpose.
 *
 * Express matches in order, and "/:module/:id" is two segments, the same
 * shape as /:entryId/comment, /:entryId/like, /module/:module,
 * /:recordId/stats and /analytics/summary. While these sat at the top of the
 * file they swallowed all five: a comment or like answered "Feed posts are
 * not available for <entry id>", and the others read a feed for a module
 * named "module", "analytics" or a record id.
 */
// Get activity feed for any record
// The module's read permission and a record the caller can see, as for
// posting; this listed the posts on any record id for anyone signed in.
router.get('/:module/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module: mod, id } = req.params;
    const modelName = feedModel(req, res, mod);
    if (!modelName) return;
    if (!(await canReach(req, mod, modelName, id))) return res.status(404).json({ error: 'Record not found' });
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
