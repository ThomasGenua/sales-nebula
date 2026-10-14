/**
 * API events (services/eventLog), which /api/monitoring counts and searches.
 *
 * Nothing wrote EventLog, so the call and error counts were always 0 and the
 * event search was always empty. Each request under /api is a row now,
 * written in batches. A row keeps the route, never a token from the path or
 * the query string.
 */
const express = require('express');
const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestUser, createTestContact, authHeader } = require('./setup');
const { createApp } = require('../src/app');
const { createEventLog } = require('../src/services/eventLog');
const { setDatabaseClient, handlers } = require('../src/jobs/scheduler');

let prisma, app, events, admin, token;

beforeAll(async () => {
  ({ prisma } = await setup());
  app = createApp(prisma, { eventLog: true });
  events = app.locals.eventLog;
  setDatabaseClient(prisma);
});
afterAll(async () => { await events.flush(); await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  await prisma.eventLog.deleteMany();
  ({ user: admin, token } = await createTestUser({ email: 'admin@test.com' }));
});

const row = r => [r.eventType, r.method, r.uri, r.statusCode, r.userId, r.module, r.recordId];

test('each API request is a row: who, which route, how it ended and how long it took', async () => {
  const contact = await createTestContact({ firstName: 'Ada', lastName: 'Lovelace', ownerId: admin.id });
  expect((await request(app).get(`/api/contacts/${contact.id}`).set(authHeader(token))).status).toBe(200);
  expect((await request(app).get('/api/contacts?search=lovelace').set(authHeader(token))).status).toBe(200);
  expect((await request(app).get('/api/contacts')).status).toBe(401);
  await events.flush();

  const rows = await prisma.eventLog.findMany();
  expect(rows.map(row)).toHaveLength(3);
  expect(rows.map(row)).toEqual(expect.arrayContaining([
    ['API', 'GET', '/api/contacts/:id', 200, admin.id, 'contacts', contact.id],
    ['API', 'GET', '/api/contacts', 200, admin.id, 'contacts', null],
    ['API', 'GET', '/api/contacts', 401, null, 'contacts', null],
  ]));
  expect(rows.every(r => Number.isInteger(r.responseTime) && r.responseTime >= 0)).toBe(true);
  expect(JSON.stringify(rows)).not.toContain('lovelace');
});

test('a token in the path is never kept, even when the route fails', async () => {
  // A calendar feed's own route, with a feed token in the path.
  await request(app).get('/api/calendar/feed/feedSECRET1.ics');

  // A route that fails is answered by the app's error handler, outside its router.
  const mini = express();
  const log = createEventLog(prisma);
  mini.use('/api', log.middleware);
  const router = express.Router();
  router.get('/share/:token', (req, res, next) => next(new Error('boom')));
  mini.use('/api/things', router);
  mini.use((err, req, res, next) => res.status(500).json({ error: 'failed' }));
  expect((await request(mini).get('/api/things/share/shareSECRET2')).status).toBe(500);
  expect((await request(mini).get('/api/things/unrouted/pathSECRET3')).status).toBe(404);
  await Promise.all([events.flush(), log.flush()]);

  const rows = await prisma.eventLog.findMany();
  expect(rows.map(r => r.uri).sort()).toEqual(['/api/calendar/feed/:token.ics', '/api/things', '/api/things/share/:token']);
  expect(JSON.stringify(rows)).not.toMatch(/SECRET/);
});

test('monitoring counts the last hour\'s calls and server errors, and finds the events', async () => {
  const mini = express();
  const log = createEventLog(prisma);
  mini.use('/api', log.middleware);
  mini.get('/api/fails', () => { throw new Error('boom'); });
  mini.use((err, req, res, next) => res.status(500).json({ error: 'failed' }));
  await request(mini).get('/api/fails');
  await request(app).get('/api/contacts').set(authHeader(token));
  await request(app).get('/api/contacts').set(authHeader(token));
  await Promise.all([events.flush(), log.flush()]);

  const metrics = await request(app).get('/api/monitoring/metrics').set(authHeader(token));
  expect(metrics.body.api).toEqual({ callsLastHour: 3, errorsLastHour: 1 });
  const found = await request(app).get('/api/monitoring/event-logs?module=contacts').set(authHeader(token));
  expect(found.body.total).toBe(2);
});

test('a request is answered even when its row cannot be written, and rows go in one batch', async () => {
  const createMany = jest.fn().mockRejectedValue(new Error('database down'));
  const log = createEventLog({ eventLog: { createMany } });
  const mini = express();
  mini.use('/api', log.middleware);
  mini.get('/api/ping', (req, res) => res.json({ ok: true }));

  expect((await request(mini).get('/api/ping')).status).toBe(200);
  expect((await request(mini).get('/api/ping')).status).toBe(200);
  await expect(log.flush()).resolves.toBeUndefined();
  expect(createMany).toHaveBeenCalledTimes(1);
  expect(createMany.mock.calls[0][0].data).toHaveLength(2);
});

test('the cleanup job deletes events older than 30 days', async () => {
  const daysAgo = days => new Date(Date.now() - days * 86400000);
  await prisma.eventLog.createMany({ data: [
    { eventType: 'API', timestamp: daysAgo(31), uri: '/api/old' },
    { eventType: 'API', timestamp: daysAgo(29), uri: '/api/recent' },
  ] });
  expect(await handlers.cleanupEventLogs()).toEqual({ deleted: 1 });
  expect((await prisma.eventLog.findMany()).map(r => r.uri)).toEqual(['/api/recent']);
});
