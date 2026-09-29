/**
 * Leases (utils/lease): one holder at a time, across callers and processes.
 *
 * They stand in for a unique constraint the schema does not have where the app
 * checks "is there one already?" and then creates one, so that two callers at
 * the same moment cannot both pass the check.
 */
const supertest = require('supertest');
const {
  setup, teardown, cleanDatabase, createTestRole, createTestUser, authHeader,
} = require('./setup');
const { acquireLease, releaseLease, withLease } = require('../src/utils/lease');

let app, prisma, admin;

const expiredLease = JSON.stringify({ token: 'old-holder', expiresAt: Date.now() - 1000 });
const anyToken = expect.stringMatching(/^[0-9a-f-]{36}$/);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  const role = await createTestRole('Admin');
  admin = await createTestUser({ email: 'admin@test.com', roleId: role.id });
});

describe('acquireLease', () => {
  it('is held by one caller at a time, per name', async () => {
    expect(await acquireLease(prisma, 'job:x', 60000)).toEqual(anyToken);
    expect(await acquireLease(prisma, 'job:x', 60000)).toBeNull();
    expect(await acquireLease(prisma, 'job:y', 60000)).toEqual(anyToken);
  });

  it('goes to exactly one of several callers at the same moment', async () => {
    const tokens = await Promise.all(Array.from({ length: 8 }, () => acquireLease(prisma, 'race', 60000)));
    expect(tokens.filter(Boolean)).toHaveLength(1);
  });

  it('is not taken over before it expires', async () => {
    await prisma.adminConfig.create({ data: { key: 'lease:live', value: JSON.stringify({ token: 'holder', expiresAt: Date.now() + 60000 }) } });
    expect(await acquireLease(prisma, 'live', 60000)).toBeNull();
  });

  it('can be taken over once it has expired, by exactly one of several callers', async () => {
    await prisma.adminConfig.create({ data: { key: 'lease:stale', value: expiredLease } });
    const tokens = await Promise.all(Array.from({ length: 6 }, () => acquireLease(prisma, 'stale', 60000)));
    expect(tokens.filter(Boolean)).toHaveLength(1);
    expect(await acquireLease(prisma, 'stale', 60000)).toBeNull(); // and it is held again
  });

  it('treats a row it cannot read as expired, rather than blocking for ever', async () => {
    await prisma.adminConfig.create({ data: { key: 'lease:garbled', value: 'not json' } });
    expect(await acquireLease(prisma, 'garbled', 60000)).toEqual(anyToken);
  });
});

describe('releaseLease', () => {
  it('frees the lease for the next caller', async () => {
    const token = await acquireLease(prisma, 'job:x', 60000);
    await releaseLease(prisma, 'job:x', token);
    expect(await acquireLease(prisma, 'job:x', 60000)).toEqual(anyToken);
  });

  it('leaves it alone when the caller is not the holder, as after its own lease expired and was taken over', async () => {
    const token = await acquireLease(prisma, 'job:x', 60000);
    await releaseLease(prisma, 'job:x', 'somebody-else');
    expect(await acquireLease(prisma, 'job:x', 60000)).toBeNull();
    await releaseLease(prisma, 'job:x', token);
    expect(await acquireLease(prisma, 'job:x', 60000)).toEqual(anyToken);
  });

  it('does nothing for a lease that is not there', async () => {
    await expect(releaseLease(prisma, 'never-taken', 'token')).resolves.toBeUndefined();
  });
});

describe('withLease', () => {
  it('runs the work once when several ask at the same moment, and lets go afterwards', async () => {
    let runs = 0;
    const work = async () => { runs++; await sleep(200); return 'done'; };

    const results = await Promise.all(Array.from({ length: 6 }, () => withLease(prisma, 'work', 60000, work)));

    expect(runs).toBe(1);
    expect(results.filter(r => r.acquired)).toEqual([{ acquired: true, value: 'done' }]);
    expect(results.filter(r => !r.acquired)).toHaveLength(5);
    expect(await acquireLease(prisma, 'work', 60000)).toEqual(anyToken);
  });

  it('lets go when the work throws, and passes the error on', async () => {
    await expect(withLease(prisma, 'boom', 60000, async () => { throw new Error('the work failed'); })).rejects.toThrow('the work failed');
    expect(await acquireLease(prisma, 'boom', 60000)).toEqual(anyToken);
  });
});

describe('the admin config routes', () => {
  it('do not list leases, and refuse to set one', async () => {
    await acquireLease(prisma, 'job:x', 60000);
    await prisma.adminConfig.create({ data: { key: 'company_name', value: 'Acme' } });

    const list = await supertest(app).get('/api/admin/config').set(authHeader(admin.token));
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ company_name: 'Acme' });

    const put = await supertest(app).put('/api/admin/config').set(authHeader(admin.token)).send({ 'lease:job:x': 'taken' });
    expect(put.status).toBe(400);
    expect(put.body.error).toMatch(/belong to the application/);
  });
});
