/**
 * Every path that writes a CRUD module's records runs the same rules
 * (services/recordWrites.js): the module's own hooks, validation, duplicate
 * and assignment rules before the write; audit, workflows and webhooks after
 * it. They were the CRUD router's create and edit alone, so a bulk update, an
 * import, a lead conversion or a case opened by email skipped every one.
 */
const request = require('supertest');
const {
  setup, teardown, cleanDatabase, createTestRole, createTestUser, createTestAccount, authHeader,
} = require('./setup');

let app, prisma, admin;

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  const role = await createTestRole('Admin');
  admin = await createTestUser({ email: 'admin@paths.test', roleId: role.id });
});

/** A rule with no actions: each run is logged against the record it ran on. */
const ruleOn = (module, trigger, conditions = []) => prisma.workflow.create({
  data: { name: `${module} ${trigger}`, module, trigger, conditions, actions: [], active: true },
});
const firedFor = async workflow => (await prisma.workflowLog.findMany({
  where: { workflowId: workflow.id, success: true }, select: { recordId: true },
})).map(log => log.recordId).sort();

const post = (path, body) => request(app).post(path).set(authHeader(admin.token)).send(body);

describe('CRUD bulk routes', () => {
  test('a bulk update runs each record through its rules, its stage history and the workflows', async () => {
    const account = await createTestAccount();
    const deals = [];
    for (const value of [100, 500, 900]) {
      deals.push(await prisma.deal.create({ data: { name: `Deal ${value}`, value, stage: 'Prospecting', accountId: account.id } }));
    }
    const onUpdate = await ruleOn('deals', 'update');
    const onMove = await ruleOn('deals', 'statusChange');
    await prisma.validationRule.create({
      data: {
        name: 'Small deals are not won', module: 'deals', active: true, errorMessage: 'Too small to close as won',
        condition: { and: [{ field: 'stage', operator: 'equals', value: 'Closed Won' }, { field: 'value', operator: 'lt', value: 200 }] },
      },
    });

    const res = await post('/api/deals/bulk-update', { ids: deals.map(d => d.id), data: { stage: 'Closed Won' } });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    // The rule refused one, which is left as it was and reported.
    expect(res.body.failed).toEqual([{ id: deals[0].id, error: 'Too small to close as won', code: 'VALIDATION_RULE' }]);
    expect((await prisma.deal.findUnique({ where: { id: deals[0].id } })).stage).toBe('Prospecting');

    const moved = [deals[1].id, deals[2].id].sort();
    expect(await firedFor(onUpdate)).toEqual(moved);
    expect(await firedFor(onMove)).toEqual(moved);
    const history = await prisma.dealStageHistory.findMany({ select: { dealId: true, fromStage: true, toStage: true, changedById: true } });
    expect(history.map(h => h.dealId).sort()).toEqual(moved);
    expect(history.every(h => h.fromStage === 'Prospecting' && h.toStage === 'Closed Won' && h.changedById === admin.user.id)).toBe(true);
  });

  test('a bulk update stamps a closed case as an edit does, and records its status change', async () => {
    const opened = await prisma.case.create({ data: { subject: 'Printer on fire', caseNumber: 'CS-9001', status: 'New' } });

    const res = await post('/api/cases/bulk-update', { ids: [opened.id], data: { status: 'Closed' } });

    expect(res.body.updated).toBe(1);
    const closed = await prisma.case.findUnique({ where: { id: opened.id } });
    expect(closed.closedAt).toBeInstanceOf(Date);
    const history = await prisma.caseStatusHistory.findMany({ where: { caseId: opened.id } });
    expect(history.map(h => [h.fromStatus, h.toStatus])).toEqual([['New', 'Closed']]);
  });
});
