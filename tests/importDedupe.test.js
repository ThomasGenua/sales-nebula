/**
 * Import de-duplicates whatever the case of the key.
 *
 * The lookup for records already there was an exact match, though the map
 * built from it compared in lower case, so a file with ADA@EXAMPLE.COM did
 * not find the ada@example.com already stored and created a second contact.
 */
const supertest = require('supertest');
const {
  setup, teardown, cleanDatabase, createTestRole, createTestUser, authHeader,
} = require('./setup');

let app, prisma, user;

const importContacts = (records, extra = {}) => supertest(app).post('/api/import/execute')
  .set(authHeader(user.token)).send({ module: 'contacts', records, skipDuplicates: true, ...extra });
const person = (email, over = {}) => ({ firstName: 'Ada', lastName: 'Lovelace', email, ...over });

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  const role = await createTestRole('Admin');
  user = await createTestUser({ email: 'importer@test.com', roleId: role.id });
});

describe('POST /api/import/execute, duplicates', () => {
  it('skips an address that is already there in another case', async () => {
    await prisma.contact.create({ data: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', ownerId: user.user.id } });

    const res = await importContacts([person('ADA@EXAMPLE.COM')]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 0, skipped: 1 });
    expect(await prisma.contact.count()).toBe(1);
  });

  it('finds a stored address that has capitals, from a file in lower case', async () => {
    await prisma.contact.create({ data: { firstName: 'Ada', lastName: 'Lovelace', email: 'Ada@Example.com', ownerId: user.user.id } });

    const res = await importContacts([person('ada@example.com')]);

    expect(res.body).toMatchObject({ created: 0, skipped: 1 });
    expect(await prisma.contact.count()).toBe(1);
  });

  it('counts two spellings of one address in the same file as one contact', async () => {
    const res = await importContacts([person('grace@example.com'), person('GRACE@example.com'), person(' grace@EXAMPLE.com ')]);

    expect(res.body).toMatchObject({ created: 1, skipped: 2 });
    expect(await prisma.contact.count()).toBe(1);
  });

  it('updates the existing record, whatever the case, when asked to', async () => {
    const existing = await prisma.contact.create({ data: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', title: 'Analyst', ownerId: user.user.id } });

    const res = await importContacts([person('Ada@Example.COM', { title: 'Engineer' })], { skipDuplicates: false, updateDuplicates: true });

    expect(res.body).toMatchObject({ created: 0, updated: 1 });
    expect((await prisma.contact.findUnique({ where: { id: existing.id } })).title).toBe('Engineer');
  });

  it('still creates a contact for an address that is not there', async () => {
    await prisma.contact.create({ data: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', ownerId: user.user.id } });

    const res = await importContacts([person('ADA@EXAMPLE.COM'), person('alan@example.com', { firstName: 'Alan', lastName: 'Turing' })]);

    expect(res.body).toMatchObject({ created: 1, skipped: 1 });
    expect(await prisma.contact.count()).toBe(2);
  });

  it('finds every duplicate in a file long enough to be looked up in several chunks', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => person(`person${i}@example.com`, { firstName: `P${i}` }));

    expect((await importContacts(rows)).body).toMatchObject({ created: 450, skipped: 0 });
    const again = await importContacts(rows.map(r => ({ ...r, email: r.email.toUpperCase() })));

    expect(again.body).toMatchObject({ created: 0, skipped: 450 });
    expect(await prisma.contact.count()).toBe(450);
  }, 60000);
});
