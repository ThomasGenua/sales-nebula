/**
 * Org-wide sharing defaults, and who can reach whose records.
 *
 * OrgWideDefault was configurable in the admin UI, stored, and seeded with
 * `deals: Private` — and read by nothing outside its own settings endpoint. A
 * module set to Private behaved exactly like one set to ReadWrite, so any rep
 * could read and edit any other rep's deals. Separately, records created
 * through the API carried no owner at all, so even a working ownership check
 * would have had nothing to match on.
 */

const request = require('supertest');
const {
  setup, teardown, cleanDatabase,
  createTestRole, createTestUser, authHeader,
} = require('./setup');
const { invalidateOrgWideDefaultCache } = require('../src/middleware/rowSecurity');

let app, prisma, repA, repB, admin;

const deal = (over = {}) => ({ name: 'Renewal', value: 5000, stage: 'Prospecting', closeDate: new Date(), ...over });

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });

beforeEach(async () => {
  await cleanDatabase();
  invalidateOrgWideDefaultCache();
  const repRole = await createTestRole('Sales Rep', [
    { module: 'deals', level: 'full' },
    { module: 'leads', level: 'full' },
  ]);
  const adminRole = await createTestRole('Admin');
  repA = await createTestUser({ email: 'rep-a@test.com', roleId: repRole.id });
  repB = await createTestUser({ email: 'rep-b@test.com', roleId: repRole.id });
  admin = await createTestUser({ email: 'sharing-admin@test.com', roleId: adminRole.id });
});

const setOwd = async (module, internalAccess) => {
  await prisma.orgWideDefault.create({ data: { module, internalAccess, externalAccess: 'Private' } });
  invalidateOrgWideDefaultCache();
};

describe('Record ownership', () => {
  it('records the creator as owner, so there is something to match on', async () => {
    const res = await request(app).post('/api/deals').set(authHeader(repA.token)).send(deal());
    expect(res.status).toBe(201);
    expect(res.body.ownerId).toBe(repA.user.id);
  });

  it('leaves an explicitly named owner alone', async () => {
    const res = await request(app).post('/api/deals').set(authHeader(repA.token))
      .send(deal({ ownerId: repB.user.id }));
    expect(res.status).toBe(201);
    expect(res.body.ownerId).toBe(repB.user.id);
  });
});

describe('Org-wide default: Private', () => {
  let owned;

  beforeEach(async () => {
    await setOwd('deals', 'Private');
    const res = await request(app).post('/api/deals').set(authHeader(repA.token)).send(deal({ name: 'A private deal' }));
    expect(res.status).toBe(201);
    owned = res.body;
  });

  it('lets the owner read their own record', async () => {
    const res = await request(app).get(`/api/deals/${owned.id}`).set(authHeader(repA.token));
    expect(res.status).toBe(200);
  });

  it('refuses another rep reading it', async () => {
    const res = await request(app).get(`/api/deals/${owned.id}`).set(authHeader(repB.token));
    expect([403, 404]).toContain(res.status);
  });

  it('refuses another rep editing it', async () => {
    const res = await request(app).put(`/api/deals/${owned.id}`).set(authHeader(repB.token)).send({ value: 999999 });
    expect([403, 404]).toContain(res.status);
    const after = await prisma.deal.findUnique({ where: { id: owned.id } });
    expect(after.value).toBe(5000);
  });

  it('refuses another rep deleting it', async () => {
    const res = await request(app).delete(`/api/deals/${owned.id}`).set(authHeader(repB.token));
    expect([403, 404]).toContain(res.status);
    const after = await prisma.deal.findUnique({ where: { id: owned.id } });
    expect(after.deletedAt).toBeNull();
  });

  it('keeps it out of another rep\'s list', async () => {
    const res = await request(app).get('/api/deals').set(authHeader(repB.token));
    expect(res.status).toBe(200);
    expect(res.body.data.map(d => d.id)).not.toContain(owned.id);
  });

  it('still lets an administrator through', async () => {
    const res = await request(app).get(`/api/deals/${owned.id}`).set(authHeader(admin.token));
    expect(res.status).toBe(200);
  });
});

describe('Org-wide default: ReadOnly', () => {
  it('lets another rep read but not write', async () => {
    await setOwd('deals', 'ReadOnly');
    const created = await request(app).post('/api/deals').set(authHeader(repA.token)).send(deal());
    expect(created.status).toBe(201);

    const read = await request(app).get(`/api/deals/${created.body.id}`).set(authHeader(repB.token));
    expect(read.status).toBe(200);

    const write = await request(app).put(`/api/deals/${created.body.id}`).set(authHeader(repB.token)).send({ value: 1 });
    expect([403, 404]).toContain(write.status);
  });
});

describe('Org-wide default: ReadWrite, or none at all', () => {
  it('leaves the module open when set to ReadWrite', async () => {
    await setOwd('deals', 'ReadWrite');
    const created = await request(app).post('/api/deals').set(authHeader(repA.token)).send(deal());
    const res = await request(app).get(`/api/deals/${created.body.id}`).set(authHeader(repB.token));
    expect(res.status).toBe(200);
  });

  it('leaves the module open when nothing is configured', async () => {
    const created = await request(app).post('/api/deals').set(authHeader(repA.token)).send(deal());
    const res = await request(app).get(`/api/deals/${created.body.id}`).set(authHeader(repB.token));
    expect(res.status).toBe(200);
  });

  it('does not let one module\'s setting restrict another', async () => {
    await setOwd('deals', 'Private');
    const lead = await request(app).post('/api/leads').set(authHeader(repA.token))
      .send({ firstName: 'Open', lastName: 'Lead', company: 'Acme', email: `open${Date.now()}@x.com` });
    expect(lead.status).toBe(201);
    const res = await request(app).get(`/api/leads/${lead.body.id}`).set(authHeader(repB.token));
    expect(res.status).toBe(200);
  });
});
