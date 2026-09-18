const request = require('supertest');
const {
  setup, teardown, cleanDatabase,
  createTestUser, createTestDeal, createTestAccount, createTestContact, authHeader,
} = require('./setup');

let app, prisma, token, userId;

beforeAll(async () => {
  ({ prisma, app } = await setup());
});

afterAll(async () => {
  await teardown();
});

beforeEach(async () => {
  await cleanDatabase();
  const auth = await createTestUser();
  token = auth.token;
  userId = auth.user.id;
});

describe('GET /api/deals', () => {
  it('returns deal list with owner relation', async () => {
    await createTestDeal(userId, { name: 'Big Deal', value: 100000, stage: 'Proposal' });
    await createTestDeal(userId, { name: 'Small Deal', value: 5000, stage: 'Qualification' });

    const res = await request(app)
      .get('/api/deals')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toHaveProperty('owner');
  });

  it('filters by stage', async () => {
    await createTestDeal(userId, { name: 'Won', stage: 'Closed Won' });
    await createTestDeal(userId, { name: 'Open', stage: 'Qualification' });

    const res = await request(app)
      .get('/api/deals?stage=Closed Won')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Won');
  });
});

describe('POST /api/deals', () => {
  it('creates a deal with full data', async () => {
    const account = await createTestAccount();
    const contact = await createTestContact();

    const res = await request(app)
      .post('/api/deals')
      .set(authHeader(token))
      .send({
        name: 'Enterprise License',
        value: 250000,
        stage: 'Discovery',
        probability: 20,
        closeDate: '2026-06-30',
        ownerId: userId,
        accountId: account.id,
        contactId: contact.id,
        source: 'Referral',
        type: 'New Business',
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Enterprise License');
    expect(res.body.value).toBe(250000);
    expect(res.body.account.name).toBe(account.name);
  });
});

describe('PUT /api/deals/:id', () => {
  it('updates deal stage and value', async () => {
    const deal = await createTestDeal(userId, { name: 'Progressing', stage: 'Qualification', value: 50000 });

    const res = await request(app)
      .put(`/api/deals/${deal.id}`)
      .set(authHeader(token))
      .send({ stage: 'Proposal', value: 75000, probability: 60 });

    expect(res.status).toBe(200);
    expect(res.body.stage).toBe('Proposal');
    expect(res.body.value).toBe(75000);
    expect(res.body.probability).toBe(60);
  });
});

describe('GET /api/deals/stats/pipeline', () => {
  it('returns pipeline statistics', async () => {
    await createTestDeal(userId, { stage: 'Qualification', value: 50000 });
    await createTestDeal(userId, { stage: 'Qualification', value: 30000 });
    await createTestDeal(userId, { stage: 'Proposal', value: 100000 });
    await createTestDeal(userId, { stage: 'Closed Won', value: 75000 });

    const res = await request(app)
      .get('/api/deals/stats/pipeline')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    // Pipeline stats should aggregate deal values by stage
  });
});

describe('GET /api/deals/:id/timeline', () => {
  it('returns deal timeline', async () => {
    const deal = await createTestDeal(userId);

    const res = await request(app)
      .get(`/api/deals/${deal.id}/timeline`)
      .set(authHeader(token));

    expect(res.status).toBe(200);
    // Should include activities and other related records
  });
});

describe('Deal lifecycle', () => {
  it('can progress a deal through stages', async () => {
    const deal = await createTestDeal(userId, { stage: 'Qualification', value: 100000 });

    // Move to Proposal
    let res = await request(app)
      .put(`/api/deals/${deal.id}`)
      .set(authHeader(token))
      .send({ stage: 'Proposal', probability: 50 });
    expect(res.body.stage).toBe('Proposal');

    // Move to Negotiation
    res = await request(app)
      .put(`/api/deals/${deal.id}`)
      .set(authHeader(token))
      .send({ stage: 'Negotiation', probability: 80 });
    expect(res.body.stage).toBe('Negotiation');

    // Close Won
    res = await request(app)
      .put(`/api/deals/${deal.id}`)
      .set(authHeader(token))
      .send({ stage: 'Closed Won', probability: 100 });
    expect(res.body.stage).toBe('Closed Won');
    expect(res.body.probability).toBe(100);
  });
});

describe('DELETE /api/deals/:id', () => {
  // Deal was the only core entity without a deletedAt column, so it was hard
  // deleted while every sibling was retained. Now it retires like the rest.
  it('retires the deal instead of destroying it, and hides it from the list', async () => {
    const deal = await createTestDeal(userId, { name: 'Withdrawn' });

    await request(app).delete(`/api/deals/${deal.id}`).set(authHeader(token)).expect(200);

    const row = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(row).not.toBeNull();
    expect(row.deletedAt).not.toBeNull();

    const list = await request(app).get('/api/deals').set(authHeader(token)).expect(200);
    expect(list.body.data.map(d => d.id)).not.toContain(deal.id);
  });

  it('will not fetch a deal that has been retired', async () => {
    const deal = await createTestDeal(userId);
    await request(app).delete(`/api/deals/${deal.id}`).set(authHeader(token)).expect(200);
    await request(app).get(`/api/deals/${deal.id}`).set(authHeader(token)).expect(404);
  });
});
