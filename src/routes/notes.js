const { Router } = require('express');
const { auditMiddleware } = require("../middleware/audit");
const { authenticate, permits } = require('../middleware/auth');
const { canReach, reachableWhere } = require('../middleware/access');
const { isAdmin } = require('../middleware/rowSecurity');
const { crudModelFor } = require('../utils/crud');
const { summaryRoute } = require('../utils/moduleStatus');

const router = Router();
router.use(authenticate);

/**
 * Whether the caller may read the notes on a record: the module's read
 * permission, and a record they can see. Otherwise answers and returns false.
 * These listed the notes on any record id for anyone signed in.
 */
async function readableRecord(req, res, module, recordId) {
  const modelName = crudModelFor(module);
  if (!modelName) { res.status(400).json({ error: `Notes are not available for ${module}` }); return false; }
  if (!permits(req, module, 'read')) { res.status(403).json({ error: `Insufficient permissions for ${module}` }); return false; }
  if (!(await canReach(req, module, modelName, recordId))) { res.status(404).json({ error: 'Not found' }); return false; }
  return true;
}

/** Whether the caller may change a record: module edit and Edit reach. */
async function editableRecord(req, module, recordId) {
  const modelName = crudModelFor(module);
  return !!modelName && permits(req, module, 'edit') && canReach(req, module, modelName, recordId, 'Edit');
}

/** The notes the caller wrote, or that sit on records they may read. */
async function readableNotes(req, notes) {
  if (isAdmin(req.user)) return notes;
  const prisma = req.app.locals.prisma;
  const others = new Map(); // module -> record ids
  for (const n of notes) {
    if (n.authorId === req.userId) continue;
    if (!others.has(n.module)) others.set(n.module, new Set());
    others.get(n.module).add(n.recordId);
  }
  const readable = new Set();
  for (const [module, ids] of others) {
    const modelName = crudModelFor(module);
    if (!modelName || !permits(req, module, 'read')) continue;
    const rows = await prisma[modelName].findMany({ where: await reachableWhere(req, module, modelName, { id: { in: [...ids] } }), select: { id: true } });
    rows.forEach(r => readable.add(`${module}:${r.id}`));
  }
  return notes.filter(n => n.authorId === req.userId || readable.has(`${n.module}:${n.recordId}`));
}

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
    // Pinning reorders a record's notes for everyone who reads them, so it is
    // the author's, or for someone who may change the record. Anyone signed
    // in pinned any note by id.
    if (note.authorId !== req.userId && !isAdmin(req.user) && !(await editableRecord(req, note.module, note.recordId))) {
      return res.status(404).json({ error: 'Not found' });
    }
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
    if (!(await readableRecord(req, res, module, parentId))) return;
    const notes = await prisma.note.findMany({
      // A note names its record by module + recordId.
      where: { module, recordId: parentId, deletedAt: null },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }], take: 50,
    });
    res.json(notes);
  } catch (err) { next(err); }
});

// Search notes
// Searched every note on every record for anyone signed in. It now finds the
// caller's own notes and notes on records they can see, from the most recent
// matches. A note has no title or parentModule, so this failed on every call.
router.get('/search', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { q, module } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    const matches = await prisma.note.findMany({
      where: { deletedAt: null, body: { contains: q, mode: 'insensitive' }, ...(module ? { module } : {}) },
      orderBy: { createdAt: 'desc' }, take: 250,
    });
    const notes = (await readableNotes(req, matches)).slice(0, 25);
    res.json({ results: notes, count: notes.length });
  } catch (err) { next(err); }
});

// Bulk delete notes
// Deleted anyone's notes by id; now the caller's own, unless an admin.
router.post('/bulk/delete', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'ids required' });
    const result = await prisma.note.updateMany({ where: { id: { in: ids }, ...(isAdmin(req.user) ? {} : { authorId: req.userId }) }, data: { deletedAt: new Date() } });
    res.json({ deleted: result.count });
  } catch (err) { next(err); }
});

// Totals from the module's own table.
summaryRoute(router, { module: 'notes', model: 'note' });

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
    if (!(await readableRecord(req, res, module, recordId))) return;
    const notes = await prisma.note.findMany({
      // Live notes only: ones bulk-deleted (soft) came back with the rest.
      where: { module, recordId, deletedAt: null },
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
// On a record the caller can see; this took any module and record id.
router.post('/:module/:recordId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!(await readableRecord(req, res, req.params.module, req.params.recordId))) return;
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
