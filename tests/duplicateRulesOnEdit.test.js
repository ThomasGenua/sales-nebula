/**
 * Duplicate rules on edits (services/recordWrites updateRecord).
 *
 * They ran on create only, so changing a contact's email to a colleague's
 * made the copy a blocking rule exists to stop. They run on an update that
 * changes a field a rule matches on; any other edit, including of a record
 * that already is a duplicate, goes through.
 */
const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestUser, createTestContact, authHeader } = require('./setup');

let app, prisma, user, token;

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  ({ user, token } = await createTestUser({ email: 'owner@test.com' }));
});

const rule = action => prisma.duplicateRule.create({
  data: { name: `Same email (${action})`, module: 'contacts', active: true, action, matchFields: [{ field: 'email', weight: 100 }], threshold: 80 },
});
const contact = email => createTestContact({ email, ownerId: user.id });
const edit = (id, body) => request(app).put(`/api/contacts/${id}`).set(authHeader(token)).send(body);

test('changing an email to another contact\'s is refused under a blocking rule', async () => {
  await rule('block');
  await contact('ada@example.com');
  const grace = await contact('grace@example.com');

  const res = await edit(grace.id, { email: 'ADA@example.com' });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('DUPLICATE_RECORD');
  expect((await prisma.contact.findUnique({ where: { id: grace.id } })).email).toBe('grace@example.com');
});

test('an edit that leaves the matched field alone goes through, even on a record that already is a duplicate', async () => {
  const first = await contact('shared@example.com');
  const second = await contact('shared@example.com');
  await rule('block');

  const res = await edit(second.id, { title: 'CTO', email: 'shared@example.com' });
  expect(res.status).toBe(200);
  expect(res.body.title).toBe('CTO');
  expect(first.id).not.toBe(second.id);
});

test('a warning rule lets the change through, says so, and queues the pair once', async () => {
  await rule('warn');
  const ada = await contact('ada@example.com');
  const grace = await contact('grace@example.com');

  const res = await edit(grace.id, { email: 'ada@example.com' });
  expect(res.status).toBe(200);
  expect(res.body.duplicates.map(d => d.recordId)).toEqual([ada.id]);
  expect(res.body.warnings[0]).toMatch(/Possible duplicate/);

  expect((await edit(grace.id, { email: 'Ada@example.com' })).status).toBe(200);
  expect(await prisma.duplicateRecord.count({ where: { module: 'contacts' } })).toBe(1);
});

test('without a rule matching the changed field, nothing is checked', async () => {
  await rule('block');
  await contact('ada@example.com');
  const grace = await contact('grace@example.com');
  const res = await edit(grace.id, { firstName: 'Grace', phone: '555-0100' });
  expect(res.status).toBe(200);
  expect(res.body).not.toHaveProperty('duplicates');
});
