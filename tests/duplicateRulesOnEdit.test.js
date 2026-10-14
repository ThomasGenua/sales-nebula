/**
 * Duplicate rules on edits (services/recordWrites updateRecord).
 *
 * They ran on create only, so changing a contact's email to a colleague's
 * made the copy a blocking rule exists to stop. They run on an update that
 * changes a field a rule matches on; any other edit, including of a record
 * that already is a duplicate, goes through. A merge is how duplicates are
 * resolved, so the record merged away never counts against the survivor.
 */
const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestUser, createTestContact, createTestAccount, authHeader } = require('./setup');

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

describe('a merge is not refused by the duplicate it resolves', () => {
  // The survivor takes the other's values while the other is still there.
  test('keeping the duplicate contact\'s email', async () => {
    await rule('block');
    const keep = await contact('ada@example.com');
    const dupe = await contact('ada.lovelace@example.com');
    const res = await request(app).post(`/api/contacts/${keep.id}/merge`).set(authHeader(token))
      .send({ mergeId: dupe.id, fields: { email: 'ada.lovelace@example.com' } });
    expect(res.status).toBe(200);
    expect((await prisma.contact.findUnique({ where: { id: keep.id } })).email).toBe('ada.lovelace@example.com');
  });

  test('in the duplicate manager\'s merge', async () => {
    await rule('block');
    const keep = await contact('ada@example.com');
    const dupe = await contact('ada.lovelace@example.com');
    const res = await request(app).post('/api/duplicates/merge/contacts').set(authHeader(token))
      .send({ masterId: keep.id, mergeIds: [dupe.id], fieldOverrides: { email: 'ada.lovelace@example.com' } });
    expect(res.status).toBe(200);
    expect((await prisma.contact.findUnique({ where: { id: keep.id } })).email).toBe('ada.lovelace@example.com');
  });

  test('filling an account\'s blank phone from the one merged into it', async () => {
    await prisma.duplicateRule.create({
      data: { name: 'Same phone', module: 'accounts', active: true, action: 'block', matchFields: [{ field: 'phone', weight: 100 }], threshold: 80 },
    });
    const keep = await createTestAccount({ name: 'Acme', ownerId: user.id });
    const dupe = await createTestAccount({ name: 'ACME Inc', phone: '555-0100', ownerId: user.id });
    const res = await request(app).post(`/api/accounts/${keep.id}/merge`).set(authHeader(token)).send({ mergeFromId: dupe.id });
    expect(res.status).toBe(200);
    expect((await prisma.account.findUnique({ where: { id: keep.id } })).phone).toBe('555-0100');
  });

  test('while a third record with that email still blocks it', async () => {
    await rule('block');
    const keep = await contact('ada@example.com');
    const dupe = await contact('ada.lovelace@example.com');
    await contact('ada.lovelace@example.com');
    const res = await request(app).post(`/api/contacts/${keep.id}/merge`).set(authHeader(token))
      .send({ mergeId: dupe.id, fields: { email: 'ada.lovelace@example.com' } });
    expect(res.status).toBe(409);
    expect(await prisma.contact.count({ where: { id: dupe.id, deletedAt: null } })).toBe(1);
  });
});
