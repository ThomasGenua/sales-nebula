const { Router } = require('express');
const { authenticate, requirePermission, permits } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { canReach, reachableWhere, linkRefusal } = require('../middleware/access');
const { isAdmin } = require('../middleware/rowSecurity');
const { modelHasField } = require('../utils/modelFields');
const { summaryRoute } = require('../utils/moduleStatus');

const router = Router();

// CallRecording has no deletedAt, and filtering on it failed every list.
const live = modelHasField('callRecording', 'deletedAt') ? { deletedAt: null } : {};

/**
 * Whether the caller may see (or, with 'edit', change) the recordings on a
 * deal: the deals permission, and a deal they can reach.
 */
async function reachesDeal(req, dealId, level = 'read') {
  return !!dealId && permits(req, 'deals', level) && canReach(req, 'deals', 'deal', dealId, level === 'edit' ? 'Edit' : 'Read');
}

// A recording's keys to other modules' records. CallRecording declares no
// relations, so linkRefusal, which follows the schema's, finds none of them.
const LINKS = [['dealId', 'deals', 'deal'], ['contactId', 'contacts', 'contact'], ['accountId', 'accounts', 'account']];

/**
 * Why `data` may not link a recording to the records its keys name, or null:
 * linkRefusal, then each of LINKS as linkRefusal checks a declared key, a
 * live record in a module the caller may read that row security shows them.
 */
async function recordingLinkRefusal(req, data) {
  const refusal = await linkRefusal(req, 'callRecording', data);
  if (refusal) return refusal;
  for (const [key, module, model] of LINKS) {
    const value = data[key];
    if (value === undefined || value === null || value === '') continue;
    const found = permits(req, module, 'read') && await req.app.locals.prisma[model].findFirst({
      where: await reachableWhere(req, module, model, { id: String(value) }),
      select: { id: true },
    });
    if (!found) return `${key} does not name a ${module.replace(/s$/, '')} you can see`;
  }
  return null;
}

// Calls and their transcripts belong to whoever made them. These listed,
// summarised and analysed anyone's, for anyone signed in. A caller now has
// their own, plus those on a deal they can reach when they ask for one;
// an administrator has all.

// List recordings
router.get('/recordings', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50, userId, dealId } = req.query;
    let where = { ...live };
    if (userId) where.userId = userId;
    if (dealId) where.dealId = dealId;
    if (!isAdmin(req.user) && !(await reachesDeal(req, dealId))) where = { AND: [where, { userId: req.user.id }] };
    const [data, total] = await Promise.all([
      prisma.callRecording.findMany({ where, orderBy: { createdAt: 'desc' }, take: +limit, skip: (+page - 1) * +limit }),
      prisma.callRecording.count({ where }),
    ]);
    res.json({ data, total, page: +page, pages: Math.ceil(total / +limit) });
  } catch (err) { next(err); }
});

// Upload recording
router.post('/recordings', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { title, duration, dealId, contactId, participants, transcript } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    // Its own columns, as the caller's recording, linked only to records they
    // can see: it could be filed on anyone's deal or contact.
    const refusal = await recordingLinkRefusal(req, { dealId, contactId });
    if (refusal) return res.status(400).json({ error: refusal, code: 'LINK_NOT_VISIBLE' });
    const recording = await prisma.callRecording.create({
      data: { title, duration: duration || 0, dealId, contactId, userId: req.user.id, participants: participants || [], transcription: transcript, status: transcript ? 'Transcribed' : 'Uploaded' },
    });
    res.status(201).json(recording);
  } catch (err) { next(err); }
});

// Analyze recording
router.post('/analyze', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { recordingId, transcript } = req.body;
    // The analysis is written back onto the recording, so it must be one the
    // caller may change: their own, or one on a deal they can edit.
    let recording = null;
    if (recordingId) {
      recording = await prisma.callRecording.findUnique({ where: { id: recordingId } });
      const mayChange = recording && (isAdmin(req.user) || recording.userId === req.user.id || await reachesDeal(req, recording.dealId, 'edit'));
      if (!mayChange) return res.status(404).json({ error: 'Recording not found' });
    }
    const text = transcript || recording?.transcription;
    if (!text) return res.status(400).json({ error: 'transcript or recordingId required' });
    // Basic text analysis
    const wordCount = text.split(/\s+/).length;
    const sentences = text.split(/[.!?]+/).filter(Boolean);
    const questions = sentences.filter(s => s.trim().endsWith('?') || s.includes('?'));
    const keywords = ['pricing', 'budget', 'timeline', 'competitor', 'decision', 'next steps', 'objection', 'discount', 'contract'];
    const detectedTopics = keywords.filter(k => text.toLowerCase().includes(k));
    // Sentiment (simple)
    const positiveWords = ['great', 'excellent', 'love', 'perfect', 'amazing', 'interested', 'agree', 'yes', 'absolutely'];
    const negativeWords = ['concern', 'issue', 'problem', 'expensive', 'no', 'difficult', 'worried', 'unfortunately'];
    const posCount = positiveWords.filter(w => text.toLowerCase().includes(w)).length;
    const negCount = negativeWords.filter(w => text.toLowerCase().includes(w)).length;
    const sentiment = posCount > negCount ? 'Positive' : negCount > posCount ? 'Negative' : 'Neutral';
    const analysis = {
      wordCount, sentenceCount: sentences.length, questionCount: questions.length,
      detectedTopics, sentiment, talkRatio: 'N/A (single transcript)',
      keyMoments: detectedTopics.map(t => ({ topic: t, context: 'Detected in conversation' })),
      nextSteps: detectedTopics.includes('next steps') ? 'Next steps were discussed' : 'No clear next steps identified',
    };
    if (recordingId) await prisma.callRecording.update({ where: { id: recordingId }, data: { analysis, status: 'Analyzed' } });
    res.json(analysis);
  } catch (err) { next(err); }
});

// Insights dashboard
router.get('/insights', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { from, to } = req.query;
    const where = { ...live };
    if (!isAdmin(req.user)) where.userId = req.user.id;
    if (from || to) { where.createdAt = {}; if (from) where.createdAt.gte = new Date(from); if (to) where.createdAt.lte = new Date(to); }
    const recordings = await prisma.callRecording.findMany({ where });
    const analyzed = recordings.filter(r => r.analysis);
    const topicFrequency = {};
    analyzed.forEach(r => {
      const topics = r.analysis?.detectedTopics || [];
      topics.forEach(t => { topicFrequency[t] = (topicFrequency[t] || 0) + 1; });
    });
    res.json({
      totalRecordings: recordings.length, analyzedCount: analyzed.length,
      avgDuration: recordings.length ? Math.round(recordings.reduce((s, r) => s + (r.duration || 0), 0) / recordings.length) : 0,
      topicFrequency, sentimentBreakdown: {
        positive: analyzed.filter(r => r.analysis?.sentiment === 'Positive').length,
        neutral: analyzed.filter(r => r.analysis?.sentiment === 'Neutral').length,
        negative: analyzed.filter(r => r.analysis?.sentiment === 'Negative').length,
      },
    });
  } catch (err) { next(err); }
});

// Trends
router.get('/trends', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const recordings = await prisma.callRecording.findMany({
      where: { createdAt: { gte: thirtyDaysAgo }, ...(isAdmin(req.user) ? {} : { userId: req.user.id }) },
      orderBy: { createdAt: 'asc' },
    });
    // Group by week
    const weeklyData = {};
    recordings.forEach(r => {
      const week = new Date(r.createdAt).toISOString().split('T')[0].substring(0, 7);
      if (!weeklyData[week]) weeklyData[week] = { count: 0, totalDuration: 0 };
      weeklyData[week].count++;
      weeklyData[week].totalDuration += r.duration || 0;
    });
    res.json({ period: '30 days', weeklyData, totalRecordings: recordings.length });
  } catch (err) { next(err); }
});

// Dialer
router.get('/dialer/status', authenticate, async (req, res, next) => {
  res.json({ status: 'ready', provider: 'built-in', features: ['click-to-call', 'recording', 'transcription'] });
});

router.post('/dialer/call', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { contactId, phone } = req.body;
    if (!phone && !contactId) return res.status(400).json({ error: 'phone or contactId required' });
    // A contact it names, whose number it dials and on whom the call is filed,
    // must be one the caller can see: any contact's number went back to
    // anyone signed in, by id.
    if (contactId && !(permits(req, 'contacts', 'read') && await canReach(req, 'contacts', 'contact', contactId))) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    let phoneNumber = phone;
    if (contactId && !phone) {
      const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { phone: true } });
      phoneNumber = contact?.phone;
    }
    if (!phoneNumber) return res.status(400).json({ error: 'No phone number available' });
    const call = await prisma.callRecording.create({
      data: { title: `Call to ${phoneNumber}`, userId: req.user.id, contactId, status: 'InProgress' },
    });
    res.json({ callId: call.id, phone: phoneNumber, status: 'connecting' });
  } catch (err) { next(err); }
});

module.exports = router;

// Totals from the module's own table.
summaryRoute(router, { module: 'conversationIntelligence', model: 'callRecording' });
