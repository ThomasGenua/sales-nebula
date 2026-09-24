const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { columnsFrom } = require('../utils/modelFields');

const router = Router();

// Reads answer to surveys read (they took a session alone). Only /:id/respond
// below is public, for the people a survey goes to.

// List surveys
router.get('/', authenticate, requirePermission('surveys', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50, status } = req.query;
    const where = { deletedAt: null };
    if (status) where.status = status;
    const [data, total] = await Promise.all([
      prisma.survey.findMany({ where, orderBy: { createdAt: 'desc' }, take: +limit, skip: (+page - 1) * +limit }),
      prisma.survey.count({ where }),
    ]);
    res.json({ data, total, page: +page, pages: Math.ceil(total / +limit) });
  } catch (err) { next(err); }
});

// Get survey with questions
router.get('/:id', authenticate, requirePermission('surveys', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const survey = await prisma.survey.findUnique({ where: { id: req.params.id }, include: { questions: { orderBy: { order: 'asc' } } } });
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    res.json(survey);
  } catch (err) { next(err); }
});

// Create survey
router.post('/', authenticate, requirePermission('surveys', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, questions, type } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const survey = await prisma.survey.create({
      data: {
        name, description, type: type || 'CSAT', status: 'Draft', createdById: req.user.id,
        ...(questions?.length && {
          questions: { create: questions.map((q, i) => ({ text: q.text, type: q.type || 'Rating', options: q.options || null, required: q.required !== false, order: i + 1 })) },
        }),
      },
      include: { questions: true },
    });
    await req.audit({ action: 'create', module: 'surveys', recordId: survey.id, details: `Survey created: ${name}` });
    res.status(201).json(survey);
  } catch (err) { next(err); }
});

// Update survey
router.put('/:id', authenticate, requirePermission('surveys', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const survey = await prisma.survey.update({ where: { id: req.params.id }, data: columnsFrom('survey', req.body) });
    res.json(survey);
  } catch (err) { next(err); }
});

// Add question to survey
router.post('/:id/questions', authenticate, requirePermission('surveys', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { text, type, options, required } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const maxOrder = await prisma.surveyQuestion.aggregate({ where: { surveyId: req.params.id }, _max: { order: true } });
    const question = await prisma.surveyQuestion.create({
      data: { surveyId: req.params.id, text, type: type || 'Rating', options, required: required !== false, position: (maxOrder._max.order || 0) + 1 },
    });
    res.status(201).json(question);
  } catch (err) { next(err); }
});

// Publish/close survey
router.post('/:id/publish', authenticate, requirePermission('surveys', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const survey = await prisma.survey.update({ where: { id: req.params.id }, data: { status: 'Active', publishedAt: new Date() } });
    res.json(survey);
  } catch (err) { next(err); }
});

router.post('/:id/close', authenticate, requirePermission('surveys', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const survey = await prisma.survey.update({ where: { id: req.params.id }, data: { status: 'Closed', closedAt: new Date() } });
    res.json(survey);
  } catch (err) { next(err); }
});

// Submit response (public-facing)
router.post('/:id/respond', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const survey = await prisma.survey.findUnique({ where: { id: req.params.id }, include: { questions: true } });
    if (!survey || survey.status !== 'Active') return res.status(404).json({ error: 'Survey not available' });
    const { contactId, answers } = req.body; // answers: [{ questionId, value }]
    if (!answers?.length) return res.status(400).json({ error: 'answers required' });
    const response = await prisma.surveyResponse.create({
      data: {
        surveyId: req.params.id, contactId: contactId || null, completedAt: new Date(),
        answers: { create: answers.map(a => ({ questionId: a.questionId, value: String(a.value), numericValue: parseFloat(a.value) || null })) },
      },
      include: { answers: true },
    });
    await prisma.survey.update({ where: { id: req.params.id }, data: { responseCount: { increment: 1 } } });
    res.status(201).json({ responseId: response.id, message: 'Thank you for your response' });
  } catch (err) { next(err); }
});

// Get survey results/analytics
router.get('/:id/results', authenticate, requirePermission('surveys', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const survey = await prisma.survey.findUnique({ where: { id: req.params.id }, include: { questions: { include: { answers: true } } } });
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    const totalResponses = survey.responseCount || 0;
    const questionStats = survey.questions.map(q => {
      const answers = q.answers || [];
      const numericAnswers = answers.filter(a => a.numericValue !== null).map(a => a.numericValue);
      return {
        questionId: q.id, text: q.text, type: q.type, responseCount: answers.length,
        ...(numericAnswers.length && {
          average: (numericAnswers.reduce((s, v) => s + v, 0) / numericAnswers.length).toFixed(2),
          min: Math.min(...numericAnswers), max: Math.max(...numericAnswers),
        }),
        ...(q.type === 'MultipleChoice' && {
          distribution: answers.reduce((acc, a) => { acc[a.value] = (acc[a.value] || 0) + 1; return acc; }, {}),
        }),
      };
    });
    // Calculate CSAT/NPS if applicable
    let score = null;
    if (survey.type === 'NPS') {
      const allScores = survey.questions.flatMap(q => q.answers.filter(a => a.numericValue !== null).map(a => a.numericValue));
      if (allScores.length) {
        const promoters = allScores.filter(s => s >= 9).length;
        const detractors = allScores.filter(s => s <= 6).length;
        score = { nps: Math.round(((promoters - detractors) / allScores.length) * 100), promoters, passives: allScores.length - promoters - detractors, detractors, total: allScores.length };
      }
    }
    res.json({ surveyId: survey.id, name: survey.name, totalResponses, questionStats, ...(score && { npsScore: score }) });
  } catch (err) { next(err); }
});

// Delete survey
router.delete('/:id', authenticate, requirePermission('surveys', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    await prisma.survey.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    await req.audit({ action: 'delete', module: 'surveys', recordId: req.params.id });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
