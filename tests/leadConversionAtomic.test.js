const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestUser, createTestLead, authHeader } = require('./setup');
let prisma, app, token;
beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(teardown);
beforeEach(async () => { await cleanDatabase(); ({ token } = await createTestUser()); });
const convert = (lead, data) => request(app).post(`/api/leads/${lead.id}/convert`).set(authHeader(token)).send(data);
test('concurrent conversions produce one contact, account and deal', async () => {
  const lead = await createTestLead();
  const results = await Promise.all([convert(lead, { createAccount: true, createDeal: true }), convert(lead, { createAccount: true, createDeal: true })]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect(await prisma.contact.count()).toBe(1); expect(await prisma.account.count()).toBe(1); expect(await prisma.deal.count()).toBe(1);
});
test('a late failure rolls back the claim and every created record', async () => {
  const lead = await createTestLead();
  const result = await convert(lead, { createAccount: true, createDeal: true, dealCurrency: 'NO-SUCH-CURRENCY' });
  expect(result.status).toBe(400);
  expect(await prisma.contact.count()).toBe(0); expect(await prisma.account.count()).toBe(0); expect(await prisma.deal.count()).toBe(0);
  expect((await prisma.lead.findUnique({ where: { id: lead.id } })).convertedAt).toBeNull();
});
test('the deal keeps a zero value and the chosen close date', async () => {
  const lead = await createTestLead({ value: 25000 });
  const result = await convert(lead, { createDeal: true, dealValue: 0, dealCloseDate: '2027-01-15' });
  expect(result.status).toBe(200); expect(result.body.deal.value).toBe(0); expect(result.body.deal.closeDate).toBe('2027-01-15T00:00:00.000Z');
});
