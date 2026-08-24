const request = require('supertest');
const {
  setup, teardown, cleanDatabase,
  createTestUser, createTestDeal, createTestContact, createTestAccount, authHeader,
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

describe('GET /api/reports/metadata', () => {
  it('returns available modules, fields, and operators', async () => {
    const res = await request(app)
      .get('/api/reports/metadata')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.modules).toBeDefined();
    expect(res.body.modules.contacts).toBeDefined();
    expect(res.body.modules.deals).toBeDefined();
    expect(res.body.modules.deals.fields.value.type).toBe('number');
    expect(res.body.operators).toContain('equals');
    expect(res.body.operators).toContain('this_month');
    expect(res.body.aggregationFunctions).toContain('sum');
    expect(res.body.reportTypes).toContain('chart');
    expect(res.body.chartTypes).toContain('pie');
  });
});

describe('POST /api/reports', () => {
  it('creates a saved report', async () => {
    const res = await request(app)
      .post('/api/reports')
      .set(authHeader(token))
      .send({
        name: 'Deals by Stage',
        module: 'deals',
        reportType: 'chart',
        chartType: 'bar',
        columns: [{ field: 'name', label: 'Deal Name' }, { field: 'value', label: 'Value' }],
        filters: [{ field: 'stage', operator: 'not_equals', value: 'Closed Lost' }],
        groupBy: ['stage'],
        aggregations: [{ field: 'value', function: 'sum' }],
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('Deals by Stage');
    expect(res.body.module).toBe('deals');
    expect(res.body.createdBy.id).toBe(userId);
  });

  it('validates module', async () => {
    const res = await request(app)
      .post('/api/reports')
      .set(authHeader(token))
      .send({ name: 'Bad', module: 'unicorns' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid module/i);
  });

  it('requires name and module', async () => {
    const res = await request(app)
      .post('/api/reports')
      .set(authHeader(token))
      .send({});

    expect(res.status).toBe(400);
  });
});

describe('POST /api/reports/execute (ad-hoc)', () => {
  it('executes a tabular report', async () => {
    await createTestContact({ firstName: 'Alice', lastName: 'A', email: 'a@t.com', source: 'Web' });
    await createTestContact({ firstName: 'Bob', lastName: 'B', email: 'b@t.com', source: 'Referral' });
    await createTestContact({ firstName: 'Charlie', lastName: 'C', email: 'c@t.com', source: 'Web' });

    const res = await request(app)
      .post('/api/reports/execute')
      .set(authHeader(token))
      .send({
        module: 'contacts',
        reportType: 'tabular',
        columns: [{ field: 'firstName' }, { field: 'email' }, { field: 'source' }],
        filters: [],
        sortBy: [{ field: 'firstName', direction: 'asc' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.reportType).toBe('tabular');
    expect(res.body.rows).toHaveLength(3);
    expect(res.body.totalCount).toBe(3);
    expect(res.body.rows[0].firstName).toBe('Alice');
    expect(res.body.executionMs).toBeDefined();
  });

  it('applies equals filter', async () => {
    await createTestContact({ firstName: 'Web', lastName: 'Lead', source: 'Web' });
    await createTestContact({ firstName: 'Ref', lastName: 'Lead', source: 'Referral' });

    const res = await request(app)
      .post('/api/reports/execute')
      .set(authHeader(token))
      .send({
        module: 'contacts',
        reportType: 'tabular',
        filters: [{ field: 'source', operator: 'equals', value: 'Web' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].source).toBe('Web');
  });

  it('applies contains filter (case insensitive)', async () => {
    await createTestContact({ firstName: 'Alexandra', lastName: 'Test' });
    await createTestContact({ firstName: 'Bob', lastName: 'Test' });

    const res = await request(app)
      .post('/api/reports/execute')
      .set(authHeader(token))
      .send({
        module: 'contacts',
        filters: [{ field: 'firstName', operator: 'contains', value: 'alex' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].firstName).toBe('Alexandra');
  });

  it('applies numeric gt/lt filters on deals', async () => {
    await createTestDeal(userId, { name: 'Big', value: 200000 });
    await createTestDeal(userId, { name: 'Medium', value: 50000 });
    await createTestDeal(userId, { name: 'Small', value: 5000 });

    const res = await request(app)
      .post('/api/reports/execute')
      .set(authHeader(token))
      .send({
        module: 'deals',
        filters: [{ field: 'value', operator: 'gt', value: 10000 }],
        sortBy: [{ field: 'value', direction: 'desc' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0].name).toBe('Big');
  });

  it('applies in filter', async () => {
    await createTestDeal(userId, { name: 'Q', stage: 'Qualification' });
    await createTestDeal(userId, { name: 'P', stage: 'Proposal' });
    await createTestDeal(userId, { name: 'W', stage: 'Closed Won' });

    const res = await request(app)
      .post('/api/reports/execute')
      .set(authHeader(token))
      .send({
        module: 'deals',
        filters: [{ field: 'stage', operator: 'in', value: ['Qualification', 'Proposal'] }],
      });

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
  });

  it('applies date filters', async () => {
    // These contacts will be created "today"
    await createTestContact({ firstName: 'Recent', lastName: 'One' });
    await createTestContact({ firstName: 'Recent', lastName: 'Two' });

    const res = await request(app)
      .post('/api/reports/execute')
      .set(authHeader(token))
      .send({
        module: 'contacts',
        filters: [{ field: 'createdAt', operator: 'last_n_days', value: 7 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
  });

  it('respects limit', async () => {
    for (let i = 0; i < 10; i++) {
      await createTestContact({ firstName: `User${i}`, lastName: `Lim${i}` });
    }

    const res = await request(app)
      .post('/api/reports/execute')
      .set(authHeader(token))
      .send({ module: 'contacts', limit: 3 });

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(3);
    expect(res.body.totalCount).toBe(10);
  });
});

describe('Report Builder: Chart reports with aggregations', () => {
  beforeEach(async () => {
    await createTestDeal(userId, { name: 'D1', stage: 'Qualification', value: 10000 });
    await createTestDeal(userId, { name: 'D2', stage: 'Qualification', value: 20000 });
    await createTestDeal(userId, { name: 'D3', stage: 'Proposal', value: 50000 });
    await createTestDeal(userId, { name: 'D4', stage: 'Closed Won', value: 100000 });
  });

  it('groups by stage with sum aggregation', async () => {
    const res = await request(app)
      .post('/api/reports/execute')
      .set(authHeader(token))
      .send({
        module: 'deals',
        reportType: 'chart',
        chartType: 'bar',
        groupBy: ['stage'],
        aggregations: [{ field: 'value', function: 'sum' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.chartData).toBeDefined();
    expect(res.body.chartData.length).toBeGreaterThanOrEqual(2);

    // Find the Qualification group
    const qual = res.body.chartData.find(g => g.label === 'Qualification');
    expect(qual).toBeDefined();
    expect(qual.count).toBe(2);
    expect(qual.sum_value).toBe(30000);
  });

  it('summary report with totals', async () => {
    const res = await request(app)
      .post('/api/reports/execute')
      .set(authHeader(token))
      .send({
        module: 'deals',
        reportType: 'summary',
        groupBy: ['stage'],
        aggregations: [
          { field: 'value', function: 'sum' },
          { field: 'id', function: 'count' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.summary).toBeDefined();
    expect(res.body.rows).toBeDefined();
    expect(res.body.rows).toHaveLength(4);
  });
});

describe('Saved report lifecycle', () => {
  let reportId;

  it('create -> read -> update -> execute -> clone -> delete', async () => {
    // Create
    let res = await request(app)
      .post('/api/reports')
      .set(authHeader(token))
      .send({
        name: 'My Pipeline',
        module: 'deals',
        reportType: 'tabular',
        columns: [{ field: 'name' }, { field: 'value' }, { field: 'stage' }],
        filters: [],
      });
    expect(res.status).toBe(201);
    reportId = res.body.id;

    // Read
    res = await request(app)
      .get(`/api/reports/${reportId}`)
      .set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('My Pipeline');

    // Update
    res = await request(app)
      .put(`/api/reports/${reportId}`)
      .set(authHeader(token))
      .send({ name: 'My Pipeline v2', isPublic: true });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('My Pipeline v2');
    expect(res.body.isPublic).toBe(true);

    // Execute saved
    await createTestDeal(userId, { name: 'Test Deal', value: 50000 });
    res = await request(app)
      .post(`/api/reports/${reportId}/execute`)
      .set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);

    // Clone
    res = await request(app)
      .post(`/api/reports/${reportId}/clone`)
      .set(authHeader(token));
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('My Pipeline v2 (Copy)');
    expect(res.body.id).not.toBe(reportId);

    // Delete
    res = await request(app)
      .delete(`/api/reports/${reportId}`)
      .set(authHeader(token));
    expect(res.status).toBe(200);

    // Verify deleted
    res = await request(app)
      .get(`/api/reports/${reportId}`)
      .set(authHeader(token));
    expect(res.status).toBe(404);
  });
});

describe('Report Builder: Export', () => {
  it('exports as JSON', async () => {
    await createTestContact({ firstName: 'Export', lastName: 'Me' });

    const report = await prisma.report.create({
      data: {
        name: 'Export Test',
        module: 'contacts',
        reportType: 'tabular',
        columns: [{ field: 'firstName' }, { field: 'lastName' }],
        filters: [],
        createdById: userId,
      },
    });

    const res = await request(app)
      .post(`/api/reports/${report.id}/export`)
      .set(authHeader(token))
      .send({ format: 'json' });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].firstName).toBe('Export');
  });

  it('exports as CSV', async () => {
    await createTestContact({ firstName: 'CSV', lastName: 'Export', email: 'csv@test.com' });

    const report = await prisma.report.create({
      data: {
        name: 'CSV Test',
        module: 'contacts',
        reportType: 'tabular',
        columns: [],
        filters: [],
        createdById: userId,
      },
    });

    const res = await request(app)
      .post(`/api/reports/${report.id}/export`)
      .set(authHeader(token))
      .send({ format: 'csv' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('CSV');
  });
});

describe('Report Builder: Preview', () => {
  it('returns limited preview results', async () => {
    for (let i = 0; i < 30; i++) {
      await createTestContact({ firstName: `Preview${i}`, lastName: `User${i}` });
    }

    const res = await request(app)
      .post('/api/reports/preview')
      .set(authHeader(token))
      .send({ module: 'contacts' });

    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeLessThanOrEqual(25);
  });
});

describe('Report Builder: Folders', () => {
  it('creates and lists folders', async () => {
    let res = await request(app)
      .post('/api/reports/folders')
      .set(authHeader(token))
      .send({ name: 'Sales Reports' });

    expect(res.status).toBe(201);
    const folderId = res.body.id;

    res = await request(app)
      .get('/api/reports/folders/all')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].name).toBe('Sales Reports');
  });
});

describe('Report Builder: Access control', () => {
  it('prevents non-owner from editing private report', async () => {
    const otherUser = await createTestUser({ email: 'other@test.com' });

    const report = await prisma.report.create({
      data: {
        name: 'Private Report',
        module: 'contacts',
        reportType: 'tabular',
        columns: [],
        filters: [],
        isPublic: false,
        createdById: userId,
      },
    });

    // Other user tries to edit
    const res = await request(app)
      .put(`/api/reports/${report.id}`)
      .set(authHeader(otherUser.token))
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(403);
  });

  it('allows access to public reports', async () => {
    const otherUser = await createTestUser({ email: 'viewer@test.com' });

    const report = await prisma.report.create({
      data: {
        name: 'Public Report',
        module: 'deals',
        reportType: 'tabular',
        columns: [],
        filters: [],
        isPublic: true,
        createdById: userId,
      },
    });

    const res = await request(app)
      .get(`/api/reports/${report.id}`)
      .set(authHeader(otherUser.token));

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Public Report');
  });
});
