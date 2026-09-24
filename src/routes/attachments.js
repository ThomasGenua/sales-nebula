/**
 * File attachments on CRM records.
 *
 * Every write here used to name columns the Attachment model does not have
 * (name, originalName, filePath, uploadedById) and omit the one it requires
 * (createdById), so no upload ever succeeded — but multer had already written
 * the file to disk, and the uploads directory was served publicly, unauthen-
 * ticated, with the browser's own content type. An HTML file from a request
 * that answered 500 therefore rendered on the application's origin, where the
 * session tokens live in localStorage. The list handler never sent a response;
 * /download/:id and /:id/versions were shadowed by the generic route declared
 * above them; and nothing checked who could reach a file.
 *
 * Storage keys are random and private. A file is only ever served through an
 * authenticated route that checks the caller can see the record it belongs to,
 * and always as a download, never rendered.
 */

const { Router } = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { authenticate, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { buildAccessFilter, applyAccessFilter, isAdmin } = require('../middleware/rowSecurity');
const { modelHasField } = require('../utils/modelFields');
const { resolveModel } = require('../services/workflowEngine');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE, 10) || 10 * 1024 * 1024;

// A storage key is exactly what this module generates: a UUID and a short
// extension. Anything else — a path separator, a dot-dot — is refused.
const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,10})?$/i;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 11);
    cb(null, `${uuid()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE, files: 10 } });

const router = Router();
router.use(authenticate);

/** A display name safe to store and to put in a Content-Disposition header. */
function displayName(original) {
  const base = path.basename(String(original || 'file')).replace(/[\u0000-\u001f\u007f"\\]/g, '').trim();
  return (base || 'file').slice(0, 255);
}

/** Remove files multer saved for a request that then failed. */
function discard(files) {
  for (const f of files || []) {
    if (f?.path) fs.promises.unlink(f.path).catch(() => {});
  }
}

/**
 * The parent record, if it exists and the caller may see it. Row security and
 * the org-wide default apply exactly as they do to the record itself.
 */
async function visibleParent(req, parentModule, parentId) {
  const prisma = req.app.locals.prisma;
  const modelName = resolveModel(parentModule);
  if (!modelName || !prisma[modelName]?.findFirst) return null;
  // Read permission on the module as well, as for the record itself, and a
  // live record: row security alone let a role with no access to the module
  // reach its files, and a deleted record went on listing and serving them.
  if (!permits(req, parentModule, 'read')) return null;
  const filter = await buildAccessFilter(prisma, req.user, parentModule, { modelName });
  const live = modelHasField(modelName, 'deletedAt') ? { deletedAt: null } : {};
  return prisma[modelName].findFirst({
    where: applyAccessFilter({ id: parentId, ...live }, filter),
    select: { id: true },
  }).catch(() => null);
}

/** The attachment, if the caller may see the record it hangs off. */
async function visibleAttachment(req, id) {
  const prisma = req.app.locals.prisma;
  const attachment = await prisma.attachment.findUnique({ where: { id } }).catch(() => null);
  if (!attachment || attachment.deletedAt) return null;
  const parent = await visibleParent(req, attachment.parentModule, attachment.parentId);
  return parent ? attachment : null;
}

const canModify = (req, attachment) => isAdmin(req.user) || attachment.createdById === req.userId;

const present = a => ({
  id: a.id,
  parentModule: a.parentModule,
  parentId: a.parentId,
  fileName: a.fileName,
  fileSize: a.fileSize,
  mimeType: a.mimeType,
  description: a.description,
  createdById: a.createdById,
  createdAt: a.createdAt,
  downloadUrl: `/api/attachments/download/${a.id}`,
});

// ─── Specific routes first, so the generic /:parentModule/:parentId below
//     cannot swallow them. ───

// Recent attachments the caller can see
router.get('/recent', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const recent = await prisma.attachment.findMany({
      where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 50,
    });
    const visible = [];
    for (const a of recent) {
      if (visible.length >= 20) break;
      if (await visibleParent(req, a.parentModule, a.parentId)) visible.push(present(a));
    }
    res.json(visible);
  } catch (err) { next(err); }
});

// Download — always as a file, never rendered in the browser
router.get('/download/:id', async (req, res, next) => {
  try {
    const attachment = await visibleAttachment(req, req.params.id);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
    if (!attachment.url || !KEY_PATTERN.test(attachment.url)) {
      return res.status(404).json({ error: 'Attachment file is missing' });
    }

    const full = path.join(UPLOAD_DIR, attachment.url);
    if (path.dirname(full) !== UPLOAD_DIR || !fs.existsSync(full)) {
      return res.status(404).json({ error: 'Attachment file is missing' });
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.download(full, attachment.fileName, { headers: { 'Content-Type': 'application/octet-stream' } });
  } catch (err) { next(err); }
});

// Storage summary per parent
router.get('/summary/:parentModule/:parentId', async (req, res, next) => {
  try {
    const { parentModule, parentId } = req.params;
    if (!await visibleParent(req, parentModule, parentId)) return res.status(404).json({ error: 'Record not found' });
    const atts = await req.app.locals.prisma.attachment.findMany({ where: { parentModule, parentId, deletedAt: null } });
    const totalSize = atts.reduce((s, a) => s + (a.fileSize || 0), 0);
    const byType = {};
    for (const a of atts) {
      const ext = path.extname(a.fileName || '').slice(1).toLowerCase() || 'unknown';
      byType[ext] = (byType[ext] || 0) + 1;
    }
    res.json({ count: atts.length, totalSizeBytes: totalSize, totalSizeMB: Math.round(totalSize / 1048576 * 100) / 100, byType });
  } catch (err) { next(err); }
});

// Upload one file
router.post('/:parentModule/:parentId', auditMiddleware, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const { parentModule, parentId } = req.params;
    if (!await visibleParent(req, parentModule, parentId)) {
      discard([req.file]);
      return res.status(404).json({ error: 'Record not found' });
    }

    const attachment = await req.app.locals.prisma.attachment.create({
      data: {
        parentModule, parentId,
        fileName: displayName(req.file.originalname),
        fileSize: req.file.size,
        mimeType: req.file.mimetype || null,
        url: req.file.filename,
        description: req.body.description || null,
        createdById: req.userId,
      },
    });
    await req.audit({ action: 'create', module: 'attachments', recordId: attachment.id, details: `File uploaded: ${attachment.fileName}` });
    res.status(201).json(present(attachment));
  } catch (err) {
    discard([req.file]);
    next(err);
  }
});

// Upload several files
router.post('/:parentModule/:parentId/bulk', auditMiddleware, upload.array('files', 10), async (req, res, next) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'No files provided' });
    const { parentModule, parentId } = req.params;
    if (!await visibleParent(req, parentModule, parentId)) {
      discard(req.files);
      return res.status(404).json({ error: 'Record not found' });
    }

    const prisma = req.app.locals.prisma;
    const attachments = await prisma.$transaction(req.files.map(file => prisma.attachment.create({
      data: {
        parentModule, parentId,
        fileName: displayName(file.originalname),
        fileSize: file.size,
        mimeType: file.mimetype || null,
        url: file.filename,
        createdById: req.userId,
      },
    })));
    res.status(201).json({ uploaded: attachments.length, attachments: attachments.map(present) });
  } catch (err) {
    discard(req.files);
    next(err);
  }
});

// List attachments on a record — this used to fetch them and never respond
router.get('/:parentModule/:parentId', async (req, res, next) => {
  try {
    const { parentModule, parentId } = req.params;
    if (!await visibleParent(req, parentModule, parentId)) return res.status(404).json({ error: 'Record not found' });
    const attachments = await req.app.locals.prisma.attachment.findMany({
      where: { parentModule, parentId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    res.json(attachments.map(present));
  } catch (err) { next(err); }
});

// Update metadata — the uploader or an administrator
router.put('/:id', auditMiddleware, async (req, res, next) => {
  try {
    const attachment = await visibleAttachment(req, req.params.id);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
    if (!canModify(req, attachment)) return res.status(403).json({ error: 'Only the uploader or an administrator can change this file' });

    const { fileName, description } = req.body;
    const updated = await req.app.locals.prisma.attachment.update({
      where: { id: attachment.id },
      data: {
        ...(fileName !== undefined && { fileName: displayName(fileName) }),
        ...(description !== undefined && { description }),
      },
    });
    res.json(present(updated));
  } catch (err) { next(err); }
});

// Delete (soft) — the uploader or an administrator
router.delete('/:id', auditMiddleware, async (req, res, next) => {
  try {
    const attachment = await visibleAttachment(req, req.params.id);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
    if (!canModify(req, attachment)) return res.status(403).json({ error: 'Only the uploader or an administrator can delete this file' });

    await req.app.locals.prisma.attachment.update({ where: { id: attachment.id }, data: { deletedAt: new Date() } });
    await req.audit({ action: 'delete', module: 'attachments', recordId: attachment.id });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Multer's own limit errors are the client's fault, not the server's.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    discard(req.files || (req.file ? [req.file] : []));
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  next(err);
});

module.exports = router;
