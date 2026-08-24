const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuid } = require('uuid');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || './uploads'),
  filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10485760 } });

const router = Router();

// List attachments for a parent record
router.get('/:parentModule/:parentId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { parentModule, parentId } = req.params;
    const attachments = await prisma.attachment.findMany({
      where: { parentModule, parentId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    res.json(attachments);
  } catch (err) { next(err); }
});

// Upload attachment
router.post('/:parentModule/:parentId', authenticate, auditMiddleware, upload.single('file'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const { parentModule, parentId } = req.params;
    const attachment = await prisma.attachment.create({
      data: {
        name: req.body.name || req.file.originalname,
        fileName: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
        filePath: req.file.path,
        parentModule, parentId,
        description: req.body.description || null,
        uploadedById: req.user.id,
      },
    });
    await req.audit({ action: 'create', module: 'attachments', recordId: attachment.id, details: `File uploaded: ${req.file.originalname}` });
    res.status(201).json(attachment);
  } catch (err) { next(err); }
});

// Upload multiple attachments
router.post('/:parentModule/:parentId/bulk', authenticate, auditMiddleware, upload.array('files', 10), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!req.files?.length) return res.status(400).json({ error: 'No files provided' });
    const { parentModule, parentId } = req.params;
    const attachments = await prisma.$transaction(
      req.files.map(file => prisma.attachment.create({
        data: {
          name: file.originalname, fileName: file.filename, originalName: file.originalname,
          mimeType: file.mimetype, fileSize: file.size, filePath: file.path,
          parentModule, parentId, uploadedById: req.user.id,
        },
      }))
    );
    res.status(201).json({ uploaded: attachments.length, attachments });
  } catch (err) { next(err); }
});

// Download attachment
router.get('/download/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const attachment = await prisma.attachment.findUnique({ where: { id: req.params.id } });
    if (!attachment || attachment.deletedAt) return res.status(404).json({ error: 'Attachment not found' });
    await prisma.attachment.update({ where: { id: req.params.id }, data: { downloadCount: (attachment.downloadCount || 0) + 1, lastDownloadedAt: new Date() } });
    res.download(attachment.filePath, attachment.originalName || attachment.fileName);
  } catch (err) { next(err); }
});

// Delete attachment (soft delete)
router.delete('/:id', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.attachment.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    await req.audit({ action: 'delete', module: 'attachments', recordId: req.params.id });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Update metadata
router.put('/:id', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description } = req.body;
    const attachment = await prisma.attachment.update({
      where: { id: req.params.id },
      data: { ...(name && { name }), ...(description !== undefined && { description }) },
    });
    res.json(attachment);
  } catch (err) { next(err); }
});

module.exports = router;

// Attachment versions
router.get('/:id/versions', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const att = await prisma.attachment.findUnique({ where: { id: req.params.id } });
    if (!att) return res.status(404).json({ error: 'Not found' });
    const versions = await prisma.attachment.findMany({
      where: { parentId: att.parentId, parentModule: att.parentModule, name: att.name, deletedAt: null },
      orderBy: { version: 'desc' },
    }).catch(() => [att]);
    res.json(versions);
  } catch (err) { next(err); }
});

// Storage summary per parent
router.get('/summary/:module/:parentId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const atts = await prisma.attachment.findMany({ where: { parentModule: req.params.module, parentId: req.params.parentId, deletedAt: null } });
    const totalSize = atts.reduce((s, a) => s + (a.fileSize || 0), 0);
    const byType = {};
    atts.forEach(a => { const ext = (a.name || '').split('.').pop()?.toLowerCase() || 'unknown'; byType[ext] = (byType[ext] || 0) + 1; });
    res.json({ count: atts.length, totalSizeBytes: totalSize, totalSizeMB: Math.round(totalSize / 1048576 * 100) / 100, byType });
  } catch (err) { next(err); }
});

// Attachment analytics per parent
router.get('/stats/:module/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const atts = await prisma.attachment.findMany({ where: { parentModule: req.params.module, parentId: req.params.id, deletedAt: null }, select: { fileSize: true, mimeType: true, downloadCount: true, createdAt: true } });
    const totalSize = atts.reduce((s, a) => s + (a.fileSize || 0), 0);
    const byType = {};
    atts.forEach(a => { const t = (a.mimeType || 'unknown').split('/')[0]; byType[t] = (byType[t] || 0) + 1; });
    res.json({ count: atts.length, totalSizeBytes: totalSize, totalSizeMB: (totalSize / 1048576).toFixed(2), byType, totalDownloads: atts.reduce((s, a) => s + (a.downloadCount || 0), 0) });
  } catch (err) { next(err); }
});

// Recent attachments across system
router.get('/recent', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const atts = await prisma.attachment.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, name: true, parentModule: true, parentId: true, mimeType: true, fileSize: true, createdAt: true } });
    res.json(atts);
  } catch (err) { next(err); }
});
