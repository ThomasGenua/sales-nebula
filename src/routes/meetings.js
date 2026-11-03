const router = require('express').Router();
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const service = require('../services/meetingIntelligence');
const { authenticate, requirePermission } = require('../middleware/auth');
const { isAdmin } = require('../middleware/rowSecurity');
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const upload = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => fs.mkdir(service.directory(), { recursive: true }, e => cb(e, service.directory())), filename: (req, file, cb) => cb(null, crypto.randomUUID() + '.audio') }), limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 8, fieldSize: 600000 } });
router.use(authenticate, requirePermission('activities', 'read'), (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/config', (req, res) => res.json({ transcription: !!process.env.DEEPGRAM_API_KEY, summaries: require('../services/claude').isConfigured(), maxFileMb: 100 }));
router.get('/', wrap(async (req, res) => {
  const db = req.app.locals.prisma, jobs = await db.meetingJob.findMany({ where: isAdmin(req.user) ? {} : { userId: req.userId }, orderBy: { createdAt: 'desc' }, take: 50, select: { recordingId: true, status: true, createdAt: true } });
  const recordings = await db.callRecording.findMany({ where: { id: { in: jobs.map(j => j.recordingId) } }, select: { id: true, title: true, duration: true } });
  res.json({ data: jobs.map(j => ({ ...j, ...recordings.find(r => r.id === j.recordingId) })) });
}));
router.post('/', requirePermission('activities', 'edit'), upload.single('audio'), wrap(async (req, res) => {
  let persisted = false;
  try {
    const { title, transcript, dealId, contactId, accountId, consent } = req.body;
    if (consent !== 'true' && consent !== true) return res.status(400).json({ error: 'Confirm you have permission to record and process this meeting' });
    if (typeof title !== 'string' || !title.trim() || title.length > 200) return res.status(400).json({ error: 'Enter a meeting title shorter than 200 characters' });
    if ((!req.file && !transcript) || (req.file && transcript)) return res.status(400).json({ error: 'Choose either a recording or a transcript' });
    if (transcript && (typeof transcript !== 'string' || transcript.trim().length < 10 || transcript.length > 150000)) return res.status(400).json({ error: 'Use a transcript between 10 and 150,000 characters' });
    if (!require('../services/claude').isConfigured() || (req.file && !process.env.DEEPGRAM_API_KEY)) return res.status(503).json({ error: 'Configure Claude summaries and, for recordings, Deepgram transcription in the deployment' });
    const links = { dealId: dealId || null, contactId: contactId || null, accountId: accountId || null }; await service.checkLinks(req, links);
    const contentType = req.file ? await service.validateAudio(req.file.filename) : null, db = req.app.locals.prisma;
    const recording = await db.$transaction(async tx => {
      const row = await tx.callRecording.create({ data: { ...links, title: title.trim(), userId: req.userId, transcription: transcript?.trim() || null, status: 'Queued' } });
      await tx.meetingJob.create({ data: { recordingId: row.id, userId: req.userId, consentAt: new Date(), fileKey: req.file?.filename, contentType } }); return row;
    });
    persisted = true; res.status(201).json({ id: recording.id, status: 'Queued' });
    setImmediate(() => service.processJob(db, recording.id).catch(() => {}));
  } finally { if (!persisted && req.file) await service.removeAudio(req.file.filename); }
}));
router.param('id', async (req, res, next, id) => {
  try {
    req.meeting = await req.app.locals.prisma.callRecording.findFirst({ where: { id, ...(!isAdmin(req.user) && { userId: req.userId }) } });
    if (!req.meeting || !await req.app.locals.prisma.meetingJob.findUnique({ where: { recordingId: id } })) return res.status(404).json({ error: 'Meeting not found' });
    next();
  } catch (e) { next(e); }
});
router.get('/:id', wrap(async (req, res) => {
  const job = await req.app.locals.prisma.meetingJob.findUnique({ where: { recordingId: req.meeting.id }, select: { status: true, segments: true, suggestions: true, reviewedAt: true, error: true, fileKey: true } });
  const hasAudio = !!job.fileKey; delete job.fileKey; res.json({ recording: req.meeting, job: { ...job, hasAudio } });
}));
router.post('/:id/retry', requirePermission('activities', 'edit'), wrap(async (req, res) => {
  const db = req.app.locals.prisma, job = await db.meetingJob.findUnique({ where: { recordingId: req.meeting.id } });
  if (!['Ready', 'Failed'].includes(job.status) || job.reviewedAt) return res.status(409).json({ error: 'This meeting cannot be reprocessed' });
  if (!job.fileKey && !req.meeting.transcription) return res.status(410).json({ error: 'The recording expired. Upload it again to retry.' });
  await service.checkLinks(req, req.meeting);
  const updated = await db.meetingJob.updateMany({ where: { recordingId: req.meeting.id, status: job.status, reviewedAt: null }, data: { status: 'Queued', error: null } });
  if (!updated.count) return res.status(409).json({ error: 'This meeting is already being processed' });
  res.json({ queued: true }); setImmediate(() => service.processJob(db, req.meeting.id).catch(() => {}));
}));
router.post('/:id/apply', requirePermission('activities', 'edit'), wrap(async (req, res) => res.json(await service.apply(req.app.locals.prisma, req, req.meeting, req.body))));
router.delete('/:id', requirePermission('activities', 'edit'), wrap(async (req, res) => {
  const db = req.app.locals.prisma, lease = await require('../utils/lease').acquireLease(db, 'meeting:' + req.meeting.id, 900000);
  if (!lease) return res.status(409).json({ error: 'Wait for processing to finish before deleting this meeting' });
  try {
    const job = await db.meetingJob.findUnique({ where: { recordingId: req.meeting.id } }); await service.removeAudio(job.fileKey);
    await db.$transaction([db.meetingJob.delete({ where: { recordingId: req.meeting.id } }), db.callRecording.delete({ where: { id: req.meeting.id } })]); res.json({ deleted: true });
  } finally { await require('../utils/lease').releaseLease(db, 'meeting:' + req.meeting.id, lease); }
}));
router.use((err, req, res, next) => { if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Recordings must be no larger than 100 MB' : 'Upload one recording with the meeting details' }); next(err); });
module.exports = router;
