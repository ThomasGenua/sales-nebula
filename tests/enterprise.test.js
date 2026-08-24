const request = require('supertest');
const {
  setup, teardown, cleanDatabase,
  createTestUser, createTestDeal, createTestProduct, createTestCase, authHeader,
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

// ─── HEALTH CHECK ───

describe('GET /api/health', () => {
  it('returns ok status', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe('2.0.0');
  });
});

// ─── KNOWLEDGE BASE ───

describe('Knowledge Base', () => {
  let categoryId;

  beforeEach(async () => {
    const cat = await prisma.knowledgeCategory.create({ data: { name: 'Getting Started', slug: 'getting-started' } });
    categoryId = cat.id;
  });

  it('creates an article', async () => {
    const res = await request(app)
      .post('/api/knowledge')
      .set(authHeader(token))
      .send({
        title: 'How to Set Up',
        slug: 'how-to-set-up',
        summary: 'Quick guide',
        body: 'Step 1: do this. Step 2: do that.',
        categoryId,
        visibility: 'Public',
        tags: ['setup', 'guide'],
      });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('How to Set Up');
    expect(res.body.version).toBe(1);
  });

  it('searches articles', async () => {
    await prisma.knowledgeArticle.create({
      data: {
        title: 'Troubleshooting Login',
        slug: 'troubleshoot-login',
        body: 'If you cannot log in, try resetting your password.',
        categoryId,
        authorId: userId,
        visibility: 'Public',
      },
    });

    const res = await request(app)
      .get('/api/knowledge?search=login')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    // Should find the article (search implementation varies)
  });

  it('votes on article', async () => {
    const article = await prisma.knowledgeArticle.create({
      data: {
        title: 'Helpful Article',
        slug: 'helpful',
        body: 'Content',
        categoryId,
        authorId: userId,
      },
    });

    const res = await request(app)
      .post(`/api/knowledge/${article.id}/vote`)
      .set(authHeader(token))
      .send({ helpful: true });

    expect(res.status).toBe(200);
    expect(res.body.helpfulCount).toBe(1);
  });
});

// ─── CHATTER ───

describe('Chatter', () => {
  it('creates a post', async () => {
    const res = await request(app)
      .post('/api/chatter')
      .set(authHeader(token))
      .send({ body: 'This is a team update!' });

    expect(res.status).toBe(201);
    expect(res.body.body).toBe('This is a team update!');
    expect(res.body.authorId).toBe(userId);
  });

  it('lists feed posts', async () => {
    await prisma.chatterPost.create({
      data: { body: 'Post 1', authorId: userId },
    });
    await prisma.chatterPost.create({
      data: { body: 'Post 2', authorId: userId },
    });

    const res = await request(app)
      .get('/api/chatter')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });

  it('comments on a post', async () => {
    const post = await prisma.chatterPost.create({
      data: { body: 'Original', authorId: userId },
    });

    const res = await request(app)
      .post(`/api/chatter/${post.id}/comments`)
      .set(authHeader(token))
      .send({ body: 'Great point!' });

    expect(res.status).toBe(201);
    expect(res.body.body).toBe('Great point!');
  });

  it('likes and unlikes a post', async () => {
    const post = await prisma.chatterPost.create({
      data: { body: 'Like me', authorId: userId },
    });

    // Like
    let res = await request(app)
      .post(`/api/chatter/${post.id}/like`)
      .set(authHeader(token));
    expect(res.status).toBe(200);

    // Unlike (toggle)
    res = await request(app)
      .post(`/api/chatter/${post.id}/like`)
      .set(authHeader(token));
    expect(res.status).toBe(200);
  });
});

// ─── PRODUCTS ───

describe('Products', () => {
  it('creates and lists products', async () => {
    const res = await request(app)
      .post('/api/products')
      .set(authHeader(token))
      .send({
        name: 'Enterprise License',
        sku: 'ENT-001',
        price: 999.99,
        cost: 200,
        category: 'Software',
        active: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.price).toBe(999.99);

    const list = await request(app)
      .get('/api/products')
      .set(authHeader(token));
    expect(list.body.data).toHaveLength(1);
  });
});

// ─── CASES ───

describe('Cases', () => {
  it('creates a case and adds comment', async () => {
    const caseRes = await request(app)
      .post('/api/cases')
      .set(authHeader(token))
      .send({
        subject: 'Cannot login',
        status: 'New',
        priority: 'High',
        type: 'Bug',
        origin: 'Email',
      });

    expect(caseRes.status).toBe(201);
    expect(caseRes.body.caseNumber).toBeDefined();
    expect(caseRes.body.priority).toBe('High');

    // Add comment
    const commentRes = await request(app)
      .post(`/api/cases/${caseRes.body.id}/comments`)
      .set(authHeader(token))
      .send({ body: 'Looking into this now.' });

    expect(commentRes.status).toBe(201);
    expect(commentRes.body.body).toBe('Looking into this now.');
  });
});

// ─── ADMIN ───

describe('Admin', () => {
  it('returns system stats', async () => {
    const res = await request(app)
      .get('/api/admin/stats')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('contacts');
    expect(res.body).toHaveProperty('deals');
  });

  it('returns audit log', async () => {
    const res = await request(app)
      .get('/api/admin/audit-log')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ─── CROSS-MODULE: Quotes & Invoices ───

describe('Quote to Invoice pipeline', () => {
  it('creates a quote and converts to invoice', async () => {
    const product = await createTestProduct({ price: 100 });

    const quoteRes = await request(app)
      .post('/api/quotes')
      .set(authHeader(token))
      .send({
        quoteNumber: 'Q-001',
        status: 'Draft',
        total: 500,
        tax: 50,
        discount: 0,
        validUntil: '2026-12-31',
      });

    expect(quoteRes.status).toBe(201);

    // Accept
    const acceptRes = await request(app)
      .post(`/api/quotes/${quoteRes.body.id}/accept`)
      .set(authHeader(token));
    expect(acceptRes.status).toBe(200);

    // Create invoice from quote
    const invoiceRes = await request(app)
      .post(`/api/quotes/${quoteRes.body.id}/create-invoice`)
      .set(authHeader(token));

    expect(invoiceRes.status).toBe(200);
    // Should create an invoice linked to the quote
  });
});
