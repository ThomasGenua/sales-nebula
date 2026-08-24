const request = require('supertest');
const {
  setup, teardown, cleanDatabase,
  createTestUser, createTestAccount, createTestContact,
  createTestDeal, createTestLead, createTestProduct,
  authHeader,
} = require('./setup');

let app, prisma, token, userId;

beforeAll(async () => {
  ({ app, prisma } = await setup());
});

afterAll(async () => { await teardown(); });

beforeEach(async () => {
  await cleanDatabase();
  const { user, token: t } = await createTestUser();
  token = t;
  userId = user.id;
});

// ─── TAGS ───

describe('Tags', () => {
  it('creates and lists tags', async () => {
    const createRes = await request(app)
      .post('/api/tags')
      .set(authHeader(token))
      .send({ name: 'Hot Lead', color: '#ef4444' });

    expect(createRes.status).toBe(201);
    expect(createRes.body.name).toBe('Hot Lead');

    const listRes = await request(app)
      .get('/api/tags')
      .set(authHeader(token));

    expect(listRes.status).toBe(200);
    expect(listRes.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('assigns and retrieves tags for a record', async () => {
    const tag = await prisma.tag.create({ data: { name: 'VIP', color: '#f59e0b' } });
    const contact = await createTestContact();

    // Assign
    const assignRes = await request(app)
      .post('/api/tags/assign')
      .set(authHeader(token))
      .send({ tagId: tag.id, module: 'contacts', recordId: contact.id });

    expect(assignRes.status).toBe(201);

    // Retrieve
    const getRes = await request(app)
      .get(`/api/tags/record/contacts/${contact.id}`)
      .set(authHeader(token));

    expect(getRes.status).toBe(200);
    expect(getRes.body.data.length).toBe(1);
    expect(getRes.body.data[0].name).toBe('VIP');
  });

  it('removes tag from record', async () => {
    const tag = await prisma.tag.create({ data: { name: 'Remove Me' } });
    const deal = await createTestDeal(userId);
    await prisma.tagAssignment.create({ data: { tagId: tag.id, module: 'deals', recordId: deal.id } });

    const res = await request(app)
      .delete(`/api/tags/assign/deals/${deal.id}/${tag.id}`)
      .set(authHeader(token));

    expect(res.status).toBe(200);
  });
});

// ─── NOTES ───

describe('Notes', () => {
  it('creates and lists notes for a record', async () => {
    const deal = await createTestDeal(userId);

    const createRes = await request(app)
      .post(`/api/notes/deals/${deal.id}`)
      .set(authHeader(token))
      .send({ body: 'Important meeting notes from the call today.' });

    expect(createRes.status).toBe(201);
    expect(createRes.body.body).toContain('Important meeting notes');
    expect(createRes.body.author).toBeDefined();

    const listRes = await request(app)
      .get(`/api/notes/deals/${deal.id}`)
      .set(authHeader(token));

    expect(listRes.status).toBe(200);
    expect(listRes.body.data.length).toBe(1);
  });

  it('pins and unpins a note', async () => {
    const contact = await createTestContact();
    const note = await prisma.note.create({
      data: { body: 'Pin me', module: 'contacts', recordId: contact.id, authorId: userId },
    });

    const res = await request(app)
      .post(`/api/notes/${note.id}/pin`)
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.pinned).toBe(true);
  });

  it('only author can delete their note', async () => {
    const contact = await createTestContact();
    const { user: otherUser, token: otherToken } = await createTestUser({ email: 'other@test.com' });

    const note = await prisma.note.create({
      data: { body: 'My note', module: 'contacts', recordId: contact.id, authorId: userId },
    });

    // Other user cannot delete
    const failRes = await request(app)
      .delete(`/api/notes/${note.id}`)
      .set(authHeader(otherToken));

    expect(failRes.status).toBe(403);

    // Author can delete
    const successRes = await request(app)
      .delete(`/api/notes/${note.id}`)
      .set(authHeader(token));

    expect(successRes.status).toBe(200);
  });
});

// ─── WEB-TO-LEAD ───

describe('Web-to-Lead', () => {
  it('creates a lead from public form (no auth)', async () => {
    const res = await request(app)
      .post('/api/public/web-to-lead')
      .send({
        firstName: 'Web',
        lastName: 'Visitor',
        email: 'visitor@example.com',
        company: 'New Prospect Corp',
        source: 'Web Form',
      });

    expect(res.status).toBe(201);
    expect(res.body.leadId).toBeDefined();

    // Verify lead created
    const lead = await prisma.lead.findUnique({ where: { id: res.body.leadId } });
    expect(lead.firstName).toBe('Web');
    expect(lead.source).toBe('Web Form');
  });

  it('rejects duplicate email', async () => {
    await createTestLead({ email: 'dupe@test.com' });

    const res = await request(app)
      .post('/api/public/web-to-lead')
      .send({ firstName: 'Dupe', lastName: 'Lead', email: 'dupe@test.com', company: 'Corp' });

    expect(res.status).toBe(409);
  });

  it('validates required fields', async () => {
    const res = await request(app)
      .post('/api/public/web-to-lead')
      .send({ firstName: 'Only' });

    expect(res.status).toBe(400);
  });
});

// ─── DEAL LINE ITEMS ───

describe('Deal Line Items', () => {
  it('adds line items to a deal', async () => {
    const deal = await createTestDeal(userId, { value: 0 });
    const product = await createTestProduct();

    const res = await request(app)
      .post(`/api/deals/${deal.id}/line-items`)
      .set(authHeader(token))
      .send({ productId: product.id, name: product.name, quantity: 2, price: 5000, discount: 10 });

    expect(res.status).toBe(201);
    expect(res.body.total).toBe(9000); // 5000 * 2 * 0.9

    // Deal value should be updated
    const updatedDeal = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(updatedDeal.value).toBe(9000);
  });

  it('lists line items with subtotal', async () => {
    const deal = await createTestDeal(userId);
    await prisma.dealLineItem.create({
      data: { dealId: deal.id, name: 'Item 1', quantity: 1, price: 1000, total: 1000 },
    });
    await prisma.dealLineItem.create({
      data: { dealId: deal.id, name: 'Item 2', quantity: 3, price: 500, total: 1500 },
    });

    const res = await request(app)
      .get(`/api/deals/${deal.id}/line-items`)
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
    expect(res.body.subtotal).toBe(2500);
  });

  it('removes line item and recalculates deal value', async () => {
    const deal = await createTestDeal(userId, { value: 3000 });
    const item1 = await prisma.dealLineItem.create({
      data: { dealId: deal.id, name: 'Keep', price: 2000, total: 2000 },
    });
    const item2 = await prisma.dealLineItem.create({
      data: { dealId: deal.id, name: 'Remove', price: 1000, total: 1000 },
    });

    await request(app)
      .delete(`/api/deals/${deal.id}/line-items/${item2.id}`)
      .set(authHeader(token));

    const updatedDeal = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(updatedDeal.value).toBe(2000);
  });
});

// ─── LEAD SCORING RULES ───

describe('Lead Scoring Rules', () => {
  it('creates scoring rules and scores a lead', async () => {
    // Create rules
    await request(app)
      .post('/api/admin/scoring-rules')
      .set(authHeader(token))
      .send({ name: 'Enterprise bonus', field: 'company', operator: 'contains', value: 'enterprise', points: 20 });

    await request(app)
      .post('/api/admin/scoring-rules')
      .set(authHeader(token))
      .send({ name: 'LinkedIn source', field: 'source', operator: 'equals', value: 'linkedin', points: 15 });

    // Create lead that matches
    const lead = await createTestLead({ company: 'Enterprise Corp', source: 'LinkedIn' });

    // Score the lead
    const scoreRes = await request(app)
      .post(`/api/leads/${lead.id}/score`)
      .set(authHeader(token));

    expect(scoreRes.status).toBe(200);
    expect(scoreRes.body.score).toBe(85); // 50 base + 20 + 15
    expect(scoreRes.body.rulesApplied).toBe(2);
  });

  it('batch rescores all leads', async () => {
    await prisma.leadScoringRule.create({
      data: { name: 'Web bonus', field: 'source', operator: 'equals', value: 'website', points: 10 },
    });
    await createTestLead({ source: 'Website' });
    await createTestLead({ source: 'Website' });

    const res = await request(app)
      .post('/api/admin/score-all-leads')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.updated).toBeGreaterThanOrEqual(2);
  });
});

// ─── ASSIGNMENT RULES ───

describe('Assignment Rules', () => {
  it('creates round-robin assignment rule', async () => {
    const { user: rep1 } = await createTestUser({ email: 'rep1@test.com' });
    const { user: rep2 } = await createTestUser({ email: 'rep2@test.com' });

    const res = await request(app)
      .post('/api/admin/assignment-rules')
      .set(authHeader(token))
      .send({
        name: 'Lead Round Robin',
        module: 'leads',
        type: 'round_robin',
        assignees: [rep1.id, rep2.id],
      });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('round_robin');
  });
});

// ─── CSV EXPORT ───

describe('CSV Export', () => {
  it('exports contacts as CSV', async () => {
    await createTestContact({ firstName: 'Export', lastName: 'Test' });

    const res = await request(app)
      .get('/api/admin/export-csv/contacts')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('firstName');
    expect(res.text).toContain('Export');
  });

  it('rejects unknown module', async () => {
    const res = await request(app)
      .get('/api/admin/export-csv/unknown')
      .set(authHeader(token));

    expect(res.status).toBe(400);
  });
});

// ─── LEAD DUPLICATE DETECTION ───

describe('Lead Duplicate Detection', () => {
  it('finds duplicate leads', async () => {
    const lead1 = await createTestLead({ firstName: 'John', lastName: 'Smith', company: 'Acme' });
    const lead2 = await createTestLead({ firstName: 'John', lastName: 'Smith', company: 'Different Corp' });

    const res = await request(app)
      .get(`/api/leads/${lead1.id}/duplicates`)
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].id).toBe(lead2.id);
  });
});

// ─── PAGINATION ───

describe('Pagination on List Endpoints', () => {
  it('paginates quotes', async () => {
    const res = await request(app)
      .get('/api/quotes?page=1&limit=5')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.page).toBe(1);
    expect(res.body.meta.limit).toBe(5);
  });

  it('paginates invoices', async () => {
    const res = await request(app)
      .get('/api/invoices?page=1&limit=5')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.meta).toBeDefined();
  });

  it('paginates emails', async () => {
    const res = await request(app)
      .get('/api/emails?page=1&limit=5')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.meta).toBeDefined();
  });
});
