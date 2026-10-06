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

let app, prisma, role, admin;

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  role = await createTestRole('Admin');
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

describe('Import, the bulk API, mass actions and mobile sync', () => {
  test('an import runs each row through the assignment and validation rules and the create workflows', async () => {
    const ana = (await createTestUser({ email: 'ana@paths.test', roleId: role.id })).user;
    const ben = (await createTestUser({ email: 'ben@paths.test', roleId: role.id })).user;
    await prisma.assignmentRule.create({ data: { name: 'Spread leads', module: 'leads', type: 'round_robin', assignees: [ana.id, ben.id], active: true } });
    await prisma.validationRule.create({
      data: { name: 'No spam', module: 'leads', active: true, errorMessage: 'Spam is not a lead', condition: { field: 'company', operator: 'equals', value: 'Spam Inc' } },
    });
    const onCreate = await ruleOn('leads', 'create');

    const res = await post('/api/import/execute', {
      module: 'leads',
      records: [
        { firstName: 'Ada', lastName: 'One', company: 'Acme', email: 'ada@acme.test' },
        { firstName: 'Sam', lastName: 'Spam', company: 'Spam Inc', email: 'sam@spam.test' },
        { firstName: 'Bo', lastName: 'Two', company: 'Bolt', email: 'bo@bolt.test' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, skipped: 1 });
    expect(res.body.errors).toEqual([{ row: 2, error: 'Spam is not a lead' }]);
    const leads = await prisma.lead.findMany({ orderBy: { firstName: 'asc' } });
    expect(leads.map(l => [l.firstName, l.ownerId])).toEqual([['Ada', ana.id], ['Bo', ben.id]]);
    expect(await firedFor(onCreate)).toEqual(leads.map(l => l.id).sort());
    expect(await prisma.auditLog.count({ where: { module: 'leads', action: 'create', details: 'Created lead (import)' } })).toBe(2);
  });

  test('a bulk API insert numbers each case and runs its rules; a delete puts them in the recycle bin', async () => {
    const onCreate = await ruleOn('cases', 'create');

    const inserted = await post('/api/bulk/insert', { module: 'cases', records: [{ subject: 'First' }, { subject: 'Second' }, { priority: 'High' }] });

    // The third has no subject, which a case needs: it fails alone.
    expect(inserted.body).toMatchObject({ success: 2, failed: 1 });
    expect(inserted.body.errors).toEqual([{ index: 2, error: 'Validation failed (subject: required)' }]);
    const cases = await prisma.case.findMany({ orderBy: { subject: 'asc' } });
    expect(cases.every(c => /^CS-\d+$/.test(c.caseNumber))).toBe(true);
    expect(await firedFor(onCreate)).toEqual(cases.map(c => c.id).sort());

    const removed = await post('/api/bulk/delete', { module: 'cases', ids: cases.map(c => c.id) });

    expect(removed.body.deleted).toBe(2);
    expect(await prisma.case.count({ where: { deletedAt: null } })).toBe(0);
    expect(await prisma.recycleBinItem.count({ where: { module: 'cases' } })).toBe(2);
  });

  test('a mass update closes cases as an edit does, with the status change rules', async () => {
    const opened = [];
    for (const n of [1, 2]) opened.push(await prisma.case.create({ data: { subject: `Case ${n}`, caseNumber: `CS-800${n}`, status: 'New' } }));
    const onMove = await ruleOn('cases', 'statusChange', [{ field: 'status', operator: 'changedTo', value: 'Closed' }]);

    const res = await post('/api/mass-actions/update', { module: 'cases', recordIds: opened.map(c => c.id), updates: { status: 'Closed' } });

    expect(res.body).toMatchObject({ success: true, updated: 2 });
    const closed = await prisma.case.findMany();
    expect(closed.every(c => c.closedAt instanceof Date)).toBe(true);
    expect(await prisma.caseStatusHistory.count({ where: { toStatus: 'Closed' } })).toBe(2);
    expect(await firedFor(onMove)).toEqual(opened.map(c => c.id).sort());
  });

  test('a mass reassignment runs the update rules for each record', async () => {
    const other = (await createTestUser({ email: 'other@paths.test', roleId: role.id })).user;
    const account = await createTestAccount();
    const deal = await prisma.deal.create({ data: { name: 'Mine', value: 1, stage: 'Prospecting', accountId: account.id, ownerId: admin.user.id } });
    const onUpdate = await ruleOn('deals', 'update', [{ field: 'ownerId', operator: 'changed' }]);

    const res = await post('/api/mass-actions/reassign', { module: 'deals', recordIds: [deal.id], newOwnerId: other.id });

    expect(res.body.reassigned).toBe(1);
    expect(await firedFor(onUpdate)).toEqual([deal.id]);
  });

  test('a mobile sync saves offline changes as online ones are: rules, stage history and workflows', async () => {
    const account = await createTestAccount();
    const onCreate = await ruleOn('deals', 'create');

    const created = await post('/api/mobile/sync', { changes: [{ module: 'deals', action: 'create', localId: 'l1', data: { name: 'Offline deal', value: 5, stage: 'Prospecting', accountId: account.id } }] });
    const serverId = created.body.results[0].serverId;
    expect(created.body.results[0].status).toBe('created');

    const moved = await post('/api/mobile/sync', { changes: [{ module: 'deals', action: 'update', id: serverId, data: { stage: 'Negotiation' } }] });

    expect(moved.body.results[0].status).toBe('updated');
    expect(await firedFor(onCreate)).toEqual([serverId]);
    const history = await prisma.dealStageHistory.findMany({ where: { dealId: serverId } });
    expect(history.map(h => [h.fromStage, h.toStage])).toEqual([['Prospecting', 'Negotiation']]);
    expect((await prisma.deal.findUnique({ where: { id: serverId } })).ownerId).toBe(admin.user.id);
  });
});
