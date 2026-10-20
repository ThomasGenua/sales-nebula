const request = require('supertest');
const crypto = require('crypto');
const { setup, teardown, cleanDatabase, createTestUser, createTestRole, createTestDeal, createTestAccount, createTestContact, authHeader } = require('./setup');
const { createRecord, updateRecord } = require('../src/services/recordWrites');
let app, prisma, user, token;
beforeAll(async () => { ({ app, prisma } = await setup()); });
afterAll(teardown);
beforeEach(async () => { await cleanDatabase(); ({ user, token } = await createTestUser()); });
const get = path => request(app).get('/api/' + path).set(authHeader(token));
const post = (path, body) => request(app).post('/api/' + path).set(authHeader(token)).send(body);

test('stage requirements run on central writes and pipeline history records exact changes', async () => {
  const deal = await createTestDeal(user.id, { closeDate: new Date('2031-01-01'), value: 50 });
  expect((await request(app).put('/api/sales-operations/requirements').set(authHeader(token)).send({ Proposal: ['need', 'nextStep'] })).status).toBe(200);
  await expect(updateRecord(prisma, 'deals', deal.id, { stage: 'Proposal' }, { userId: user.id })).rejects.toMatchObject({ status: 400 });
  await updateRecord(prisma, 'deals', deal.id, { stage: 'Proposal', qualification: { need: true }, nextStep: 'Demo', value: 150, closeDate: new Date('2031-02-01') }, { userId: user.id });
  const response = await get('sales-operations/pipeline-changes');
  expect(response.status).toBe(200);
  expect(response.body.total).toBe(3);
  expect(response.body.data.find(c => c.field === 'closeDate').slipped).toBe(true);
  expect(response.body.data.find(c => c.field === 'value')).toMatchObject({ oldValue: '50', newValue: '150' });
  await expect(updateRecord(prisma, 'deals', deal.id, { qualification: { need: 'yes' } }, { userId: user.id })).rejects.toMatchObject({ status: 400 });
});

test('renewal opportunity creation is unique under concurrent requests and reminders persist', async () => {
  const account = await createTestAccount({ ownerId: user.id });
  const contract = await prisma.contract.create({ data: { contractNumber: 'REN-1', name: 'Annual plan', accountId: account.id, status: 'Activated', startDate: new Date('2025-01-01'), endDate: new Date(), value: 400, ownerId: user.id } });
  const responses = await Promise.all([post(`sales-operations/renewals/${contract.id}/opportunity`, {}), post(`sales-operations/renewals/${contract.id}/opportunity`, {})]);
  expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
  expect(await prisma.deal.count({ where: { renewalContractId: contract.id } })).toBe(1);
  const reminder = await post(`sales-operations/renewals/${contract.id}/reminder`, { dueDate: '2031-01-01' });
  expect(reminder.status).toBe(201);
  expect(reminder.body).toMatchObject({ assignedId: user.id, accountId: account.id, type: 'Task' });
  const list = await get('sales-operations/renewals');
  expect(list.status).toBe(200);
  expect(list.body.data[0].opportunity.id).toBeTruthy();
  const renewal = responses.find(r => r.status === 201).body;
  await updateRecord(prisma, 'deals', renewal.id, { renewalContractId: null }, { userId: user.id });
  expect((await prisma.deal.findUnique({ where: { id: renewal.id } })).renewalContractId).toBe(contract.id);
});

test('webhook retry requires a failed delivery belonging to an enabled webhook', async () => {
  const service = require('../src/services/webhooks');
  const send = jest.spyOn(service, 'sendToWebhook').mockImplementation(() => {});
  try {
    const webhook = await prisma.webhook.create({ data: { name: 'Test', url: 'https://example.com/hook', events: ['deal.updated'], active: true, createdById: user.id } });
    const log = await prisma.webhookLog.create({ data: { webhookId: webhook.id, event: 'deal.updated', payload: { id: 'example' }, success: false } });
    expect((await post(`sales-operations/webhooks/${webhook.id}/retry/${log.id}`, {})).status).toBe(202);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][2]).toBe('deal.updated');
    await prisma.webhook.update({ where: { id: webhook.id }, data: { active: false } });
    expect((await post(`sales-operations/webhooks/${webhook.id}/retry/${log.id}`, {})).status).toBe(409);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await post(`sales-operations/webhooks/${webhook.id}/retry/${crypto.randomUUID()}`, {})).status).toBe(404);
  } finally { send.mockRestore(); }
});

test('duplicate merge rolls all relation transfers back when a later transfer fails', async () => {
  const master = await createTestAccount({ ownerId: user.id });
  const source = await createTestAccount({ ownerId: user.id });
  const child = await createTestContact({ accountId: source.id, ownerId: user.id });
  const task = await prisma.activity.create({ data: { type: 'Task', subject: 'Keep relationship', accountId: source.id } });
  // A real database rejection after the activity transfer exercises rollback.
  // IDs here are generated UUIDs, never user input.
  await prisma.$executeRawUnsafe(`ALTER TABLE "Contact" ADD CONSTRAINT "test_merge_rejection" CHECK ("accountId" <> '${master.id}')`);
  try {
    const response = await post('duplicates/merge/accounts', { masterId: master.id, mergeIds: [source.id] });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await prisma.activity.findUnique({ where: { id: task.id } })).accountId).toBe(source.id);
    expect((await prisma.account.findUnique({ where: { id: source.id } })).deletedAt).toBeNull();
  } finally { await prisma.$executeRawUnsafe('ALTER TABLE "Contact" DROP CONSTRAINT "test_merge_rejection"'); }
  const success = await post('duplicates/merge/accounts', { masterId: master.id, mergeIds: [source.id] });
  expect(success.status).toBe(200);
  expect(success.body.mergedCount).toBe(1);
  expect((await prisma.contact.findUnique({ where: { id: child.id } })).accountId).toBe(master.id);
});

test('account 360 includes child activities and email but excludes private calendars', async () => {
  const account = await createTestAccount({ ownerId: user.id });
  const contact = await createTestContact({ accountId: account.id, ownerId: user.id });
  const deal = await createTestDeal(user.id, { accountId: account.id });
  await prisma.activity.create({ data: { subject: 'Child meeting', type: 'Meeting', contactId: contact.id, ownerId: user.id } });
  await prisma.email.create({ data: { subject: 'Child email', body: 'Hello', dealId: deal.id } });
  const other = await createTestUser();
  await prisma.calendarEvent.create({ data: { title: 'Private meeting', ownerId: other.user.id, accountId: account.id, visibility: 'Private', startAt: new Date(), endAt: new Date(Date.now() + 3600000) } });
  const result = await get(`sales-operations/accounts/${account.id}`);
  expect(result.status).toBe(200);
  expect(result.body.timeline.map(r => r.title)).toEqual(expect.arrayContaining(['Child meeting', 'Child email']));
  expect(result.body.timeline.map(r => r.title)).not.toContain('Private meeting');
  const expansion = await post(`sales-operations/accounts/${account.id}/expansion`, { value: 100, closeDate: '2031-03-01', currency: 'USD' });
  expect(expansion.status).toBe(201);
  expect(expansion.body).toMatchObject({ type: 'Expansion', accountId: account.id });
});

test('daily workspace keeps personal mailbox content private and resolves synced replies', async () => {
  const other = await createTestUser();
  const mine = await prisma.inboundEmailAccount.create({ data: { name: 'Mine', username: 'me@example.com', ownerId: user.id } });
  const theirs = await prisma.inboundEmailAccount.create({ data: { name: 'Theirs', username: 'other@example.com', ownerId: other.user.id } });
  await prisma.inboundEmailMessage.create({ data: { accountId: mine.id, fromEmail: 'buyer@example.com', subject: 'Waiting', threadKey: 'waiting' } });
  await prisma.inboundEmailMessage.create({ data: { accountId: theirs.id, fromEmail: 'private@example.com', subject: 'Private' } });
  await prisma.inboundEmailMessage.create({ data: { accountId: mine.id, fromEmail: 'buyer@example.com', subject: 'Answered', threadKey: 'answered', receivedAt: new Date('2020-01-01') } });
  await prisma.inboundEmailMessage.create({ data: { accountId: mine.id, fromEmail: 'me@example.com', direction: 'outbound', subject: 'Reply', threadKey: 'answered' } });
  const response = await get('sales-operations/workspace');
  expect(response.status).toBe(200);
  expect(response.body.unanswered.map(m => m.subject)).toEqual(['Waiting']);
  const ops = await get('sales-operations/integrations');
  expect(ops.status).toBe(200);
  expect(ops.body.mailboxes.map(m => m.name)).toEqual(['Mine']);
  expect(ops.body.mailboxes[0]).not.toHaveProperty('password');
});

test('data quality previews duplicates, applies validated cleanup and protects restricted modules', async () => {
  const first = await createTestContact({ email: 'same@example.com', phone: null, ownerId: user.id });
  const second = await createTestContact({ email: 'same@example.com', ownerId: user.id });
  const list = await get('sales-operations/quality/contacts');
  expect(list.status).toBe(200);
  expect(list.body.data.find(r => r.id === first.id).duplicates).toContainEqual({ id: second.id });
  expect((await post('sales-operations/quality/contacts/merge-preview', { masterId: first.id, sourceId: second.id })).status).toBe(200);
  const bulk = await post('sales-operations/quality/contacts/bulk', { ids: [first.id], field: 'phone', value: '555-0100' });
  expect(bulk.body.outcomes).toEqual([{ id: first.id, saved: true }]);
  expect((await prisma.contact.findUnique({ where: { id: first.id } })).phone).toBe('555-0100');
  expect((await post('sales-operations/quality/contacts/bulk', { ids: [first.id], field: 'ownerId', value: user.id })).status).toBe(400);
  const role = await createTestRole('Restricted', [{ module: 'deals', level: 'read' }]);
  const restricted = await createTestUser({ roleId: role.id });
  const denied = await request(app).get('/api/sales-operations/quality/contacts').set(authHeader(restricted.token));
  expect(denied.status).toBe(403);
  expect((await request(app).get('/api/configuration-packages/export').set(authHeader(restricted.token))).status).toBe(403);
});

test('configuration packages preview, reject stale changes and restore previous version', async () => {
  const original = await get('configuration-packages/export');
  const bundle = original.body.bundle;
  bundle.validationRules.push({ id: crypto.randomUUID(), name: 'Positive amount', description: null, module: 'deals', active: true, condition: { field: 'value', operator: 'lt', value: 0 }, errorMessage: 'No negative amounts', errorField: 'value' });
  const preview = await post('configuration-packages/preview', { bundle });
  expect(preview.status).toBe(200);
  expect(preview.body.changes).toHaveLength(1);
  const applied = await post('configuration-packages/apply', { bundle, ...preview.body, label: 'Pricing rules' });
  expect(applied.status).toBe(200);
  expect(await prisma.validationRule.count()).toBe(1);
  const stale = await post('configuration-packages/apply', { bundle, ...preview.body });
  expect(stale.status).toBe(409);
  const previous = await get(`configuration-packages/history/${applied.body.revisionId}`);
  const restorePreview = await post('configuration-packages/preview', { bundle: previous.body.bundle });
  expect(restorePreview.body.changes[0].action).toBe('delete');
  const restore = await post('configuration-packages/apply', { bundle: previous.body.bundle, ...restorePreview.body, label: previous.body.label });
  expect(restore.status).toBe(200);
  expect(await prisma.validationRule.count()).toBe(0);
  expect(await prisma.configurationRevision.count()).toBe(2);
});

test('configuration validation rejects unknown fields and missing assignment dependencies', async () => {
  const { bundle } = (await get('configuration-packages/export')).body;
  bundle.workflows.push({ id: crypto.randomUUID(), name: 'Assign', module: 'deals', trigger: 'create', active: true, description: null, conditions: [], actions: [{ type: 'assignOwner', config: { userId: crypto.randomUUID() } }] });
  const response = await post('configuration-packages/preview', { bundle });
  expect(response.status).toBe(400);
  expect(response.body.error).toContain('Missing active user');
  expect(await prisma.workflow.count()).toBe(0);
  bundle.workflows = [];
  bundle.stageRequirements = { Proposal: ['unknown'] };
  expect((await post('configuration-packages/preview', { bundle })).status).toBe(400);
});

test('row access limits pipeline history and account 360', async () => {
  const role = await createTestRole('Rep limited', [{ module: 'deals', level: 'read' }, { module: 'accounts', level: 'read' }]);
  const rep = await createTestUser({ roleId: role.id });
  await prisma.orgWideDefault.create({ data: { module: 'deals', internalAccess: 'Private' } });
  await prisma.orgWideDefault.create({ data: { module: 'accounts', internalAccess: 'Private' } });
  require('../src/middleware/rowSecurity').invalidateOrgWideDefaultCache();
  const account = await createTestAccount({ ownerId: user.id });
  const deal = await createTestDeal(user.id);
  await updateRecord(prisma, 'deals', deal.id, { value: 200 }, { userId: user.id });
  const hidden = await request(app).get('/api/sales-operations/pipeline-changes').set(authHeader(rep.token));
  expect(hidden.status).toBe(200);
  expect(hidden.body.total).toBe(0);
  expect((await request(app).get(`/api/sales-operations/accounts/${account.id}`).set(authHeader(rep.token))).status).toBe(404);
});
