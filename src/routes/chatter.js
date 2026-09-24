const { Router } = require('express');
const { authenticate, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { canReach, reachableWhere } = require('../middleware/access');
const { isAdmin } = require('../middleware/rowSecurity');
const { crudModelFor } = require('../utils/crud');

const router = Router();
router.use(authenticate, auditMiddleware);

/**
 * Whether the caller may read a record's posts, and post on it: the module's
 * read permission, and a live record they can see, as notes.js asks for a
 * record's notes. Otherwise answers and returns false. Any record's feed was
 * read, and posted to, with a session alone.
 */
async function readableRecord(req, res, module, recordId) {
  const modelName = typeof module === 'string' ? crudModelFor(module) : null;
  if (!modelName) { res.status(400).json({ error: `Chatter is not available for ${module}` }); return false; }
  if (!permits(req, module, 'read')) { res.status(403).json({ error: `Insufficient permissions for ${module}` }); return false; }
  const found = await req.app.locals.prisma[modelName].findFirst({ where: await reachableWhere(req, module, modelName, { id: String(recordId) }), select: { id: true } });
  if (!found) { res.status(404).json({ error: 'Not found' }); return false; }
  return true;
}

/** Whether the caller may change a record: module edit and Edit reach, as notes.js asks to pin. */
async function editableRecord(req, module, recordId) {
  const modelName = crudModelFor(module);
  return !!modelName && permits(req, module, 'edit') && canReach(req, module, modelName, recordId, 'Edit');
}

/**
 * Of `posts`, those the caller may see: posts on no record, their own, and
 * those on live records they may read, as feed.js judges its posts. One that
 * names a record by id alone, with no module to check it by, is its author's.
 */
async function readablePosts(req, posts) {
  if (isAdmin(req.user)) return posts;
  const others = new Map(); // module -> record ids
  for (const p of posts) {
    if (p.authorId === req.userId || !p.parentModule || !p.parentId) continue;
    if (!others.has(p.parentModule)) others.set(p.parentModule, new Set());
    others.get(p.parentModule).add(p.parentId);
  }
  const readable = new Set();
  for (const [module, ids] of others) {
    const modelName = crudModelFor(module);
    if (!modelName || !permits(req, module, 'read')) continue;
    const rows = await req.app.locals.prisma[modelName].findMany({ where: await reachableWhere(req, module, modelName, { id: { in: [...ids] } }), select: { id: true } });
    rows.forEach(r => readable.add(`${module}:${r.id}`));
  }
  const onNoRecord = p => !p.parentModule && !p.parentId;
  return posts.filter(p => onNoRecord(p) || p.authorId === req.userId || readable.has(`${p.parentModule}:${p.parentId}`));
}

/**
 * The post at `id` when the caller may see it (readablePosts), or null once it
 * has answered 404. A missing post threw (500) or failed on a foreign key, and
 * one on a record they cannot see took comments and likes.
 */
async function findPost(req, res) {
  const post = await req.app.locals.prisma.chatterPost.findUnique({ where: { id: req.params.id } });
  const visible = post && (await readablePosts(req, [post])).length > 0;
  if (!visible) res.status(404).json({ error: 'Post not found' });
  return visible ? post : null;
}

const postInclude = {
  author: { select: { id: true, firstName: true, lastName: true, avatar: true } },
  comments: {
    include: { author: { select: { id: true, firstName: true, lastName: true, avatar: true } } },
    orderBy: { createdAt: 'asc' },
  },
  likes: { select: { userId: true } },
  mentions: true,
  _count: { select: { comments: true, likes: true } },
};

// FEED - global or record-specific
router.get(['/', '/feed'], async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId, page = 1, limit = 20 } = req.query;
    // A page of at most 100; a page or limit that was not a number failed the query.
    const take = Math.min(parseInt(limit) || 20, 100);
    const current = Math.max(parseInt(page) || 1, 1);
    let where = {};
    if (module && recordId) {
      // A record's feed is for those who may read the record (readableRecord).
      if (!(await readableRecord(req, res, String(module), recordId))) return;
      where = { parentModule: String(module), parentId: String(recordId) };
    } else {
      // Global feed: posts on no record. One naming a record by id alone has no
      // module to check it by, so only its author (or an admin) sees it, as
      // readablePosts judges it; paged in the database, so counts stay right.
      where = isAdmin(req.user) ? { parentModule: null } : { parentModule: null, OR: [{ parentId: null }, { authorId: req.userId }] };
    }
    const [posts, total] = await Promise.all([
      prisma.chatterPost.findMany({
        where,
        include: postInclude,
        orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
        skip: (current - 1) * take,
        take,
      }),
      prisma.chatterPost.count({ where }),
    ]);

    // Add "liked by me" flag, and the comment count the Chatter page shows
    // (commentCount, which a post has no column for, so it always read 0).
    const enriched = posts.map(p => ({
      ...p,
      likedByMe: p.likes.some(l => l.userId === req.userId),
      commentCount: p._count.comments,
    }));

    res.json({ data: enriched, meta: { total, page: current, limit: take, pages: Math.ceil(total / take) } });
  } catch (err) { next(err); }
});

// MY FEED - posts I'm mentioned in or that I authored
router.get('/my-feed', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const mentions = await prisma.chatterMention.findMany({ where: { userId: req.userId }, select: { postId: true } });
    const mentionIds = mentions.map(m => m.postId);

    const posts = await prisma.chatterPost.findMany({
      where: { OR: [{ authorId: req.userId }, { id: { in: mentionIds } }] },
      include: postInclude,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    // A mention on a record the caller cannot see does not hand them the post.
    res.json({ data: await readablePosts(req, posts) });
  } catch (err) { next(err); }
});

// CREATE post
router.post('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { body, parentModule, parentId } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Post body required' });
    // A post on a record names its module and id, on a record the caller may
    // read (readableRecord); one on no record is global. Either alone was stored.
    if (!parentModule !== !parentId) return res.status(400).json({ error: 'parentModule and parentId go together' });
    if (parentModule && !(await readableRecord(req, res, parentModule, parentId))) return;
    // Users who exist: anything but a list failed on .map, and an unknown id
    // failed its notification (500) after the post was saved.
    const mentionUserIds = Array.isArray(req.body.mentionUserIds)
      ? (await prisma.user.findMany({ where: { id: { in: req.body.mentionUserIds.map(String) } }, select: { id: true } })).map(u => u.id)
      : undefined;

    const post = await prisma.chatterPost.create({
      data: {
        body,
        authorId: req.userId,
        parentModule: parentModule || null,
        parentId: parentId ? String(parentId) : null,
        ...(mentionUserIds && { mentions: { create: mentionUserIds.map(uid => ({ userId: uid })) } }),
      },
      include: postInclude,
    });

    // Notify mentioned users
    if (mentionUserIds?.length > 0) {
      const author = await prisma.user.findUnique({ where: { id: req.userId }, select: { firstName: true, lastName: true } });
      for (const uid of mentionUserIds) {
        await prisma.notification.create({
          data: {
            title: 'You were mentioned',
            message: `${author.firstName} ${author.lastName} mentioned you: "${body.substring(0, 100)}"`,
            userId: uid,
            recordModule: parentModule,
            recordId: parentId,
          },
        });
      }
    }

    res.status(201).json(post);
  } catch (err) { next(err); }
});

// COMMENT on a post
router.post('/:id/comments', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { body } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Comment body required' });
    const post = await findPost(req, res);
    if (!post) return;

    const comment = await prisma.chatterComment.create({
      data: { body, postId: req.params.id, authorId: req.userId },
      include: { author: { select: { id: true, firstName: true, lastName: true, avatar: true } } },
    });

    // Notify post author
    if (post.authorId !== req.userId) {
      const commenter = await prisma.user.findUnique({ where: { id: req.userId }, select: { firstName: true } });
      await prisma.notification.create({
        data: { title: 'New comment on your post', message: `${commenter.firstName} commented: "${body.substring(0, 80)}"`, userId: post.authorId },
      });
    }

    res.status(201).json(comment);
  } catch (err) { next(err); }
});

// LIKE / UNLIKE
router.post('/:id/like', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!(await findPost(req, res))) return;
    const existing = await prisma.chatterLike.findUnique({
      where: { postId_userId: { postId: req.params.id, userId: req.userId } },
    });

    if (existing) {
      await prisma.chatterLike.delete({ where: { id: existing.id } });
      await prisma.chatterPost.update({ where: { id: req.params.id }, data: { likeCount: { decrement: 1 } } });
      res.json({ liked: false });
    } else {
      await prisma.chatterLike.create({ data: { postId: req.params.id, userId: req.userId } });
      await prisma.chatterPost.update({ where: { id: req.params.id }, data: { likeCount: { increment: 1 } } });
      res.json({ liked: true });
    }
  } catch (err) { next(err); }
});

// PIN / UNPIN
router.post('/:id/pin', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const post = await findPost(req, res);
    if (!post) return;
    // Pinning moves a post up its feed for everyone who reads it, so it is the
    // author's, an admin's, or for someone who may change the record it is on,
    // as for notes. Anyone signed in pinned any post.
    const mayPin = post.authorId === req.userId || isAdmin(req.user)
      || (post.parentModule && post.parentId && await editableRecord(req, post.parentModule, post.parentId));
    if (!mayPin) return res.status(403).json({ error: 'Only the author, an admin or someone who can edit the record can pin this post' });
    const updated = await prisma.chatterPost.update({ where: { id: req.params.id }, data: { pinned: !post.pinned } });
    res.json({ pinned: updated.pinned });
  } catch (err) { next(err); }
});

// DELETE post (author only or admin)
router.delete('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const post = await findPost(req, res);
    if (!post) return;
    if (post.authorId !== req.userId && req.userRole !== 'Admin') {
      return res.status(403).json({ error: 'Only author or admin can delete' });
    }
    await prisma.chatterPost.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// EDIT post
router.put('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const post = await findPost(req, res);
    if (!post) return;
    if (post.authorId !== req.userId) return res.status(403).json({ error: 'Only author can edit' });
    if (!req.body.body?.trim?.()) return res.status(400).json({ error: 'Post body required' });
    const updated = await prisma.chatterPost.update({
      where: { id: req.params.id },
      data: { body: req.body.body },
      include: postInclude,
    });
    res.json(updated);
  } catch (err) { next(err); }
});

module.exports = router;
