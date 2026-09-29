/**
 * One invoice per quote (POST /api/quotes/:id/create-invoice).
 *
 * Each click billed the whole quote again, and a double click (two requests at
 * once) got two invoices for it: nothing looked for one already there, and the
 * two requests could not see each other.
 */
const supertest = require('supertest');
const {
  setup, teardown, cleanDatabase, createTestRole, createTestUser, authHeader,
} = require('./setup');

let app, prisma, user;

async function makeQuote() {
  const res = await supertest(app).post('/api/quotes').set(authHeader(user.token))
    .send({ quoteNumber: 'Q-001', status: 'Draft', total: 500, tax: 50, discount: 0, validUntil: '2026-12-31' });
  expect(res.status).toBe(201);
  return res.body;
}
const convert = quote => supertest(app).post(`/api/quotes/${quote.id}/create-invoice`).set(authHeader(user.token)).send({});
const invoicesOf = quote => prisma.invoice.findMany({ where: { quoteId: quote.id, deletedAt: null } });

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  const role = await createTestRole('Admin');
  user = await createTestUser({ email: 'billing@test.com', roleId: role.id });
});

describe('create-invoice', () => {
  it('creates an invoice from the quote, carrying its amounts', async () => {
    const quote = await makeQuote();

    const res = await convert(quote);

    expect(res.status).toBe(201);
    expect(res.body.quoteId).toBe(quote.id);
    expect(res.body.total).toBe(quote.total);
    expect(await invoicesOf(quote)).toHaveLength(1);
  });

  it('refuses a second invoice for the same quote, and says which one exists', async () => {
    const quote = await makeQuote();
    const first = await convert(quote);

    const second = await convert(quote);

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('INVOICE_EXISTS');
    expect(second.body.invoiceId).toBe(first.body.id);
    expect(await invoicesOf(quote)).toHaveLength(1);
  });

  it('makes one invoice when the button is clicked twice at the same moment', async () => {
    const quote = await makeQuote();

    const responses = await Promise.all([convert(quote), convert(quote), convert(quote)]);

    expect(responses.filter(r => r.status === 201)).toHaveLength(1);
    expect(responses.filter(r => r.status === 409)).toHaveLength(2);
    expect(await invoicesOf(quote)).toHaveLength(1);
  });

  it('allows a new invoice once the first has been deleted', async () => {
    const quote = await makeQuote();
    const first = await convert(quote);
    await prisma.invoice.update({ where: { id: first.body.id }, data: { deletedAt: new Date() } });

    const again = await convert(quote);

    expect(again.status).toBe(201);
    expect(await invoicesOf(quote)).toHaveLength(1);
  });
});
