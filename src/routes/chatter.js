const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = Router();
router.use(authenticate, auditMiddleware);

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
router.get('/feed', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId, page = 1, limit = 20 } = req.query;
    let where = {};
    if (module && recordId) {
      where = { parentModule: module, parentId: recordId };
    } else {
      where = { parentModule: null }; // Global feed
    }
    const [posts, total] = await Promise.all([
      prisma.chatterPost.findMany({
        where,
        include: postInclude,
        orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.chatterPost.count({ where }),
    ]);

    // Add "liked by me" flag
    const enriched = posts.map(p => ({
      ...p,
      likedByMe: p.likes.some(l => l.userId === req.userId),
    }));

    res.json({ data: enriched, meta: { total, page: parseInt(page) } });
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
    res.json({ data: posts });
  } catch (err) { next(err); }
});

// CREATE post
router.post('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { body, parentModule, parentId, mentionUserIds } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Post body required' });

    const post = await prisma.chatterPost.create({
      data: {
        body,
        authorId: req.userId,
        parentModule: parentModule || null,
        parentId: parentId || null,
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

    const comment = await prisma.chatterComment.create({
      data: { body, postId: req.params.id, authorId: req.userId },
      include: { author: { select: { id: true, firstName: true, lastName: true, avatar: true } } },
    });

    // Notify post author
    const post = await prisma.chatterPost.findUnique({ where: { id: req.params.id }, select: { authorId: true } });
    if (post && post.authorId !== req.userId) {
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
    const post = await prisma.chatterPost.findUnique({ where: { id: req.params.id } });
    const updated = await prisma.chatterPost.update({ where: { id: req.params.id }, data: { pinned: !post.pinned } });
    res.json({ pinned: updated.pinned });
  } catch (err) { next(err); }
});

// DELETE post (author only or admin)
router.delete('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const post = await prisma.chatterPost.findUnique({ where: { id: req.params.id } });
    if (post?.authorId !== req.userId && req.userRole !== 'Admin') {
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
    const post = await prisma.chatterPost.findUnique({ where: { id: req.params.id } });
    if (post?.authorId !== req.userId) return res.status(403).json({ error: 'Only author can edit' });
    const updated = await prisma.chatterPost.update({
      where: { id: req.params.id },
      data: { body: req.body.body },
      include: postInclude,
    });
    res.json(updated);
  } catch (err) { next(err); }
});

module.exports = router;
