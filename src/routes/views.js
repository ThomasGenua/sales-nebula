const { Router } = require('express');
const { Prisma } = require('@prisma/client');
const { authenticate } = require('../middleware/auth');
const { pickModelFields } = require('../utils/modelFields');

const router = Router();
router.use(authenticate);

/**
 * A view's Json columns as Prisma takes them. It refuses a plain null for
 * one, so clearing a view's columns, or cloning a view that has none,
 * failed (500). An empty optional one is stored as a database null; the
 * required filters are never emptied.
 */
function jsonColumns(data) {
  for (const key of ['columns', 'sharedWith', 'sharedWithTeams']) if (data[key] === null) data[key] = Prisma.DbNull;
  if (data.filters === null) delete data.filters;
  return data;
}

// Who a view is for: 'private' its owner alone; 'team' its owner and the users
// and teams it names (sharedWith, sharedWithTeams); 'public' everyone.
const VISIBILITIES = ['private', 'team', 'public'];

/** The ids in a stored list of users or teams (plain ids, or objects with an id). */
const idsIn = list => (Array.isArray(list) ? list.map(x => String(x?.id ?? x)) : []);

/** The live, active teams a user is on, through which a view shared with a team reaches them. */
async function teamIdsOf(prisma, userId) {
  const memberships = await prisma.teamMember.findMany({ where: { userId, team: { deletedAt: null, active: true } }, select: { teamId: true } });
  return memberships.map(m => m.teamId);
}

/**
 * Whether a user may use a view, as its sharing says. Any view marked shared
 * went to everyone, whoever it was shared with. One shared before a view could
 * name anyone (isShared, with no visibility and no one named) still does.
 */
function mayUseView(view, userId, teamIds) {
  if (view.userId === userId) return true;
  if (view.visibility === 'private') return false;
  if (view.visibility === 'public') return true;
  const users = idsIn(view.sharedWith), teams = idsIn(view.sharedWithTeams);
  if (view.visibility === 'team' || (view.isShared && (users.length || teams.length))) {
    return users.includes(userId) || teams.some(t => teamIds.includes(t));
  }
  return !!view.isShared && !view.visibility;
}

// GET /api/views/:module - List saved views for a module
router.get('/:module', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const [views, teamIds] = await Promise.all([
      prisma.savedView.findMany({
        where: {
          module: req.params.module,
          OR: [
            { userId: req.userId },
            { isShared: true },
            { visibility: { in: ['team', 'public'] } },
          ],
        },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      }),
      teamIdsOf(prisma, req.userId),
    ]);
    // Each as its sharing says (mayUseView).
    res.json({ data: views.filter(v => mayUseView(v, req.userId, teamIds)) });
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
      data: jsonColumns({ name, module, filters: filters || [], columns, sortBy, sortDir, isDefault: isDefault || false, isShared: isShared || false, userId: req.userId }),
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
    const data = jsonColumns(pickModelFields('savedView', body).data);
    if (data.visibility != null && !VISIBILITIES.includes(data.visibility)) {
      return res.status(400).json({ error: `visibility must be one of ${VISIBILITIES.join(', ')}` });
    }

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
 * The view, if the caller may use it: their own, or one shared with them
 * (mayUseView). Sharing, cloning and setting a default each took any id, so
 * one user could copy another's private view or rewrite its settings.
 */
async function visibleView(prisma, id, userId) {
  const view = await prisma.savedView.findUnique({ where: { id } });
  if (!view) return null;
  return view.userId === userId || mayUseView(view, userId, await teamIdsOf(prisma, userId)) ? view : null;
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
      data: jsonColumns({ ...data, name: `${original.name} (Copy)`, userId: req.userId, isDefault: false, isShared: false, visibility: null, sharedWith: undefined, sharedWithTeams: undefined }),
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
    // Sharing means what it stores (mayUseView): a known visibility, and lists of ids.
    if (!VISIBILITIES.includes(visibility)) return res.status(400).json({ error: `visibility must be one of ${VISIBILITIES.join(', ')}` });
    if ([shareWith, teamIds].some(list => list != null && !Array.isArray(list))) {
      return res.status(400).json({ error: 'shareWith and teamIds must be lists of ids' });
    }
    const updated = await prisma.savedView.update({
      where: { id: existing.id },
      data: jsonColumns({
        visibility,
        // The list reads isShared; setting only visibility shared nothing.
        isShared: visibility !== 'private',
        ...(shareWith !== undefined && { sharedWith: shareWith }),
        ...(teamIds !== undefined && { sharedWithTeams: teamIds }),
      }),
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
