const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestUser, createTestRole, createTestDeal, authHeader } = require('./setup');
const { compareSnapshots } = require('../src/services/forecastComparison');
let app, prisma, user, token;
beforeAll(async () => { ({ app, prisma } = await setup()); });
afterAll(teardown);
beforeEach(async () => { await cleanDatabase(); ({ user, token } = await createTestUser()); });

test('hidden fields are removed from records and relation reads and cannot be filtered or overwritten', async () => {
  const role = await createTestRole('Restricted', [{ module: 'deals', level: 'full' }, { module: 'accounts', level: 'full' }]);
  const rep = await createTestUser({ email: 'restricted@test.com', roleId: role.id });
  const deal = await createTestDeal(rep.user.id, { value: 9876, name: 'Visible name' });
  await prisma.fieldPermission.create({ data: { roleId: role.id, module: 'deals', field: 'value', visible: false, editable: false } });
  const response = await request(app).get('/api/deals/' + deal.id).set(authHeader(rep.token));
  expect(response.status).toBe(200);
  expect(response.body.value).toBeUndefined();
  const denied = await request(app).put('/api/deals/' + deal.id).set(authHeader(rep.token)).send({ value: 1 });
  expect(denied.status).toBe(403);
  expect((await prisma.deal.findUnique({ where: { id: deal.id } })).value).toBe(9876);
  const db = app.locals.prisma;
  const { context } = require('../src/services/fieldSecurity');
  await context.run({ req: { user: { ...rep.user, role }, userId: rep.user.id }, policyDb: prisma }, async () => {
    await expect(db.deal.count({ where: { value: { gt: 0 } } })).rejects.toMatchObject({ status: 403 });
    await expect(db.deal.aggregate({ _sum: { value: true } })).rejects.toMatchObject({ status: 403 });
    await expect(db.deal.groupBy({ by: ['value'], _count: true })).rejects.toMatchObject({ status: 403 });
    await expect(db.deal.findMany({ distinct: ['value'] })).rejects.toMatchObject({ status: 403 });
  });
});

test('record types enforce role assignment, layout required fields and allowed stages on API writes', async () => {
  const layout = await prisma.pageLayout.create({ data: { module: 'deals', name: 'Enterprise', sections: [{ label: 'Qualification', fields: [{ name: 'nextStep', required: true }] }] } });
  const type = await prisma.recordType.create({ data: { module: 'deals', name: 'Enterprise', isDefault: true, layoutId: layout.id, allowedValues: { stage: ['Proposal'] } } });
  const post = body => request(app).post('/api/deals').set(authHeader(token)).send(body);
  expect((await post({ name: 'Missing', stage: 'Proposal' })).status).toBe(400);
  expect((await post({ name: 'Invalid implicit stage', nextStep: 'Call' })).status).toBe(400);
  expect((await post({ name: 'Wrong stage', stage: 'Discovery', nextStep: 'Call' })).status).toBe(400);
  const saved = await post({ name: 'Qualified', stage: 'Proposal', nextStep: 'Demo' });
  expect(saved.status).toBe(201);
  expect(saved.body.recordTypeId).toBe(type.id);
  expect((await request(app).put('/api/deals/' + saved.body.id).set(authHeader(token)).send({ nextStep: '' })).status).toBe(400);
});

test('Studio fields enforce hidden and read-only policy through read and save endpoints', async () => {
  const role = await createTestRole('Field-restricted rep', [{ module: 'deals', level: 'full' }]);
  const rep = await createTestUser({ email: 'studio-reader@test.com', roleId: role.id });
  const deal = await createTestDeal(rep.user.id);
  const secret = await prisma.customFieldDef.create({ data: { module: 'deals', name: 'private_margin', label: 'Private margin', fieldType: 'number' } });
  const locked = await prisma.customFieldDef.create({ data: { module: 'deals', name: 'contract_code', label: 'Contract code', fieldType: 'text' } });
  await prisma.studioFieldValue.createMany({ data: [{ fieldId: secret.id, module: 'deals', recordId: deal.id, value: 73 }, { fieldId: locked.id, module: 'deals', recordId: deal.id, value: 'LOCKED' }] });
  await prisma.fieldPermission.createMany({ data: [{ roleId: role.id, module: 'deals', field: 'custom.private_margin', visible: false, editable: false }, { roleId: role.id, module: 'deals', field: 'custom.contract_code', visible: true, editable: false }] });
  const read = await request(app).get('/api/studio/values/deals/' + deal.id).set(authHeader(rep.token));
  expect(read.status).toBe(200);
  expect(read.body.map(f => f.name)).toEqual(['contract_code']);
  expect(read.body[0]).toMatchObject({ value: 'LOCKED', readOnly: true });
  const save = await request(app).put('/api/studio/values/deals/' + deal.id).set(authHeader(rep.token)).send({ values: { contract_code: 'changed' } });
  expect(save.status).toBe(400);
  expect((await prisma.studioFieldValue.findFirst({ where: { fieldId: locked.id } })).value).toBe('LOCKED');
});

test('snapshot comparison handles overrides and additions without exposing inaccessible history', () => {
  const before = { id: 'a', currency: 'USD', items: [{ dealId: 'one', category: 'Pipeline', amount: 100 }, { dealId: 'secret', category: 'Commit', amount: 99999 }] };
  const after = { id: 'b', currency: 'USD', items: [{ dealId: 'one', category: 'Commit', amount: 200, overrideAmount: 150 }, { dealId: 'two', category: 'Pipeline', amount: 40 }] };
  const result = compareSnapshots(before, after, [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }]);
  expect(result.changes.map(c => c.dealId)).toEqual(['one', 'two']);
  expect(result.changes[0].delta).toBe(50);
  expect(result.deltas.Commit).toBe(150);
  expect(() => compareSnapshots(before, { ...after, currency: 'CAD' }, [])).toThrow('different currencies');
});

test('custom-object roles govern records, search, reports and automation', async () => {
  const object = await prisma.customObject.create({ data: { label: 'Equipment', apiName: 'equipment__c', pluralLabel: 'Equipment', createdById: user.id,
    fields: { create: [{ label: 'Name', apiName: 'name__c', type: 'Text' }, { label: 'Cost', apiName: 'cost__c', type: 'Number' }] } } });
  const role = await createTestRole('Object reader', [{ module: 'custom:' + object.id, level: 'read' }, { module: 'reports', level: 'read' }]);
  const rep = await createTestUser({ email: 'object-reader@test.com', roleId: role.id });
  const flow = await prisma.flowDefinition.create({ data: { name: 'Set cost', module: 'custom:' + object.id, type: 'RecordTriggered', triggerType: 'create', status: 'Active', createdById: user.id, triggerConditions: [], canvas: {
    nodes: [{ id: 'start', type: 'start' }, { id: 'set', type: 'action', config: { action: { type: 'updateField', config: { field: 'cost__c', value: 25 } } } }, { id: 'end', type: 'end' }], edges: [{ source: 'start', target: 'set' }, { source: 'set', target: 'end' }],
  } } });
  const made = await request(app).post('/api/custom-objects/' + object.id + '/records').set(authHeader(token)).send({ data: { name__c: 'Lathe' } });
  expect(made.status).toBe(201);
  expect((await prisma.customRecord.findUnique({ where: { id: made.body.id } })).data.cost__c).toBe(25);
  expect((await prisma.flowRun.findFirst({ where: { flowId: flow.id } })).status).toBe('Completed');
  expect((await request(app).get('/api/custom-objects/' + object.id + '/records').set(authHeader(rep.token))).status).toBe(200);
  expect((await request(app).post('/api/custom-objects/' + object.id + '/records').set(authHeader(rep.token)).send({ data: {} })).status).toBe(403);
  const report = await request(app).post('/api/reports/execute').set(authHeader(rep.token)).send({ module: 'custom:' + object.id, reportType: 'summary', columns: [], filters: [], groupBy: [], sortBy: [], aggregations: [{ field: 'cost__c', function: 'sum' }] });
  expect(report.status).toBe(200);
  expect(report.body.totals.data._sum.cost__c).toBe(25);
});

test('matrix pivots, dashboards and report schedules use saved definitions', async () => {
  await createTestDeal(user.id, { name: 'Report deal', stage: 'Proposal', value: 125, currency: 'USD' });
  const report = await prisma.report.create({ data: { name: 'Pipeline matrix', module: 'deals', reportType: 'matrix', columns: [], groupBy: ['stage', 'currency'], aggregations: [{ field: 'value', function: 'sum' }], createdById: user.id } });
  const result = await request(app).post('/api/reports/' + report.id + '/run').set(authHeader(token)).send({});
  // The public execute route and dashboards share exactly the same engine.
  const matrix = await request(app).post('/api/reports/execute').set(authHeader(token)).send(report);
  expect(matrix.status).toBe(200);
  expect(matrix.body.matrix.cells[0]._sum.value).toBe(125);
  const dashboard = await prisma.analyticsDashboard.create({ data: { name: 'Revenue', createdById: user.id, layout: [{ config: { reportId: report.id } }] } });
  const run = await request(app).post('/api/analytics/dashboards/' + dashboard.id + '/run').set(authHeader(token)).send({});
  expect(run.status).toBe(200);
  expect(run.body.widgets[0].result.totalCount).toBe(1);
  const schedule = await request(app).post('/api/reports/' + report.id + '/schedule').set(authHeader(token)).send({ cron: '0 8 * * *' });
  expect(schedule.status).toBe(201);
  expect(schedule.body.recipients).toEqual([user.id]);
  const mailer = jest.spyOn(require('../src/services/mailer'), 'sendEmail').mockResolvedValue({ delivered: true });
  try {
    await prisma.reportSchedule.update({ where: { id: schedule.body.id }, data: { nextRun: new Date(0) } });
    await require('../src/services/reportDelivery').deliverDue(prisma);
    expect(mailer).toHaveBeenCalledTimes(1);
    expect(mailer.mock.calls[0][1].to).toBe(user.email);
  } finally { mailer.mockRestore(); }
});

test('order line changes apply currency discounts and roll back invalid mutations', async () => {
  const account = await prisma.account.create({ data: { name: 'Buyer', ownerId: user.id } });
  const product = await prisma.product.create({ data: { name: 'Machine', sku: 'MACHINE-TEST', price: 100 } });
  const order = await prisma.order.create({ data: { orderNumber: 'ORDER-TEST', accountId: account.id, ownerId: user.id, status: 'Draft' } });
  const add = body => request(app).post('/api/orders/' + order.id + '/items').set(authHeader(token)).send(body);
  const saved = await add({ productId: product.id, quantity: 2, unitPrice: 100, discount: 10 });
  expect(saved.status).toBe(201);
  expect(saved.body.total).toBe(190);
  expect((await add({ productId: product.id, quantity: -1, unitPrice: 100 })).status).toBe(400);
  expect(await prisma.orderItem.count({ where: { orderId: order.id } })).toBe(1);
  const removed = await request(app).delete('/api/orders/' + order.id + '/items/' + saved.body.items[0].id).set(authHeader(token));
  expect(removed.status).toBe(200);
  expect(removed.body.total).toBe(0);
});

test('selection adds required products once and filters reject excluded products', async () => {
  const { selectProducts } = require('../src/services/productSelection');
  const product = await prisma.product.create({ data: { name: 'Warranty', sku: 'WARRANTY', price: 20 } });
  await prisma.productRule.create({ data: { name: 'Include warranty', type: 'Selection', scope: 'Quote', conditions: [], actions: [{ type: 'selectProduct', productId: product.id, quantity: 1 }] } });
  const lines = await selectProducts(prisma, {}, []);
  expect(lines).toHaveLength(1);
  expect(await selectProducts(prisma, {}, lines)).toHaveLength(1);
  await prisma.productRule.create({ data: { name: 'Exclude warranty', type: 'Filter', scope: 'Quote', conditions: [], actions: [{ type: 'excludeProduct', productId: product.id }] } });
  await expect(selectProducts(prisma, {}, lines)).rejects.toMatchObject({ status: 400 });
});

test('scheduled starts are claimed once and related actions update only declared relations', async () => {
  const account = await prisma.account.create({ data: { name: 'Related account', ownerId: user.id } });
  await createTestDeal(user.id, { name: 'Scheduled', accountId: account.id });
  const flow = await prisma.flowDefinition.create({ data: { name: 'Scheduled account update', module: 'deals', type: 'Scheduled', status: 'Active', scheduleMinutes: 60, nextRun: new Date(0), createdById: user.id, triggerConditions: [], canvas: {
    nodes: [{ id: 'start', type: 'start' }, { id: 'set', type: 'action', config: { action: { type: 'updateRelated', config: { relation: 'account', field: 'industry', value: 'Manufacturing' } } } }, { id: 'end', type: 'end' }], edges: [{ source: 'start', target: 'set' }, { source: 'set', target: 'end' }],
  } } });
  await Promise.all([require('../src/services/scheduledFlows').enqueueDue(prisma), require('../src/services/scheduledFlows').enqueueDue(prisma)]);
  expect(await prisma.flowRun.count({ where: { flowId: flow.id } })).toBe(1);
  const run = await prisma.flowRun.findFirst({ where: { flowId: flow.id } });
  const result = await require('../src/services/flowEngine').resumeFlow(prisma, run.id);
  expect(result.status).toBe('Completed');
  expect((await prisma.account.findUnique({ where: { id: account.id } })).industry).toBe('Manufacturing');
});
