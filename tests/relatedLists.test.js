/**
 * A record page's related lists (an account's contacts, deals, cases, quotes
 * and invoices) come from each module's own list, filtered by the link column:
 * GET /api/contacts?accountId=<id>. The standard lists took such filters; the
 * quotes and invoices lists ignored them, so an account's quotes were all of
 * them.
 */
const request = require('supertest');
const {
  setup, teardown, cleanDatabase, createTestRole, createTestUser, createTestAccount, createTestContact, createTestDeal,
  createTestCase, authHeader,
} = require('./setup');

let app, prisma, admin;

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  admin = await createTestUser({ email: 'admin@related.test' });
});

const list = (path, token = admin.token) => request(app).get(path).set(authHeader(token));
const names = res => res.body.data.map(r => r.name || r.number || r.subject || r.firstName).sort();

/** Two accounts, each with its own deal, quote and invoice. */
async function twoAccounts() {
  const [acme, globex] = [await createTestAccount({ name: 'Acme' }), await createTestAccount({ name: 'Globex' })];
  const records = {};
  for (const [key, account] of [['acme', acme], ['globex', globex]]) {
    const deal = await createTestDeal(admin.user.id, { name: `${account.name} deal`, accountId: account.id });
    const quote = await prisma.quote.create({ data: { number: `QT-${key}`, name: `${account.name} quote`, accountId: account.id, dealId: deal.id } });
    const invoice = await prisma.invoice.create({ data: { number: `INV-${key}`, accountId: account.id, quoteId: quote.id } });
    records[key] = { account, deal, quote, invoice };
  }
  return records;
}

describe('quotes and invoices filter by their own columns', () => {
  test("an account's quotes and invoices are its own", async () => {
    const { acme } = await twoAccounts();

    const quotes = await list(`/api/quotes?accountId=${acme.account.id}`);
    expect(quotes.status).toBe(200);
    expect(names(quotes)).toEqual(['Acme quote']);
    expect(quotes.body.meta.total).toBe(1);

    const invoices = await list(`/api/invoices?accountId=${acme.account.id}`);
    expect(invoices.body.data.map(i => i.number)).toEqual(['INV-acme']);
    expect(invoices.body.meta.total).toBe(1);
  });

  test("a deal's quotes and a quote's invoices, the same way", async () => {
    const { globex } = await twoAccounts();

    expect(names(await list(`/api/quotes?dealId=${globex.deal.id}`))).toEqual(['Globex quote']);
    expect((await list(`/api/invoices?quoteId=${globex.quote.id}`)).body.data.map(i => i.number)).toEqual(['INV-globex']);
  });

  test('a key that is not one of their columns filters nothing, and reaches no related record', async () => {
    await twoAccounts();

    expect((await list('/api/quotes?nonsense=1')).body.meta.total).toBe(2);
    // A relation, as the CRUD lists refuse it: account[name] is not a column.
    expect((await list('/api/quotes?account[name]=Acme')).body.meta.total).toBe(2);
    expect((await list('/api/invoices?quote[number]=QT-acme')).body.meta.total).toBe(2);
  });

  test('a deleted quote stays out of a filtered list, whatever the filter says', async () => {
    const { acme } = await twoAccounts();
    await prisma.quote.update({ where: { id: acme.quote.id }, data: { deletedAt: new Date() } });

    expect((await list(`/api/quotes?accountId=${acme.account.id}`)).body.meta.total).toBe(0);
    expect((await list(`/api/quotes?accountId=${acme.account.id}&deletedAt[gte]=2000-01-01`)).body.meta.total).toBe(0);
  });

  test('still takes permission to read the module', async () => {
    const { acme } = await twoAccounts();
    const rep = await createTestUser({ email: 'rep@related.test', roleId: (await createTestRole('No Quotes', [{ module: 'accounts', level: 'read' }])).id });

    expect((await list(`/api/quotes?accountId=${acme.account.id}`, rep.token)).status).toBe(403);
    expect((await list(`/api/invoices?accountId=${acme.account.id}`, rep.token)).status).toBe(403);
  });
});

describe('the standard lists a record page reads', () => {
  test('a deleted record stays out of a filtered list, whatever the filter says', async () => {
    const account = await createTestAccount({ name: 'Acme' });
    const gone = await createTestContact({ firstName: 'Gone', accountId: account.id });
    await prisma.contact.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

    // Each of these listed the deleted contact, or (not=null) answered 500.
    for (const filter of ['deletedAt[gte]=2000-01-01', 'deletedAtFrom=2000-01-01', 'deletedAt[not]=null']) {
      const res = await list(`/api/contacts?accountId=${account.id}&${filter}`);
      expect([filter, res.status, res.body.meta.total]).toEqual([filter, 200, 0]);
    }
  });

  test("an account's contacts, deals and cases, and a deal's activities", async () => {
    const { acme, globex } = await twoAccounts();
    await createTestContact({ firstName: 'Ada', accountId: acme.account.id });
    await createTestContact({ firstName: 'Bo', accountId: globex.account.id });
    await createTestCase({ subject: 'Acme case', accountId: acme.account.id });
    await prisma.activity.create({ data: { type: 'Call', subject: 'Acme call', dealId: acme.deal.id } });
    await prisma.activity.create({ data: { type: 'Call', subject: 'Globex call', dealId: globex.deal.id } });

    const contacts = await list(`/api/contacts?accountId=${acme.account.id}&limit=50&sortBy=createdAt&sortDir=desc`);
    expect(contacts.status).toBe(200);
    expect(names(contacts)).toEqual(['Ada']);
    expect(contacts.body.meta.total).toBe(1);
    expect(names(await list(`/api/deals?accountId=${acme.account.id}`))).toEqual(['Acme deal']);
    expect(names(await list(`/api/cases?accountId=${acme.account.id}`))).toEqual(['Acme case']);
    expect(names(await list(`/api/activities?dealId=${acme.deal.id}`))).toEqual(['Acme call']);
  });
});
