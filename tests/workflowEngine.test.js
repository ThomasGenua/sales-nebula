const request = require('supertest');
const {
  setup, teardown, cleanDatabase,
  createTestRole, createTestUser, createTestAccount, authHeader,
} = require('./setup');
const { handlers, setDatabaseClient } = require('../src/jobs/scheduler');

let app, prisma, user;

async function makeWorkflow(over = {}) {
  return prisma.workflow.create({
    data: {
      name: 'Rule',
      module: 'deals',
      trigger: 'create',
      conditions: [],
      actions: [],
      active: true,
      ...over,
    },
  });
}

const newDeal = (body = {}) => ({ name: 'Big Deal', value: 50000, stage: 'Prospecting', ...body });

beforeAll(async () => {
  ({ prisma, app } = await setup());
  // The job handlers take their client from the scheduler, which normally
  // gets one from initJobQueue — and that also starts cron.
  setDatabaseClient(prisma);
});
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  const role = await createTestRole('Admin');
  user = await createTestUser({ email: 'rep@test.com', roleId: role.id });
});

describe('Rules fire on a record write', () => {
  it('runs a matching create rule, which nothing used to do', async () => {
    await makeWorkflow({
      trigger: 'create',
      conditions: [{ field: 'stage', operator: 'equals', value: 'Prospecting' }],
      actions: [{ type: 'updateField', config: { field: 'stage', value: 'Qualified' } }],
    });

    const res = await request(app).post('/api/deals').set(authHeader(user.token)).send(newDeal());
    expect(res.status).toBe(201);

    const saved = await prisma.deal.findUnique({ where: { id: res.body.id } });
    expect(saved.stage).toBe('Qualified');

    const logs = await prisma.workflowLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0].success).toBe(true);
    expect(logs[0].actionsRun).toContain('Updated stage');
    expect(logs[0].recordId).toBe(res.body.id);
  });

  it('leaves a record alone when the conditions do not hold', async () => {
    await makeWorkflow({
      conditions: [{ field: 'stage', operator: 'equals', value: 'Negotiation' }],
      actions: [{ type: 'updateField', config: { field: 'stage', value: 'Qualified' } }],
    });

    const res = await request(app).post('/api/deals').set(authHeader(user.token)).send(newDeal());
    const saved = await prisma.deal.findUnique({ where: { id: res.body.id } });
    expect(saved.stage).toBe('Prospecting');
    expect(await prisma.workflowLog.count()).toBe(0);
  });

  it('ignores a rule that is switched off', async () => {
    await makeWorkflow({
      active: false,
      actions: [{ type: 'updateField', config: { field: 'stage', value: 'Qualified' } }],
    });
    const res = await request(app).post('/api/deals').set(authHeader(user.token)).send(newDeal());
    const saved = await prisma.deal.findUnique({ where: { id: res.body.id } });
    expect(saved.stage).toBe('Prospecting');
  });

  it('fires on update, with access to the previous values', async () => {
    await makeWorkflow({
      trigger: 'update',
      conditions: [{ field: 'value', operator: 'changed' }],
      actions: [{ type: 'createNotification', config: { title: 'Value moved' } }],
    });

    const created = await request(app).post('/api/deals').set(authHeader(user.token)).send(newDeal({ ownerId: user.user.id }));
    await request(app).put(`/api/deals/${created.body.id}`).set(authHeader(user.token)).send({ value: 90000 });

    const notifications = await prisma.notification.findMany();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('Value moved');
    expect(notifications[0].userId).toBe(user.user.id);   // routed to the owner
  });

  it('treats a stage move as its own trigger', async () => {
    await makeWorkflow({
      trigger: 'statusChange',
      actions: [{ type: 'createNotification', config: { title: 'Stage moved', userId: undefined } }],
    });

    const created = await request(app).post('/api/deals').set(authHeader(user.token)).send(newDeal({ ownerId: user.user.id }));
    await request(app).put(`/api/deals/${created.body.id}`).set(authHeader(user.token)).send({ value: 60000 });
    expect(await prisma.notification.count()).toBe(0);    // no stage change yet

    await request(app).put(`/api/deals/${created.body.id}`).set(authHeader(user.token)).send({ stage: 'Closed Won' });
    expect(await prisma.notification.count()).toBe(1);
  });

  it('works for a module whose plural is irregular', async () => {
    // "activities".slice(0, -1) is "activitie", which threw on every run.
    await makeWorkflow({
      module: 'activities',
      trigger: 'create',
      actions: [{ type: 'updateField', config: { field: 'priority', value: 'High' } }],
    });

    const res = await request(app).post('/api/activities').set(authHeader(user.token))
      .send({ type: 'Call', subject: 'Follow up', priority: 'Low' });
    expect(res.status).toBe(201);

    const saved = await prisma.activity.findUnique({ where: { id: res.body.id } });
    expect(saved.priority).toBe('High');
  });

  it('records a failing rule without failing the write', async () => {
    await makeWorkflow({
      actions: [{ type: 'updateField', config: { field: 'noSuchColumn', value: 'x' } }],
    });

    const res = await request(app).post('/api/deals').set(authHeader(user.token)).send(newDeal());
    expect(res.status).toBe(201);                       // the deal is still created

    const logs = await prisma.workflowLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0].success).toBe(false);
    expect(logs[0].error).toBeTruthy();
  });

  it('creates a follow-up task linked to the record that triggered it', async () => {
    await makeWorkflow({
      actions: [{ type: 'createActivity', config: { subject: 'Call them back', actType: 'Call' } }],
    });

    const res = await request(app).post('/api/deals').set(authHeader(user.token)).send(newDeal({ ownerId: user.user.id }));
    const activities = await prisma.activity.findMany();
    expect(activities).toHaveLength(1);
    expect(activities[0].subject).toBe('Call them back');
    expect(activities[0].dealId).toBe(res.body.id);      // not an orphan
  });
});

describe('Scheduled rules', () => {
  it('acts on the records that match, and only those', async () => {
    const account = await createTestAccount();
    await prisma.deal.create({ data: { name: 'Stale', value: 10, stage: 'Prospecting', accountId: account.id } });
    await prisma.deal.create({ data: { name: 'Won', value: 20, stage: 'Closed Won', accountId: account.id } });

    await makeWorkflow({
      trigger: 'scheduled',
      conditions: [{ field: 'stage', operator: 'equals', value: 'Prospecting' }],
      actions: [{ type: 'updateField', config: { field: 'stage', value: 'Nurture' } }],
    });

    const result = await handlers.runScheduledWorkflows();
    expect(result.matched).toBe(1);

    const deals = await prisma.deal.findMany({ orderBy: { name: 'asc' } });
    expect(deals.find(d => d.name === 'Stale').stage).toBe('Nurture');
    expect(deals.find(d => d.name === 'Won').stage).toBe('Closed Won');
  });

  it('no longer logs a success for work it did not do', async () => {
    await makeWorkflow({
      trigger: 'scheduled',
      conditions: [{ field: 'stage', operator: 'equals', value: 'Nothing matches this' }],
      actions: [{ type: 'updateField', config: { field: 'stage', value: 'Nurture' } }],
    });

    await handlers.runScheduledWorkflows();
    // The old handler wrote actionsRun: ['Scheduled execution'], success: true
    // for every scheduled workflow regardless of whether anything ran.
    const logs = await prisma.workflowLog.findMany();
    expect(logs).toHaveLength(0);
  });

  it('records an unusable module instead of reporting success', async () => {
    await makeWorkflow({ module: 'nonsense', trigger: 'scheduled', actions: [] });
    const result = await handlers.runScheduledWorkflows();

    expect(result.failed).toBe(1);
    const logs = await prisma.workflowLog.findMany();
    expect(logs[0].success).toBe(false);
    expect(logs[0].error).toMatch(/unknown module/i);
  });
});

describe('POST /api/workflows/execute', () => {
  it('runs the same engine as the write paths', async () => {
    await makeWorkflow({
      trigger: 'update',
      actions: [{ type: 'updateField', config: { field: 'stage', value: 'Qualified' } }],
    });
    const deal = await prisma.deal.create({ data: { name: 'Manual', value: 1, stage: 'Prospecting' } });

    const res = await request(app).post('/api/workflows/execute').set(authHeader(user.token))
      .send({ module: 'deals', trigger: 'update', record: deal });

    expect(res.status).toBe(200);
    expect(res.body.executed).toBe(1);
    const saved = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(saved.stage).toBe('Qualified');
  });

  it('rejects a call with no record', async () => {
    const res = await request(app).post('/api/workflows/execute').set(authHeader(user.token))
      .send({ module: 'deals', trigger: 'update' });
    expect(res.status).toBe(400);
  });
});
