const { Router } = require('express');
const { authenticate } = require('../middleware/auth');

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

    const { id, createdAt, updatedAt, userId, ...data } = req.body;

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

// POST /api/views/:id/set-default
router.post('/:id/set-default', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const view = await prisma.savedView.findUnique({ where: { id: req.params.id } });
    if (!view) return res.status(404).json({ error: 'Not found' });

    // Unset other defaults
    await prisma.savedView.updateMany({
      where: { userId: req.userId, module: view.module, isDefault: true },
      data: { isDefault: false },
    });

    const updated = await prisma.savedView.update({
      where: { id: req.params.id },
      data: { isDefault: true },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

module.exports = router;

// Clone a view
router.post('/:id/clone', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const original = await prisma.savedView.findUnique({ where: { id: req.params.id } });
    if (!original) return res.status(404).json({ error: 'View not found' });
    const { id, createdAt, updatedAt, ...data } = original;
    const clone = await prisma.savedView.create({ data: { ...data, name: `${original.name} (Copy)`, userId: req.user.id, isDefault: false } });
    res.status(201).json(clone);
  } catch (err) { next(err); }
});

// Set default view for user
router.post('/:id/set-default', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const view = await prisma.savedView.findUnique({ where: { id: req.params.id } });
    if (!view) return res.status(404).json({ error: 'View not found' });
    await prisma.savedView.updateMany({ where: { module: view.module, userId: req.user.id, isDefault: true }, data: { isDefault: false } });
    const updated = await prisma.savedView.update({ where: { id: req.params.id }, data: { isDefault: true } });
    res.json(updated);
  } catch (err) { next(err); }
});

// Share view
router.post('/:id/share', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { shareWith, visibility } = req.body;
    const updated = await prisma.savedView.update({ where: { id: req.params.id }, data: { visibility: visibility || 'team', sharedWith: shareWith || [] } });
    res.json(updated);
  } catch (err) { next(err); }
});

// Clone view
router.post('/:id/clone', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const original = await prisma.savedView.findUnique({ where: { id: req.params.id } });
    if (!original) return res.status(404).json({ error: 'Not found' });
    const { id, createdAt, updatedAt, ...data } = original;
    const clone = await prisma.savedView.create({ data: { ...data, name: `${original.name} (Copy)`, isDefault: false, userId: req.user.id } });
    res.status(201).json(clone);
  } catch (err) { next(err); }
});

// Share view with team
router.post('/:id/share', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { visibility, teamIds } = req.body;
    const view = await prisma.savedView.update({ where: { id: req.params.id }, data: { visibility: visibility || 'team', sharedWithTeams: teamIds || [] } });
    res.json(view);
  } catch (err) { next(err); }
});

// View usage tracking
router.post('/:id/track', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.savedView.update({ where: { id: req.params.id }, data: { viewCount: { increment: 1 }, lastViewedAt: new Date() } });
    res.json({ tracked: true });
  } catch (err) { next(err); }
});
