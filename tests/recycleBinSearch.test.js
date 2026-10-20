/**
 * Searching the recycle bin (GET /api/recycle-bin?search=).
 *
 * The route read a search and ignored it, so the bin listed everything; an
 * entry's name lived only inside its JSON snapshot. An entry now keeps the
 * name it is listed by (services/recycleBin), and the bin is searched by any
 * part of it, in any case, or by the record's id.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestUser, authHeader } = require('./setup');
const { binName } = require('../src/services/recycleBin');

let app, prisma, token;

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  ({ token } = await createTestUser({ email: 'admin@test.com' }));
});

const api = (method, url, body) => request(app)[method](url).set(authHeader(token)).send(body);
async function deleted(module, data) {
  const created = await api('post', `/api/${module}`, data);
  expect(created.status).toBe(201);
  expect((await api('delete', `/api/${module}/${created.body.id}`)).status).toBe(200);
  return created.body;
}
const names = res => res.body.data.map(item => item.name).sort();

test('a deleted record is found by any part of its name, in any case, or by its id', async () => {
  const ada = await deleted('contacts', { firstName: 'Ada', lastName: 'Lovelace' });
  await deleted('contacts', { firstName: 'Grace', lastName: 'Hopper' });
  await deleted('accounts', { name: 'Lovelace Labs' });

  expect(names(await api('get', '/api/recycle-bin?search=LOVE'))).toEqual(['Ada Lovelace', 'Lovelace Labs']);
  expect(names(await api('get', '/api/recycle-bin?search=love&module=contacts'))).toEqual(['Ada Lovelace']);
  expect(names(await api('get', `/api/recycle-bin?search=${ada.id}`))).toEqual(['Ada Lovelace']);
  expect((await api('get', '/api/recycle-bin?search=nobody')).body).toMatchObject({ data: [], meta: { total: 0 } });
  expect((await api('get', '/api/recycle-bin')).body.meta.total).toBe(3);
});

test('entries from the other deletes are named too: an email, alone or in a mass delete', async () => {
  const single = await prisma.email.create({ data: { subject: 'Quarterly numbers', body: 'Attached.' } });
  const mass = await prisma.email.create({ data: { subject: 'Quarterly plan', body: 'Draft.' } });
  expect((await api('delete', `/api/emails/${single.id}`)).status).toBe(200);
  expect((await api('post', '/api/mass-actions/delete', { module: 'emails', recordIds: [mass.id] })).status).toBe(200);

  expect(names(await api('get', '/api/recycle-bin?search=quarterly'))).toEqual(['Quarterly numbers', 'Quarterly plan']);
});

test('the migration names the entries already in the bin as a delete names new ones', async () => {
  const snapshots = [
    ['contacts', { id: 'c1', firstName: ' Ada ', lastName: 'Lovelace', email: 'ada@example.com' }],
    ['leads', { id: 'l1', firstName: '', lastName: null, email: 'lead@example.com' }],
    ['accounts', { id: 'a1', name: 'Acme' }],
    ['cases', { id: 'k1', subject: '', caseNumber: 'CS-0042' }],
    ['invoices', { id: 'i1', number: 'INV-7', invoiceNumber: null }],
    ['emails', { id: 'e1', subject: null, to: 'to@example.com' }],
    ['activities', { id: 'x1' }],
  ];
  // As they were before the column: no name.
  for (const [module, data] of snapshots) {
    await prisma.recycleBinItem.create({ data: { module, recordId: data.id, recordData: data, deletedById: 'someone', expiresAt: new Date() } });
  }
  const sql = fs.readFileSync(path.join(__dirname, '../prisma/migrations/20261020100000_recycle_bin_item_name/migration.sql'), 'utf8');
  await prisma.$executeRawUnsafe(sql.slice(sql.indexOf('UPDATE')));

  const rows = await prisma.recycleBinItem.findMany();
  expect(rows.map(r => [r.module, r.name]).sort()).toEqual(snapshots.map(([module, data]) => [module, binName(module, data)]).sort());
  expect(rows.map(r => r.name).sort()).toEqual(['Acme', 'Ada Lovelace', 'CS-0042', 'INV-7', 'lead@example.com', 'to@example.com', null].sort());
});
