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

  // The job runs every 15 minutes. A rule acted on every matching record on
  // every run, so a rule that creates a task, notifies or emails did it 96
  // times a day for each record, for as long as the record matched.
  it('acts on a matching record once, not on every run', async () => {
    const account = await createTestAccount();
    const deal = await prisma.deal.create({ data: { name: 'Stale', value: 10, stage: 'Prospecting', accountId: account.id } });
    await makeWorkflow({
      trigger: 'scheduled',
      conditions: [{ field: 'stage', operator: 'equals', value: 'Prospecting' }],
      actions: [{ type: 'createActivity', config: { subject: 'Chase this deal' } }],
    });

    const first = await handlers.runScheduledWorkflows();
    const second = await handlers.runScheduledWorkflows();
    const third = await handlers.runScheduledWorkflows();

    expect([first.matched, second.matched, third.matched]).toEqual([1, 0, 0]);
    expect(third.alreadyActed).toBe(1);
    expect(await prisma.activity.count({ where: { dealId: deal.id } })).toBe(1);
  });

  it('acts again after the record stops matching and matches again, and not for another rule\'s update', async () => {
    const account = await createTestAccount();
    const deal = await prisma.deal.create({ data: { name: 'Stale', value: 10, stage: 'Prospecting', accountId: account.id } });
    const chase = await makeWorkflow({
      name: 'Chase',
      trigger: 'scheduled',
      conditions: [{ field: 'stage', operator: 'equals', value: 'Prospecting' }],
      actions: [{ type: 'createActivity', config: { subject: 'Chase this deal' } }],
    });
    // A second rule whose own action changes the record, which still matches:
    // neither rule takes that change as a reason to act again.
    const tag = await makeWorkflow({
      name: 'Tag',
      trigger: 'scheduled',
      conditions: [{ field: 'stage', operator: 'equals', value: 'Prospecting' }],
      actions: [{ type: 'updateField', config: { field: 'description', value: 'Needs a nudge' } }],
    });
    const acted = id => prisma.workflowLog.count({ where: { workflowId: id, trigger: 'scheduled' } });

    await handlers.runScheduledWorkflows();
    await handlers.runScheduledWorkflows();
    expect(await prisma.activity.count({ where: { dealId: deal.id } })).toBe(1);
    expect([await acted(chase.id), await acted(tag.id)]).toEqual([1, 1]);

    // An edit that leaves it matching is not a new occasion either.
    await prisma.deal.update({ where: { id: deal.id }, data: { value: 20 } });
    await handlers.runScheduledWorkflows();
    expect(await prisma.activity.count({ where: { dealId: deal.id } })).toBe(1);

    // It leaves Prospecting, then comes back: both rules act once more.
    await prisma.deal.update({ where: { id: deal.id }, data: { stage: 'Qualification' } });
    await handlers.runScheduledWorkflows();
    expect(await prisma.activity.count({ where: { dealId: deal.id } })).toBe(1);
    await prisma.deal.update({ where: { id: deal.id }, data: { stage: 'Prospecting' } });
    await handlers.runScheduledWorkflows();
    await handlers.runScheduledWorkflows();
    expect(await prisma.activity.count({ where: { dealId: deal.id } })).toBe(2);
    expect([await acted(chase.id), await acted(tag.id)]).toEqual([2, 2]);
  });

  it('reaches every matching record, at most 500 a run, not only the first 500 rows', async () => {
    const account = await createTestAccount();
    await prisma.deal.createMany({
      data: Array.from({ length: 600 }, (_, i) => ({ name: `Deal ${i}`, value: i, stage: 'Prospecting', accountId: account.id })),
    });
    // No owner to notify, so the action does nothing; each run logs what it acted on.
    const wf = await makeWorkflow({
      trigger: 'scheduled',
      conditions: [{ field: 'stage', operator: 'equals', value: 'Prospecting' }],
      actions: [{ type: 'createNotification', config: {} }],
    });

    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await handlers.runScheduledWorkflows());
    expect(runs.map(r => r.matched)).toEqual([500, 100, 0]);
    expect(runs[2].alreadyActed).toBe(600);

    const logs = await prisma.workflowLog.findMany({ where: { workflowId: wf.id }, select: { recordId: true } });
    expect(new Set(logs.map(l => l.recordId)).size).toBe(600);
    expect(logs).toHaveLength(600);
  }, 60000);

  it('logs a record whose action fails, goes on to the next, and does not retry it while it matches', async () => {
    const account = await createTestAccount();
    await prisma.deal.create({ data: { name: 'One', value: 1, stage: 'Prospecting', accountId: account.id } });
    await prisma.deal.create({ data: { name: 'Two', value: 2, stage: 'Prospecting', accountId: account.id } });
    // updateField may not hand a record to someone: this action always throws.
    const wf = await makeWorkflow({
      trigger: 'scheduled',
      conditions: [{ field: 'stage', operator: 'equals', value: 'Prospecting' }],
      actions: [{ type: 'updateField', config: { field: 'ownerId', value: 'someone' } }],
    });

    const first = await handlers.runScheduledWorkflows();
    expect(first).toMatchObject({ matched: 2, actionErrors: 2, failed: 0 });
    const logs = await prisma.workflowLog.findMany({ where: { workflowId: wf.id } });
    expect(logs.map(l => [l.success, /not a field an automated update may set/.test(l.error)])).toEqual([[false, true], [false, true]]);

    const second = await handlers.runScheduledWorkflows();
    expect(second).toMatchObject({ matched: 0, actionErrors: 0, alreadyActed: 2 });
    expect(await prisma.workflowLog.count({ where: { workflowId: wf.id } })).toBe(2);
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
