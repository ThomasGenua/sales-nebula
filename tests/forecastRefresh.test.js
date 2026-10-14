/**
 * The job that refreshes open forecasts (jobs/scheduler recalcForecasts).
 *
 * It refreshed only the deals a forecast began with, so a deal that moved into
 * the period afterwards, or was opened in it, never counted. It now adds the
 * owner's open deals in the period that the forecast does not list yet.
 */
const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestUser, createTestDeal, authHeader } = require('./setup');
const { setDatabaseClient, handlers } = require('../src/jobs/scheduler');

let app, prisma, rep, token;
const START = '2031-01-01T00:00:00.000Z';
const END = '2031-03-31T23:59:59.999Z';
const IN_PERIOD = new Date('2031-02-15T00:00:00.000Z');
const LATER = new Date('2031-05-15T00:00:00.000Z');

beforeAll(async () => { ({ prisma, app } = await setup()); setDatabaseClient(prisma); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  ({ user: rep, token } = await createTestUser({ email: 'rep@test.com' }));
});

const deal = (overrides) => createTestDeal(rep.id, { stage: 'Proposal', probability: 50, value: 1000, closeDate: IN_PERIOD, ...overrides });

async function forecast() {
  const res = await request(app).post('/api/forecasts').set(authHeader(token)).send({ period: 'Q1-2031', periodStart: START, periodEnd: END });
  expect(res.status).toBe(201);
  return res.body;
}
const itemsOf = id => prisma.forecastItem.findMany({ where: { forecastId: id }, orderBy: { createdAt: 'asc' } });

test('a deal that moves into the period after the forecast is made is added on refresh', async () => {
  const first = await deal({ name: 'First' });
  const slipped = await deal({ name: 'Slipped in', closeDate: LATER, value: 4000, probability: 95 });
  const f = await forecast();
  expect((await itemsOf(f.id)).map(i => i.dealId)).toEqual([first.id]);

  await prisma.deal.update({ where: { id: slipped.id }, data: { closeDate: IN_PERIOD } });
  await handlers.recalcForecasts();

  const items = await itemsOf(f.id);
  expect(items.map(i => i.dealId).sort()).toEqual([first.id, slipped.id].sort());
  expect(items.find(i => i.dealId === slipped.id)).toMatchObject({ category: 'Commit', amount: 4000, probability: 95 });
  const refreshed = await prisma.forecast.findUnique({ where: { id: f.id } });
  expect(refreshed.pipeline).toBe(5000);
  expect(refreshed.commit).toBe(4000);
});

test('a refresh adds a deal once, and only the owner\'s open deals in the period', async () => {
  await deal({ name: 'Listed' });
  const f = await forecast();
  const { user: colleague } = await createTestUser({ email: 'colleague@test.com' });
  await createTestDeal(colleague.id, { stage: 'Proposal', probability: 50, value: 700, closeDate: IN_PERIOD });
  await deal({ name: 'Won since', stage: 'Closed Won', probability: 100 });
  await deal({ name: 'Next quarter', closeDate: LATER });
  const opened = await deal({ name: 'Opened since' });

  await handlers.recalcForecasts();
  await handlers.recalcForecasts();

  const items = await itemsOf(f.id);
  expect(items).toHaveLength(2);
  expect(items.filter(i => i.dealId === opened.id)).toHaveLength(1);
});

test('a closed forecast is left as it is', async () => {
  const f = await forecast();
  await prisma.forecast.update({ where: { id: f.id }, data: { status: 'Approved' } });
  await deal({ name: 'Too late' });
  await handlers.recalcForecasts();
  expect(await itemsOf(f.id)).toHaveLength(0);
});
