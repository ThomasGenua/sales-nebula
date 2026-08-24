const request = require('supertest');
const {
  setup, teardown, cleanDatabase,
  createTestUser, createTestLead, authHeader,
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

describe('Lead CRUD', () => {
  it('creates a lead', async () => {
    const res = await request(app)
      .post('/api/leads')
      .set(authHeader(token))
      .send({
        firstName: 'Prospect',
        lastName: 'Lead',
        email: 'prospect@test.com',
        company: 'Future Customer',
        status: 'New',
        source: 'Web',
      });

    expect(res.status).toBe(201);
    expect(res.body.firstName).toBe('Prospect');
    expect(res.body.company).toBe('Future Customer');
  });

  it('lists leads with search', async () => {
    await createTestLead({ firstName: 'Hot', lastName: 'Lead', company: 'Target' });
    await createTestLead({ firstName: 'Cold', lastName: 'Lead', company: 'Maybe' });

    const res = await request(app)
      .get('/api/leads?search=hot')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].firstName).toBe('Hot');
  });

  it('updates lead status', async () => {
    const lead = await createTestLead({ status: 'New' });

    const res = await request(app)
      .put(`/api/leads/${lead.id}`)
      .set(authHeader(token))
      .send({ status: 'Contacted', score: 75 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Contacted');
    expect(res.body.score).toBe(75);
  });
});

describe('POST /api/leads/:id/convert', () => {
  it('converts a lead to contact and creates account/deal', async () => {
    const lead = await createTestLead({
      firstName: 'Convert',
      lastName: 'Me',
      email: 'convert@test.com',
      company: 'New Account Corp',
    });

    const res = await request(app)
      .post(`/api/leads/${lead.id}/convert`)
      .set(authHeader(token))
      .send({
        createAccount: true,
        createDeal: true,
        dealName: 'Conversion Deal',
        dealValue: 50000,
      });

    expect(res.status).toBe(200);
    expect(res.body.contact).toBeDefined();
    expect(res.body.contact.firstName).toBe('Convert');
    expect(res.body.contact.email).toBe('convert@test.com');

    if (res.body.account) {
      expect(res.body.account.name).toBe('New Account Corp');
    }

    // Lead should be marked as converted
    const updatedLead = await prisma.lead.findUnique({ where: { id: lead.id } });
    expect(updatedLead.status).toBe('Converted');
  });
});

describe('POST /api/leads/import-csv', () => {
  it('bulk imports leads', async () => {
    const res = await request(app)
      .post('/api/leads/import-csv')
      .set(authHeader(token))
      .send({
        records: [
          { firstName: 'I1', lastName: 'L', company: 'Co1', email: 'i1@t.com' },
          { firstName: 'I2', lastName: 'L', company: 'Co2', email: 'i2@t.com' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(2);
  });
});
