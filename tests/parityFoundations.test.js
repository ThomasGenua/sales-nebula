const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestUser, createTestDeal, createTestProduct, createTestAccount, authHeader } = require('./setup');
const { normalizeValues, saveValues } = require('../src/services/customObjectValues');
const { refreshForecast } = require('../src/services/forecasting');
const { updateRecord } = require('../src/services/recordWrites');
const { drainIndex } = require('../src/services/searchIndexing');
const { flowProblem, startFlow, resumeDueFlows } = require('../src/services/flowEngine');
let app, prisma, user, token;
beforeAll(async () => { ({ app, prisma } = await setup()); });
afterAll(teardown);
beforeEach(async () => { await cleanDatabase(); ({ user, token } = await createTestUser()); });

test('custom values reject malformed types, unknown fields and invalid dates', () => {
  const fields = [
    { apiName: 'n', label: 'Amount', type: 'Number', required: true },
    { apiName: 'd', label: 'Date', type: 'Date' },
    { apiName: 'b', label: 'Enabled', type: 'Checkbox' },
  ];
  expect(normalizeValues(fields, { n: false, d: '2031-02-31', b: 'yes', injected: 1 }).errors).toHaveLength(4);
  expect(normalizeValues(fields, { n: '0', b: 'false' }).data).toEqual({ n: 0, b: false });
});

test('custom object validation is enforced on writes, imports and concurrent unique values', async () => {
  const obj = await prisma.customObject.create({ data: { label: 'Widget', pluralLabel: 'Widgets', apiName: 'Widget__c', createdById: user.id,
    fields: { create: [{ apiName: 'code', label: 'Code', type: 'Text', required: true, unique: true }] } } });
  const path = '/api/custom-objects/' + obj.id + '/records';
  expect((await request(app).post(path).set(authHeader(token)).send({ data: {} })).status).toBe(400);
  const results = await Promise.all([saveValues(prisma, obj.id, { code: 'A' }, user.id), saveValues(prisma, obj.id, { code: 'A' }, user.id)]);
  expect(results.filter(r => r.record)).toHaveLength(1);
  const record = results.find(r => r.record).record;
  expect((await request(app).put(path + '/' + record.id).set(authHeader(token)).send({ data: { code: '' } })).status).toBe(400);
  const imported = await request(app).post(path + '/import').set(authHeader(token)).send({ records: [{ code: 'A' }, { code: 'B' }, {}] });
  expect(imported.body).toMatchObject({ imported: 1, errors: 2 });
});

test('forecast refresh removes departed deals, retains overrides, and snapshots history', async () => {
  const f = await prisma.forecast.create({ data: { name: 'Test', period: '2031', periodStart: new Date('2031-01-01'), periodEnd: new Date('2031-12-31'), userId: user.id } });
  const keep = await createTestDeal(user.id, { closeDate: new Date('2031-02-01'), stage: 'Proposal', value: 200 });
  const leave = await createTestDeal(user.id, { closeDate: new Date('2031-02-01'), stage: 'Proposal', value: 500 });
  await refreshForecast(prisma, f.id);
  await prisma.forecastItem.updateMany({ where: { forecastId: f.id, dealId: keep.id }, data: { category: 'Commit', overrideAmount: 300 } });
  await prisma.deal.update({ where: { id: leave.id }, data: { closeDate: new Date('2032-02-01') } });
  await refreshForecast(prisma, f.id);
  expect(await prisma.forecastItem.count({ where: { forecastId: f.id } })).toBe(1);
  expect(await prisma.forecast.findUnique({ where: { id: f.id } })).toMatchObject({ commit: 300, pipeline: 300 });
  expect(await prisma.forecastSnapshot.count({ where: { forecastId: f.id } })).toBe(2);
});

test('duplicate blocking applies to updates, excluding the current record', async () => {
  const first = await createTestDeal(user.id, { name: 'First' });
  const second = await createTestDeal(user.id, { name: 'Second' });
  await prisma.duplicateRule.create({ data: { name: 'Unique name', module: 'deals', active: true, action: 'block', threshold: 100, matchFields: [{ field: 'name', weight: 100 }] } });
  await expect(updateRecord(prisma, 'deals', second.id, { name: first.name }, { userId: user.id })).rejects.toMatchObject({ status: 409 });
  await expect(updateRecord(prisma, 'deals', first.id, { name: first.name }, { userId: user.id })).resolves.toHaveProperty('record');
});

test('record writes automatically queue searchable changes', async () => {
  const deal = await createTestDeal(user.id, { name: 'Old title' });
  await updateRecord(prisma, 'deals', deal.id, { name: 'Nebula searchable' }, { userId: user.id });
  expect(await prisma.searchIndexQueue.count()).toBeGreaterThan(0);
  await updateRecord(prisma, 'deals', deal.id, { name: 'Nebula searchable' }, { userId: user.id });
  expect((await drainIndex(prisma)).failed).toBe(0);
  expect(await prisma.searchIndex.findFirst({ where: { recordId: deal.id } })).toMatchObject({ title: 'Nebula searchable' });
});

test('quote writes enforce configured prices and block unapproved discount acceptance', async () => {
  const product = await createTestProduct({ price: 100 });
  const account = await createTestAccount();
  await prisma.priceRule.create({ data: { name: 'Contract price', conditions: [{ field: 'quantity', operator: 'gte', value: 2 }], actions: [{ type: 'setPrice', value: 80 }] } });
  const created = await request(app).post('/api/quotes').set(authHeader(token)).send({ name: 'Priced', accountId: account.id, items: [{ productId: product.id, quantity: 2, unitPrice: 100, discount: 40 }] });
  expect(created.status).toBe(201);
  expect(created.body.total).toBe(120);
  expect(created.body.items[0].unitPrice).toBe(80);
  const process = await prisma.approvalProcess.create({ data: { name: 'Discount review', module: 'quotes' } });
  await prisma.cpqApprovalRule.create({ data: { name: 'Large discount', conditions: [{ field: 'discountPercent', operator: 'gt', value: 10 }], approvers: { processId: process.id } } });
  const accepted = await request(app).post('/api/quotes/' + created.body.id + '/accept').set(authHeader(token)).send({});
  expect(accepted.status).toBe(400);
  expect(accepted.body.code).toBe('QUOTE_APPROVAL_REQUIRED');
  const approval = await prisma.approvalRequest.create({ data: { processId: process.id, module: 'quotes', recordId: created.body.id, submittedById: user.id, status: 'Approved', completedAt: new Date() } });
  const finalAction = await require('../src/services/approvals').runFinalAction(prisma, approval, { ...process, finalApprovalAction: 'updateField', finalApprovalConfig: { field: 'status', value: 'Accepted' } }, 'Approved');
  expect(finalAction).toMatchObject({ ok: true });
  const approved = await request(app).post('/api/quotes/' + created.body.id + '/accept').set(authHeader(token)).send({});
  expect(approved.status).toBe(200);
  const order = await request(app).post('/api/orders/from-quote/' + created.body.id).set(authHeader(token)).send({});
  expect(order.status).toBe(201);
  expect(order.body.total).toBe(120);
  const changed = await request(app).put('/api/quotes/' + created.body.id).set(authHeader(token)).send({ discount: 10 });
  expect(changed.status).toBe(200);
  expect(changed.body.status).toBe('Draft');
  expect((await request(app).post('/api/quotes/' + created.body.id + '/accept').set(authHeader(token)).send({})).status).toBe(400);
});

test('territory rules reconcile account changes while preserving manual assignments', async () => {
  const account = await createTestAccount({ name: 'Territory customer', industry: 'Technology' });
  const territory = await prisma.territory.create({ data: { name: 'Technology', rules: { create: { field: 'industry', operator: 'equals', value: 'Technology' } } } });
  await updateRecord(prisma, 'accounts', account.id, { industry: 'Technology' }, { userId: user.id });
  expect(await prisma.territoryAccount.findFirst({ where: { accountId: account.id } })).toMatchObject({ territoryId: territory.id, assignedBy: 'rule' });
  await updateRecord(prisma, 'accounts', account.id, { industry: 'Finance' }, { userId: user.id });
  expect(await prisma.territoryAccount.count()).toBe(0);
  await prisma.territoryAccount.create({ data: { accountId: account.id, territoryId: territory.id, assignedBy: 'manual' } });
  await updateRecord(prisma, 'accounts', account.id, { industry: 'Healthcare' }, { userId: user.id });
  expect(await prisma.territoryAccount.count()).toBe(1);
});

test('flows branch, wait and resume once without repeating completed actions', async () => {
  const deal = await createTestDeal(user.id, { name: 'Before flow', value: 100 });
  const flow = await prisma.flowDefinition.create({ data: {
    name: 'Decision and wait', type: 'AutoLaunched', module: 'deals', createdById: user.id,
    canvas: { nodes: [
      { id: 'start', type: 'start' },
      { id: 'decision', type: 'decision', config: { conditions: [{ field: 'value', operator: 'gt', value: 50 }] } },
      { id: 'action', type: 'action', config: { action: { type: 'createNotification', config: { title: 'Exactly once' } } } },
      { id: 'wait', type: 'wait', config: { minutes: 1 } },
      { id: 'end', type: 'end' },
    ], edges: [
      { source: 'start', target: 'decision' },
      { source: 'decision', target: 'action', condition: 'true' },
      { source: 'decision', target: 'end', condition: 'false' },
      { source: 'action', target: 'wait' }, { source: 'wait', target: 'end' },
    ] },
  } });
  expect(flowProblem(flow)).toBeNull();
  const run = await startFlow(prisma, flow, deal, user.id);
  expect(run.status).toBe('Paused');
  expect(await prisma.notification.count({ where: { title: 'Exactly once' } })).toBe(1);
  const future = await prisma.flowRun.create({ data: { flowId: flow.id, triggerModule: 'deals', triggerRecordId: deal.id, status: 'Paused', context: { ...run.context, resumeAt: new Date(Date.now() + 86400000).toISOString() }, log: [] } });
  await prisma.flowRun.update({ where: { id: run.id }, data: { context: { ...run.context, resumeAt: new Date(Date.now() - 60000).toISOString() } } });
  await Promise.all([resumeDueFlows(prisma), resumeDueFlows(prisma)]);
  expect((await prisma.flowRun.findUnique({ where: { id: run.id } })).status).toBe('Completed');
  expect((await prisma.flowRun.findUnique({ where: { id: future.id } })).status).toBe('Paused');
  expect(await prisma.notification.count({ where: { title: 'Exactly once' } })).toBe(1);
  const cyclic = { ...flow, canvas: { ...flow.canvas, edges: flow.canvas.edges.map(e => e.source === 'wait' ? { ...e, target: 'start' } : e) } };
  expect(flowProblem(cyclic)).toMatch(/cycles/);
});
