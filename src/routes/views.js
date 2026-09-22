const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { pickModelFields } = require('../utils/modelFields');

const router = Router();
router.use(authenticate);

// GET /api/views/:module - List saved views for a module
router.get('/:module', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const views = await prisma.savedView.findMany({
      where: {
        module: req.params.module,
        OR: [
          { userId: req.userId },
          { isShared: true },
        ],
      },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    res.json({ data: views });
  } catch (err) { next(err); }
});

// POST /api/views - Create saved view
router.post('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, module, filters, columns, sortBy, sortDir, isDefault, isShared } = req.body;
    if (!name?.trim() || !module?.trim()) return res.status(400).json({ error: 'name and module required' });

    // If setting as default, unset other defaults for this user+module
    if (isDefault) {
      await prisma.savedView.updateMany({
        where: { userId: req.userId, module, isDefault: true },
        data: { isDefault: false },
      });
    }

    const view = await prisma.savedView.create({
      data: { name, module, filters: filters || [], columns, sortBy, sortDir, isDefault: isDefault || false, isShared: isShared || false, userId: req.userId },
    });
    res.status(201).json(view);
  } catch (err) { next(err); }
});

// PUT /api/views/:id
router.put('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.savedView.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.userId !== req.userId) return res.status(403).json({ error: 'Can only edit your own views' });

    const { id, createdAt, updatedAt, userId, viewCount, lastViewedAt, ...body } = req.body;
    const { data } = pickModelFields('savedView', body);

    if (data.isDefault) {
      await prisma.savedView.updateMany({
        where: { userId: req.userId, module: existing.module, isDefault: true, id: { not: req.params.id } },
        data: { isDefault: false },
      });
    }

    const view = await prisma.savedView.update({ where: { id: req.params.id }, data });
    res.json(view);
  } catch (err) { next(err); }
});

// DELETE /api/views/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.savedView.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.userId !== req.userId) return res.status(403).json({ error: 'Can only delete your own views' });

    await prisma.savedView.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

/**
 * The view, if the caller may use it: their own, or one shared with everyone.
 * Sharing, cloning and setting a default each took any id, so one user could
 * copy another's private view or rewrite its settings.
 */
async function visibleView(prisma, id, userId) {
  const view = await prisma.savedView.findUnique({ where: { id } });
  return view && (view.userId === userId || view.isShared) ? view : null;
}

// POST /api/views/:id/set-default - Make one of your own views the default
router.post('/:id/set-default', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const view = await visibleView(prisma, req.params.id, req.userId);
    if (!view) return res.status(404).json({ error: 'Not found' });
    // isDefault lives on the view row, so only its owner can set it.
    if (view.userId !== req.userId) return res.status(403).json({ error: 'Can only set your own views as default' });

    await prisma.savedView.updateMany({
      where: { userId: req.userId, module: view.module, isDefault: true },
      data: { isDefault: false },
    });
    const updated = await prisma.savedView.update({ where: { id: view.id }, data: { isDefault: true } });
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /api/views/:id/clone - Copy a view you can see into your own
router.post('/:id/clone', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const original = await visibleView(prisma, req.params.id, req.userId);
    if (!original) return res.status(404).json({ error: 'View not found' });
    const { id, createdAt, updatedAt, viewCount, lastViewedAt, ...data } = original;
    const clone = await prisma.savedView.create({
      data: { ...data, name: `${original.name} (Copy)`, userId: req.userId, isDefault: false, isShared: false, visibility: null, sharedWith: undefined, sharedWithTeams: undefined },
    });
    res.status(201).json(clone);
  } catch (err) { next(err); }
});

// POST /api/views/:id/share - Share your view with named users, teams or everyone
router.post('/:id/share', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.savedView.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.userId !== req.userId) return res.status(403).json({ error: 'Can only share your own views' });

    const { shareWith, teamIds, visibility = 'team' } = req.body;
    const updated = await prisma.savedView.update({
      where: { id: existing.id },
      data: {
        visibility,
        // The list reads isShared; setting only visibility shared nothing.
        isShared: visibility !== 'private',
        ...(shareWith !== undefined && { sharedWith: shareWith }),
        ...(teamIds !== undefined && { sharedWithTeams: teamIds }),
      },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /api/views/:id/track - Count a use of a view you can see
router.post('/:id/track', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const view = await visibleView(prisma, req.params.id, req.userId);
    if (!view) return res.status(404).json({ error: 'Not found' });
    await prisma.savedView.update({ where: { id: view.id }, data: { viewCount: { increment: 1 }, lastViewedAt: new Date() } });
    res.json({ tracked: true });
  } catch (err) { next(err); }
});

module.exports = router;
