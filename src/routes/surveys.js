const crypto = require('crypto');
const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { columnsFrom, scalarOrderBy } = require('../utils/modelFields');

const router = Router();

// Reads answer to surveys read (they took a session alone). Only /:id/respond
// below is public, for the people a survey goes to.

// A survey keeps its questions in its own `questions` JSON column, and a
// response its answers in `answers`, as the schema has them. Half these routes
// treated both as related rows (included, nested-created, and a SurveyAnswer
// model that does not exist), so creating, reading, answering and reporting
// on a survey all failed.

/** A question as stored: the settings, and an id its answers name. */
const toQuestion = (q, id = crypto.randomUUID()) => ({
  id: String(id), text: String(q.text), type: q.type || 'Rating',
  options: q.options ?? null, required: q.required !== false,
});
const questionsOf = survey => (Array.isArray(survey.questions) ? survey.questions : []);
const badQuestions = list => !Array.isArray(list) || list.some(q => !q || typeof q !== 'object' || !q.text);

/** An answer's value as a number, or null when it is not one. */
const numberOf = a => (String(a.value ?? '').trim() !== '' && Number.isFinite(Number(a.value)) ? Number(a.value) : null);

/** The live survey the path names; answers 404 and returns null otherwise. */
async function liveSurvey(req, res) {
  const survey = await req.app.locals.prisma.survey.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!survey) res.status(404).json({ error: 'Survey not found' });
  return survey;
}

// List surveys
router.get('/', authenticate, requirePermission('surveys', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50, status, search, sortBy, sortDir } = req.query;
    const take = Math.min(parseInt(limit) || 50, 200);
    const current = Math.max(parseInt(page) || 1, 1);
    const where = { deletedAt: null };
    if (status) where.status = status;
    if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }];
    const [data, total] = await Promise.all([
      prisma.survey.findMany({ where, orderBy: scalarOrderBy('survey', sortBy, sortDir) || { createdAt: 'desc' }, take, skip: (current - 1) * take }),
      prisma.survey.count({ where }),
    ]);
    res.json({ data, total, page: current, pages: Math.ceil(total / take) });
  } catch (err) { next(err); }
});

// Get survey with questions
router.get('/:id', authenticate, requirePermission('surveys', 'read'), async (req, res, next) => {
  try {
    const survey = await liveSurvey(req, res);
    if (survey) res.json(survey);
  } catch (err) { next(err); }
});

// Create survey
router.post('/', authenticate, requirePermission('surveys', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, type } = req.body;
    const questions = req.body.questions ?? [];
    if (!name) return res.status(400).json({ error: 'name required' });
    if (badQuestions(questions)) return res.status(400).json({ error: 'questions must be an array of questions with text' });
    const survey = await prisma.survey.create({
      data: {
        name, description, type: type || 'CSAT', status: 'Draft', createdById: req.user.id,
        questions: questions.map(q => toQuestion(q)),
      },
    });
    await req.audit({ action: 'create', module: 'surveys', recordId: survey.id, details: `Survey created: ${name}` });
    res.status(201).json(survey);
  } catch (err) { next(err); }
});

// Update survey
router.put('/:id', authenticate, requirePermission('surveys', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const survey = await liveSurvey(req, res);
    if (!survey) return;
    // Not its author, deletion or response tally: an edit form sends the row
    // back whole, and its count from when the form opened undid the responses
    // that arrived since.
    const data = columnsFrom('survey', req.body);
    for (const key of ['createdById', 'deletedAt', 'responseCount']) delete data[key];
    if (data.questions !== undefined) {
      if (badQuestions(data.questions)) return res.status(400).json({ error: 'questions must be an array of questions with text' });
      // A question keeps its id, so the answers already given still name it.
      data.questions = data.questions.map(q => toQuestion(q, q.id || undefined));
    }
    res.json(await prisma.survey.update({ where: { id: survey.id }, data }));
  } catch (err) { next(err); }
});

// Add question to survey
router.post('/:id/questions', authenticate, requirePermission('surveys', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!req.body.text) return res.status(400).json({ error: 'text required' });
    const survey = await liveSurvey(req, res);
    if (!survey) return;
    const question = toQuestion(req.body);
    await prisma.survey.update({ where: { id: survey.id }, data: { questions: [...questionsOf(survey), question] } });
    res.status(201).json(question);
  } catch (err) { next(err); }
});

// Publish/close survey
router.post('/:id/publish', authenticate, requirePermission('surveys', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const survey = await liveSurvey(req, res);
    if (!survey) return;
    res.json(await req.app.locals.prisma.survey.update({ where: { id: survey.id }, data: { status: 'Active', publishedAt: new Date() } }));
  } catch (err) { next(err); }
});

router.post('/:id/close', authenticate, requirePermission('surveys', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const survey = await liveSurvey(req, res);
    if (!survey) return;
    res.json(await req.app.locals.prisma.survey.update({ where: { id: survey.id }, data: { status: 'Closed', closedAt: new Date() } }));
  } catch (err) { next(err); }
});

// Submit response (public-facing)
router.post('/:id/respond', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const survey = await prisma.survey.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!survey || survey.status !== 'Active') return res.status(404).json({ error: 'Survey not available' });
    const { answers } = req.body; // answers: [{ questionId, value }]
    // Answers to this survey's own questions, stored as { questionId, value }.
    const questions = questionsOf(survey);
    const known = new Set(questions.map(q => q.id).filter(Boolean));
    const given = (Array.isArray(answers) ? answers : [])
      .filter(a => a && known.has(a.questionId) && String(a.value ?? '').trim() !== '')
      .map(a => ({ questionId: a.questionId, value: String(a.value) }));
    if (!given.length) return res.status(400).json({ error: 'answers required' });
    const missing = questions.find(q => q.required && q.id && !given.some(a => a.questionId === q.id));
    if (missing) return res.status(400).json({ error: `An answer is required for: ${missing.text}` });
    // Not filed on a contact. The link names the survey, not who answers it,
    // and anyone may post here, so the body's contactId let anyone put
    // answers on any customer's record.
    const numbers = given.map(numberOf).filter(v => v !== null);
    const response = await prisma.surveyResponse.create({
      data: {
        surveyId: survey.id, contactId: null, completedAt: new Date(), answers: given,
        score: numbers.length ? numbers.reduce((s, v) => s + v, 0) / numbers.length : null,
      },
    });
    await prisma.survey.update({ where: { id: survey.id }, data: { responseCount: { increment: 1 } } });
    res.status(201).json({ responseId: response.id, message: survey.thankYouMessage || 'Thank you for your response' });
  } catch (err) { next(err); }
});

// Get survey results/analytics
router.get('/:id/results', authenticate, requirePermission('surveys', 'read'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const survey = await liveSurvey(req, res);
    if (!survey) return;
    const responses = await prisma.surveyResponse.findMany({ where: { surveyId: survey.id }, select: { answers: true } });
    const byQuestion = new Map();
    for (const r of responses) {
      for (const a of Array.isArray(r.answers) ? r.answers : []) {
        if (!a || !a.questionId) continue;
        if (!byQuestion.has(a.questionId)) byQuestion.set(a.questionId, []);
        byQuestion.get(a.questionId).push(a);
      }
    }
    const totalResponses = responses.length;
    const allScores = [];
    const questionStats = questionsOf(survey).map(q => {
      const answers = byQuestion.get(q.id) || [];
      const numericAnswers = answers.map(numberOf).filter(v => v !== null);
      allScores.push(...numericAnswers);
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
    if (survey.type === 'NPS' && allScores.length) {
      const promoters = allScores.filter(s => s >= 9).length;
      const detractors = allScores.filter(s => s <= 6).length;
      score = { nps: Math.round(((promoters - detractors) / allScores.length) * 100), promoters, passives: allScores.length - promoters - detractors, detractors, total: allScores.length };
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
