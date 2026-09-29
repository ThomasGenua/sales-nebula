/**
 * A record in the recycle bin is gone for editing and deleting.
 *
 * GET already answered 404 for one, but PUT saved an edit to it and DELETE
 * "deleted" it again, filing a second recycle bin entry whose restore then
 * failed because the row it named was already there.
 */
const supertest = require('supertest');
const {
  setup, teardown, cleanDatabase, createTestRole, createTestUser, createTestDeal, authHeader,
} = require('./setup');

let app, prisma, admin;

const send = (method, path, body) => {
  const req = supertest(app)[method](path).set(authHeader(admin.token));
  return body === undefined ? req : req.send(body);
};

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  const role = await createTestRole('Admin');
  admin = await createTestUser({ email: 'admin@test.com', roleId: role.id });
});

describe('a deleted record', () => {
  it('cannot be edited, and the edit is not saved', async () => {
    const deal = await createTestDeal(admin.user.id, { name: 'Gone' });
    expect((await send('delete', `/api/deals/${deal.id}`)).status).toBe(200);

    const res = await send('put', `/api/deals/${deal.id}`, { description: 'edit after delete' });

    expect(res.status).toBe(404);
    expect((await prisma.deal.findUnique({ where: { id: deal.id } })).description).toBeNull();
  });

  it('cannot be deleted a second time, and has one recycle bin entry', async () => {
    const deal = await createTestDeal(admin.user.id, { name: 'Gone twice' });

    expect((await send('delete', `/api/deals/${deal.id}`)).status).toBe(200);
    expect((await send('delete', `/api/deals/${deal.id}`)).status).toBe(404);

    expect(await prisma.recycleBinItem.count({ where: { recordId: deal.id } })).toBe(1);
  });

  it('can be restored from the bin, and edited again afterwards', async () => {
    const deal = await createTestDeal(admin.user.id, { name: 'Back again' });
    await send('delete', `/api/deals/${deal.id}`);
    const entry = await prisma.recycleBinItem.findFirst({ where: { recordId: deal.id } });

    expect((await send('post', `/api/recycle-bin/${entry.id}/restore`, {})).status).toBe(200);

    const res = await send('put', `/api/deals/${deal.id}`, { description: 'edited once restored' });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe('edited once restored');
  });

  it('leaves a live record editable and deletable, as before', async () => {
    const deal = await createTestDeal(admin.user.id, { name: 'Alive' });

    expect((await send('put', `/api/deals/${deal.id}`, { description: 'fine' })).status).toBe(200);
    expect((await send('delete', `/api/deals/${deal.id}`)).status).toBe(200);
  });
});
