const request = require('supertest');
const {
  setup, teardown, cleanDatabase,
  createTestUser, createTestAccount, createTestContact,
  createTestDeal, createTestLead, createTestCase, createTestProduct,
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

// ─── DASHBOARD ───

describe('Dashboard API', () => {
  it('returns aggregate stats', async () => {
    // Seed some data
    const account = await createTestAccount();
    await createTestContact({ accountId: account.id });
    await createTestLead();
    await createTestDeal(userId, { accountId: account.id });

    const res = await request(app)
      .get('/api/dashboard')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.counts).toBeDefined();
    expect(res.body.counts.contacts).toBeGreaterThanOrEqual(1);
    expect(res.body.counts.leads).toBeGreaterThanOrEqual(1);
    expect(res.body.counts.openDeals).toBeGreaterThanOrEqual(1);
    expect(res.body.pipeline).toBeDefined();
    expect(res.body.pipeline.totalValue).toBeGreaterThan(0);
    expect(res.body.revenue).toBeDefined();
    expect(res.body.rates).toBeDefined();
    expect(res.body.recentDeals).toBeDefined();
  });

  it('returns leaderboard', async () => {
    await createTestDeal(userId, { stage: 'Closed Won', value: 100000 });

    const res = await request(app)
      .get('/api/dashboard/leaderboard')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0].user).toBeDefined();
    expect(res.body.data[0].wonAllTime).toBeGreaterThanOrEqual(100000);
  });
});

// ─── GLOBAL SEARCH ───

describe('Global Search', () => {
  it('searches across modules', async () => {
    await createTestContact({ firstName: 'Searchable', lastName: 'Person' });
    await createTestDeal(userId, { name: 'Searchable Deal' });
    await createTestAccount({ name: 'Searchable Corp' });

    const res = await request(app)
      .get('/api/search?q=Searchable')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.totalResults).toBeGreaterThanOrEqual(3);
    expect(res.body.results.contacts).toBeDefined();
    expect(res.body.results.deals).toBeDefined();
    expect(res.body.results.accounts).toBeDefined();
  });

  it('rejects short queries', async () => {
    const res = await request(app)
      .get('/api/search?q=a')
      .set(authHeader(token));

    expect(res.status).toBe(400);
  });

  it('filters by module', async () => {
    await createTestContact({ firstName: 'Filtered', lastName: 'Test' });
    await createTestDeal(userId, { name: 'Filtered Deal' });

    const res = await request(app)
      .get('/api/search?q=Filtered&modules=contacts')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.results.contacts).toBeDefined();
    expect(res.body.results.deals).toBeUndefined();
  });
});

// ─── ACCOUNTS TIMELINE + STATS ───

describe('Account Timeline & Stats', () => {
  it('returns account timeline', async () => {
    const account = await createTestAccount();
    const contact = await createTestContact({ accountId: account.id });
    await createTestDeal(userId, { accountId: account.id });

    const res = await request(app)
      .get(`/api/accounts/${account.id}/timeline`)
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.contacts).toBeDefined();
    expect(res.body.deals).toBeDefined();
    expect(res.body.contacts.length).toBeGreaterThanOrEqual(1);
  });

  it('returns account stats', async () => {
    const account = await createTestAccount();
    await createTestDeal(userId, { accountId: account.id, value: 75000 });
    await createTestDeal(userId, { accountId: account.id, stage: 'Closed Won', value: 50000 });

    const res = await request(app)
      .get(`/api/accounts/${account.id}/stats`)
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.totalDeals).toBe(2);
    expect(res.body.openDeals).toBe(1);
    expect(res.body.pipelineValue).toBe(75000);
    expect(res.body.wonValue).toBe(50000);
  });
});

// ─── CASES ESCALATION + STATS ───

describe('Case Escalation & Stats', () => {
  it('escalates a case', async () => {
    const cs = await createTestCase({ subject: 'Urgent Issue' });

    const res = await request(app)
      .post(`/api/cases/${cs.id}/escalate`)
      .set(authHeader(token))
      .send({ reason: 'Customer unhappy' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Escalated');
    expect(res.body.priority).toBe('High'); // Medium -> High
  });

  it('resolves a case', async () => {
    const cs = await createTestCase({ subject: 'Bug Report', status: 'Open' });

    const res = await request(app)
      .post(`/api/cases/${cs.id}/resolve`)
      .set(authHeader(token))
      .send({ resolution: 'Fixed in v2.1' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Resolved');
    expect(res.body.resolution).toBe('Fixed in v2.1');
  });

  it('returns case stats overview', async () => {
    await createTestCase({ status: 'New' });
    await createTestCase({ status: 'Open' });
    await createTestCase({ status: 'Resolved' });

    const res = await request(app)
      .get('/api/cases/stats/overview')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
    expect(res.body.open).toBeGreaterThanOrEqual(2);
    expect(res.body.resolved).toBeGreaterThanOrEqual(1);
    expect(res.body.byStatus).toBeDefined();
    expect(res.body.byPriority).toBeDefined();
  });
});

// ─── DEAL STAGE HISTORY ───

describe('Deal Stage History', () => {
  it('tracks stage changes on update', async () => {
    const deal = await createTestDeal(userId, { stage: 'Qualification', value: 100000 });

    // Move to Discovery
    await request(app)
      .put(`/api/deals/${deal.id}`)
      .set(authHeader(token))
      .send({ name: deal.name, stage: 'Discovery', value: 100000 });

    // Move to Proposal
    await request(app)
      .put(`/api/deals/${deal.id}`)
      .set(authHeader(token))
      .send({ name: deal.name, stage: 'Proposal', value: 100000 });

    // Check timeline includes stage history
    const timelineRes = await request(app)
      .get(`/api/deals/${deal.id}/timeline`)
      .set(authHeader(token));

    expect(timelineRes.status).toBe(200);
    expect(timelineRes.body.stageHistory).toBeDefined();
    expect(timelineRes.body.stageHistory.length).toBeGreaterThanOrEqual(2);
    expect(timelineRes.body.stageHistory[0].fromStage).toBe('Qualification');
    expect(timelineRes.body.stageHistory[0].toStage).toBe('Discovery');
  });
});

// ─── EMAIL SEND SHORTCUT ───

describe('Email Send', () => {
  it('creates and sends email in one call', async () => {
    const res = await request(app)
      .post('/api/emails/send')
      .set(authHeader(token))
      .send({
        subject: 'Quick Test',
        body: 'Hello world',
        toName: 'John',
        toEmail: 'john@test.com',
      });

    expect(res.status).toBe(201);
    // /send now hands the message to a transport and records what came back.
    // There is no SMTP server in the test environment, so the mail utility
    // logs it: reported as queued, not sent, rather than claiming delivery.
    expect(res.body.status).toBe('queued');
    expect(res.body.delivery.transport).toBe('console');
    expect(res.body.delivery.delivered).toBe(false);
  });
});

// ─── USER PREFERENCES ───

describe('User Preferences', () => {
  it('gets default preferences', async () => {
    const res = await request(app)
      .get('/api/users/me/preferences')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.theme).toBe('light');
    expect(res.body.pageSize).toBe(50);
  });

  it('updates preferences', async () => {
    await request(app)
      .put('/api/users/me/preferences')
      .set(authHeader(token))
      .send({ theme: 'dark', pageSize: 25 });

    const res = await request(app)
      .get('/api/users/me/preferences')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.theme).toBe('dark');
    expect(res.body.pageSize).toBe(25);
    // Defaults still present
    expect(res.body.emailNotifications).toBe(true);
  });

  it('returns user activity feed', async () => {
    await createTestDeal(userId, { name: 'My Pipeline Deal' });

    const res = await request(app)
      .get('/api/users/me/activity')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.deals).toBeDefined();
    expect(res.body.deals.length).toBeGreaterThanOrEqual(1);
    expect(res.body.upcomingActivities).toBeDefined();
    expect(res.body.unreadNotifications).toBeDefined();
  });
});

// ─── FORECAST APPROVE ───

describe('Forecast Approve', () => {
  it('approves a submitted forecast', async () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const end = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3 + 3, 0);

    // Someone else's forecast: nobody approves their own.
    const { user: rep } = await createTestUser({ email: `forecaster${Date.now()}@test.com` });
    const forecast = await prisma.forecast.create({
      data: {
        name: 'Q1 Forecast',
        period: 'Q1-2026',
        periodStart: start,
        periodEnd: end,
        userId: rep.id,
        status: 'Submitted',
        quotaAmount: 500000,
      },
    });

    const res = await request(app)
      .post(`/api/forecasts/${forecast.id}/approve`)
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Approved');
  });
});
