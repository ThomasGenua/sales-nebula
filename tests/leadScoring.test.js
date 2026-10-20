/**
 * Lead scoring (services/leadScoring): one evaluator, run on every save of a
 * lead.
 *
 * The web form, POST /api/leads/:id/score and the admin rescore each had a
 * copy of it, knowing different operators, so one lead could score three
 * ways; and a lead was scored without asking only when it came from the form.
 */
const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestUser, authHeader } = require('./setup');

let app, prisma, token;

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  ({ token } = await createTestUser({ email: 'admin@test.com' }));
});

const api = (method, path, body) => request(app)[method](path).set(authHeader(token)).send(body);
const rule = (field, operator, value, points, active = true) => prisma.leadScoringRule.create({
  data: { name: `${field} ${operator}`, field, operator, value, points, active },
});

// An operator each copy disagreed on: the seed's spelling counted nowhere,
// endsWith not from the form, notEquals only on request.
const disputed = async () => {
  await rule('company', 'is_not_empty', '', 10);
  await rule('email', 'endsWith', '@ACME.example', 15);
  await rule('source', 'notEquals', 'Purchased list', 5);
};
const ADA = { firstName: 'Ada', lastName: 'Lovelace', company: 'Acme', email: 'ada@acme.example', source: 'Website' };
const DISPUTED_SCORE = 50 + 10 + 15 + 5;

test('a lead scores the same from the web form, from the app, on request and in the rescore', async () => {
  await disputed();

  const form = await request(app).post('/api/public/web-to-lead').send(ADA);
  expect(form.status).toBe(201);
  expect((await prisma.lead.findUnique({ where: { id: form.body.leadId } })).score).toBe(DISPUTED_SCORE);

  const typed = await api('post', '/api/leads', { ...ADA, email: 'grace@acme.example' });
  expect(typed.status).toBe(201);
  expect(typed.body.score).toBe(DISPUTED_SCORE);

  expect((await api('post', `/api/leads/${typed.body.id}/score`)).body.score).toBe(DISPUTED_SCORE);
  expect((await api('post', '/api/admin/score-all-leads')).body).toMatchObject({ totalLeads: 2, updated: 0 });
});

test('an edit rescores the lead as it will be, in place of a score it sends', async () => {
  await rule('title', 'contains', 'vp', 20);
  const created = await api('post', '/api/leads', { ...ADA, title: 'Engineer' });
  expect(created.body.score).toBe(50);

  const promoted = await api('put', `/api/leads/${created.body.id}`, { title: 'VP Sales', score: 5 });
  expect(promoted.status).toBe(200);
  expect(promoted.body.score).toBe(70);
});

test('with no active rule, a save scores nothing and keeps the score it is given', async () => {
  await rule('company', 'is_not_empty', '', 30, false);
  const created = await api('post', '/api/leads', { ...ADA, score: 12 });
  expect(created.body.score).toBe(12);
  expect((await api('put', `/api/leads/${created.body.id}`, { score: 75 })).body.score).toBe(75);
});

test('a rule on the score itself counts for nothing, so scoring again gives the same answer', async () => {
  await rule('score', 'greaterThan', '60', 30);
  await rule('company', 'is_not_empty', '', 20);
  const created = await api('post', '/api/leads', ADA);
  expect(created.body.score).toBe(70);
  expect((await api('post', `/api/leads/${created.body.id}/score`)).body.score).toBe(70);
  expect((await api('post', `/api/leads/${created.body.id}/score`)).body.score).toBe(70);
});

test('the rescore leaves a lead in the recycle bin as it is', async () => {
  await disputed();
  const binned = await prisma.lead.create({ data: { ...ADA, score: 3, deletedAt: new Date() } });
  expect((await api('post', '/api/admin/score-all-leads')).body).toMatchObject({ totalLeads: 0, updated: 0 });
  expect((await prisma.lead.findUnique({ where: { id: binned.id } })).score).toBe(3);
});

test('the rules screen is offered what the scoring takes: its operators and a lead\'s own fields', async () => {
  const res = await api('get', '/api/admin/scoring-rules');
  expect(res.status).toBe(200);
  expect(res.body.operators).toEqual(expect.arrayContaining(['equals', 'contains', 'endsWith', 'greaterThan', 'isNotEmpty']));
  expect(res.body.operators).not.toContain('is_not_empty');
  expect(res.body.fields).toEqual(expect.arrayContaining(['company', 'email', 'source', 'title', 'value']));
  for (const hidden of ['id', 'ownerId', 'createdAt', 'score']) expect(res.body.fields).not.toContain(hidden);
  // Every one offered is one a rule may be saved with.
  const { scoringRuleProblem } = require('../src/services/leadScoring');
  expect(res.body.operators.map(operator => scoringRuleProblem({ operator })).filter(Boolean)).toEqual([]);
  expect(res.body.fields.map(field => scoringRuleProblem({ field })).filter(Boolean)).toEqual([]);
});

test('a rule no lead could match is refused when it is saved', async () => {
  for (const body of [{ field: 'company', operator: 'fuzzy' }, { field: 'nickname', operator: 'equals' }, { field: 'score', operator: 'greaterThan' }]) {
    const res = await api('post', '/api/admin/scoring-rules', { name: 'Never', value: 'x', points: 10, ...body });
    expect(res.status).toBe(400);
  }
  expect(await prisma.leadScoringRule.count()).toBe(0);

  const kept = await api('post', '/api/admin/scoring-rules', { name: 'Corporate', field: 'company', operator: 'contains', value: 'corp', points: 10 });
  expect(kept.status).toBe(201);
  expect((await api('put', `/api/admin/scoring-rules/${kept.body.id}`, { operator: 'fuzzy' })).status).toBe(400);
  expect((await api('put', `/api/admin/scoring-rules/${kept.body.id}`, { points: 25 })).status).toBe(200);
});
