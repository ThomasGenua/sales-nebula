const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestUser, createTestProduct, authHeader } = require('./setup');
let app, user;
beforeAll(async () => { ({ app } = await setup()); });
afterAll(teardown);
beforeEach(async () => { await cleanDatabase(); user = await createTestUser(); });

test('explicitly empty quote lines determine the amount instead of a supplied stale total', async () => {
  const response = await request(app).post('/api/quotes').set(authHeader(user.token)).send({ name: 'Empty quote', items: [], total: 999 });
  expect(response.status).toBe(201);
  expect(response.body.total).toBe(0); expect(response.body.totalAmount).toBe(0);
});

test('removing the last quote line clears both totals and the persisted line', async () => {
  const product = await createTestProduct({ price: 100 });
  const created = await request(app).post('/api/quotes').set(authHeader(user.token)).send({ name: 'Line removal', items: [{ productId: product.id, quantity: 2, unitPrice: 100 }] });
  expect(created.status).toBe(201); expect(created.body.total).toBe(200);
  const updated = await request(app).put(`/api/quotes/${created.body.id}`).set(authHeader(user.token)).send({ items: [] });
  expect(updated.status).toBe(200); expect(updated.body.items).toHaveLength(0);
  expect(updated.body.subtotal).toBe(0); expect(updated.body.total).toBe(0); expect(updated.body.totalAmount).toBe(0);
});
