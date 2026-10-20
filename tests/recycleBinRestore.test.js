/**
 * Restoring from the recycle bin whatever a delete filed in it.
 *
 * Every module whose writes go through services/recordWrites files a bin
 * entry when a record is deleted, but the bin restored from a list of 15. A
 * deleted asset, work order, partner, person account, subscription, project
 * or prospect went into the bin, and Restore answered "Cannot restore module".
 */
const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestUser, createTestAccount, authHeader } = require('./setup');
const { deleteRecord } = require('../src/services/recordWrites');

let app, prisma, user, token;

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  ({ user, token } = await createTestUser({ email: 'admin@test.com' }));
});

const api = (method, url, body) => request(app)[method](url).set(authHeader(token)).send(body);
const DAY = 86400000;

test('a deleted record of each of those modules comes back out of the bin', async () => {
  const account = await createTestAccount();
  const kinds = [
    ['assets', 'asset', { name: 'Kiln' }],
    ['fieldService', 'workOrder', { workOrderNumber: 'WO-1', subject: 'Repair the kiln' }],
    ['partners', 'partner', { name: 'Partner Co' }],
    ['personAccounts', 'personAccount', { firstName: 'Ada', lastName: 'Lovelace' }],
    ['subscriptions', 'subscription', { subscriptionNumber: 'SUB-1', accountId: account.id, startDate: new Date(), endDate: new Date(Date.now() + 365 * DAY), unitPrice: 10, totalPrice: 120 }],
    ['projects', 'project', { name: 'Kiln install' }],
    ['prospects', 'prospect', { lastName: 'Prospect' }],
  ];
  for (const [module, model, data] of kinds) {
    const record = await prisma[model].create({ data });
    await deleteRecord(prisma, module, record, { userId: user.id });
    const entry = await prisma.recycleBinItem.findFirst({ where: { module, recordId: record.id } });
    expect(entry).not.toBeNull();

    const res = await api('post', `/api/recycle-bin/${entry.id}/restore`);
    expect([module, res.status, res.body.error]).toEqual([module, 200, undefined]);
    const back = await prisma[model].findUnique({ where: { id: record.id } });
    expect(back).not.toBeNull();
    if ('deletedAt' in back) expect(back.deletedAt).toBeNull();
    expect(await prisma.recycleBinItem.count({ where: { id: entry.id } })).toBe(0);
  }
});

test('bulk restore puts back a module kept in its table, and says how to restore one that is not', async () => {
  const asset = await prisma.asset.create({ data: { name: 'Kiln' } });
  await deleteRecord(prisma, 'assets', asset, { userId: user.id });
  const bulk = await api('post', '/api/recycle-bin/restore/bulk', { module: 'assets', ids: [asset.id] });
  expect(bulk.body).toEqual({ restored: 1 });
  expect((await prisma.asset.findUnique({ where: { id: asset.id } })).deletedAt).toBeNull();

  // Work orders are deleted outright: their rows are rebuilt from the bin, one entry at a time.
  const order = await prisma.workOrder.create({ data: { workOrderNumber: 'WO-2', subject: 'Service call' } });
  await deleteRecord(prisma, 'fieldService', order, { userId: user.id });
  const refused = await api('post', '/api/recycle-bin/restore/bulk', { module: 'fieldService', ids: [order.id] });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toMatch(/restore each from its recycle bin entry/);
});
