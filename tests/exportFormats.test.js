/**
 * The formats POST /api/export can produce: CSV and JSON. Any other format
 * came back as JSON labelled with the format asked for, so an "xlsx" export
 * was JSON. It is refused now, as /api/data-export refuses it.
 */
const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestUser, createTestContact, authHeader } = require('./setup');

let app, token;

beforeAll(async () => { ({ app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  let user;
  ({ user, token } = await createTestUser({ email: 'exporter@test.com' }));
  await createTestContact({ firstName: 'Ada', lastName: 'Lovelace', ownerId: user.id });
});

const exportAs = format => request(app).post('/api/export').set(authHeader(token)).send({ module: 'contacts', format });

test('csv and json export the records', async () => {
  const csv = await exportAs('csv');
  expect(csv.status).toBe(200);
  expect(csv.headers['content-type']).toMatch(/text\/csv/);
  expect(csv.text).toContain('Lovelace');

  const json = await exportAs('json');
  expect(json.status).toBe(200);
  expect(json.body).toMatchObject({ module: 'contacts', format: 'json', count: 1 });
});

test('an Excel export is refused, not answered with JSON', async () => {
  const res = await exportAs('xlsx');
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/csv or json/);
});
