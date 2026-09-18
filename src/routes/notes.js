const { Router } = require('express');
const { auditMiddleware } = require("../middleware/audit");
const { authenticate } = require('../middleware/auth');

const router = Router();
router.use(authenticate);

// UPDATE note
router.put('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.note.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.authorId !== req.userId) return res.status(403).json({ error: 'Can only edit your own notes' });

    const note = await prisma.note.update({
      where: { id: req.params.id },
      data: { body: req.body.body, pinned: req.body.pinned },
    });
    res.json(note);
  } catch (err) { next(err); }
});

// DELETE note
router.delete('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.note.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.authorId !== req.userId) return res.status(403).json({ error: 'Can only delete your own notes' });

    await prisma.note.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PIN/UNPIN note
router.post('/:id/pin', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const note = await prisma.note.findUnique({ where: { id: req.params.id } });
    if (!note) return res.status(404).json({ error: 'Not found' });
    const updated = await prisma.note.update({
      where: { id: req.params.id },
      data: { pinned: !note.pinned },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

module.exports = router;

// Pin/unpin note

// Notes for a parent record
router.get('/parent/:module/:parentId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, parentId } = req.params;
    const notes = await prisma.note.findMany({
      where: { parentModule: module, parentId, deletedAt: null },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }], take: 50,
    });
    res.json(notes);
  } catch (err) { next(err); }
});

// Search notes
router.get('/search', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { q, module } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    const where = { deletedAt: null, OR: [{ title: { contains: q, mode: 'insensitive' } }, { body: { contains: q, mode: 'insensitive' } }] };
    if (module) where.parentModule = module;
    const notes = await prisma.note.findMany({ where, orderBy: { createdAt: 'desc' }, take: 25 });
    res.json({ results: notes, count: notes.length });
  } catch (err) { next(err); }
});

// Bulk delete notes
router.post('/bulk/delete', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'ids required' });
    const result = await prisma.note.updateMany({ where: { id: { in: ids } }, data: { deletedAt: new Date() } });
    res.json({ deleted: result.count });
  } catch (err) { next(err); }
});

// Analytics / Stats
router.get('/analytics/summary', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const thirtyDays = new Date(Date.now() - 30 * 86400000);
    const modelName = 'Notes';
    // Generic stats endpoint
    const stats = {
      module: 'notes',
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
      try { return await prisma.$executeRaw`UPDATE "notes" SET status = ${status} WHERE id = ${id}`; }
      catch (e) { return null; }
    }));
    await req.audit({ action: 'bulk_update', module: 'notes', details: `Bulk status update: ${ids.length} records to ${status}` });
    res.json({ updated: updated.filter(Boolean).length, requested: ids.length });
  } catch (err) { next(err); }
});

/**
 * Catch-all record routes, registered last on purpose.
 *
 * Express matches in order, and "/:module/:recordId" is two segments — the
 * same shape as /notes/:id/pin, /notes/bulk/delete, /notes/bulk/status and
 * /notes/analytics/summary. While it sat at the top of this file it swallowed
 * all four: pinning a note ran the create handler instead, which threw
 * "Argument `body` is missing" because a pin request carries no body.
 */
// GET notes for a record
router.get('/:module/:recordId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { module, recordId } = req.params;
    const notes = await prisma.note.findMany({
      where: { module, recordId },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
    });

    // Hydrate author names
    const authorIds = [...new Set(notes.map(n => n.authorId))];
    const authors = await prisma.user.findMany({
      where: { id: { in: authorIds } },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    const authorMap = Object.fromEntries(authors.map(a => [a.id, a]));

    res.json({
      data: notes.map(n => ({ ...n, author: authorMap[n.authorId] || null })),
    });
  } catch (err) { next(err); }
});

// CREATE note
router.post('/:module/:recordId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const note = await prisma.note.create({
      data: {
        body: req.body.body,
        pinned: req.body.pinned || false,
        module: req.params.module,
        recordId: req.params.recordId,
        authorId: req.userId,
      },
    });
    const author = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    res.status(201).json({ ...note, author });
  } catch (err) { next(err); }
});
