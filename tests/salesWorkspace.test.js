const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestRole, createTestUser, createTestContact, createTestDeal, authHeader } = require('./setup');
const { invalidateOrgWideDefaultCache } = require('../src/middleware/rowSecurity');
const graph = require('../src/services/microsoftGraph');
const { encrypt } = require('../src/utils/secretBox');
let app, prisma, admin, rep, other;
const get = (path, actor = rep) => request(app).get(path).set(authHeader(actor.token));
const post = (path, data, actor = rep) => request(app).post(path).set(authHeader(actor.token)).send(data);
const dayQuery = section => `/api/sales-workspace/my-day?section=${section}&day=2026-10-06&start=2026-10-06T04:00:00Z&end=2026-10-07T04:00:00Z`;
beforeAll(async () => { ({ app, prisma } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase(); invalidateOrgWideDefaultCache();
  admin = await createTestUser({ email: 'admin@workspace.test' });
  const role = await createTestRole('Sales', ['deals', 'contacts', 'leads', 'activities', 'emails', 'cases'].map(module => ({ module, level: 'edit' })));
  rep = await createTestUser({ email: 'rep@workspace.test', roleId: role.id });
  other = await createTestUser({ email: 'other@workspace.test', roleId: role.id });
});
afterEach(() => jest.restoreAllMocks());

test('My Day handles date-only due dates, assignees, completed work, and pagination', async () => {
  await prisma.activity.createMany({ data: [
    { subject: 'Yesterday', type: 'Task', ownerId: rep.user.id, dueDate: new Date('2026-10-05'), status: 'Scheduled' },
    { subject: 'Today', type: 'Task', ownerId: rep.user.id, dueDate: new Date('2026-10-06'), status: 'Scheduled' },
    { subject: 'Already done', type: 'Task', ownerId: rep.user.id, dueDate: new Date('2026-10-05'), status: 'Completed' },
    { subject: 'Assigned elsewhere', type: 'Task', ownerId: rep.user.id, assignedId: other.user.id, dueDate: new Date('2026-10-05'), status: 'Scheduled' },
    { subject: 'Deleted', type: 'Task', ownerId: rep.user.id, dueDate: new Date('2026-10-05'), deletedAt: new Date() },
  ] });
  const overdue = await get(dayQuery('overdue')); expect(overdue.status).toBe(200); expect(overdue.body.data.map(r => r.subject)).toEqual(['Yesterday']);
  const today = await get(dayQuery('today')); expect(today.body.data.map(r => r.subject)).toEqual(['Today']);
  await prisma.activity.createMany({ data: Array.from({ length: 27 }, (_, i) => ({ subject: `Task ${i}`, type: 'Task', ownerId: rep.user.id, dueDate: new Date('2026-10-06') })) });
  expect((await get(dayQuery('today') + '&page=2')).body.data).toHaveLength(3);
});

test('pipeline respects private records and paginates each stage independently', async () => {
  await prisma.orgWideDefault.create({ data: { module: 'deals', internalAccess: 'Private' } }); invalidateOrgWideDefaultCache();
  await createTestDeal(other.user.id, { name: 'Private deal' });
  await prisma.deal.createMany({ data: Array.from({ length: 27 }, (_, i) => ({ name: `Visible ${i}`, stage: 'Qualification', ownerId: rep.user.id, currency: i % 2 ? 'USD' : 'CAD', value: 10 })) });
  const response = await get('/api/sales-workspace/pipeline'); expect(response.status).toBe(200);
  const col = response.body.columns.find(c => c.stage === 'Qualification'); expect(col.total).toBe(27); expect(col.rows).toHaveLength(25); expect(col.amounts).toHaveLength(2);
  const second = await get('/api/sales-workspace/pipeline?stage=Qualification&page=2'); expect(second.body.columns[0].rows).toHaveLength(2);
  expect(col.rows.some(d => d.name === 'Private deal')).toBe(false);
});

test('a missing next action and an overdue action are distinguishable', async () => {
  const noTask = await createTestDeal(rep.user.id, { name: 'No task' });
  const scheduled = await createTestDeal(rep.user.id, { name: 'Has task' });
  await prisma.activity.create({ data: { type: 'Task', subject: 'Follow up', ownerId: rep.user.id, dealId: scheduled.id, dueDate: new Date('2027-01-01') } });
  const response = await get(dayQuery('deals')); expect(response.status).toBe(200); expect(response.body.data.map(d => d.id)).toEqual([noTask.id]);
  const board = await get('/api/sales-workspace/pipeline'); const rows = board.body.columns.flatMap(c => c.rows);
  expect(rows.find(d => d.id === scheduled.id).nextAction.subject).toBe('Follow up');
});

test('completion and its follow-up commit together; invalid follow-up changes nothing', async () => {
  const lead = await prisma.lead.create({ data: { firstName: 'Pat', lastName: 'Lead', company: 'Acme', ownerId: rep.user.id } });
  const task = await post('/api/activities', { subject: 'Initial task', type: 'Task', leadId: lead.id }); expect(task.status).toBe(201);
  expect((await post(`/api/activities/${task.body.id}/complete`, { followUp: { date: 'invalid' } })).status).toBe(400);
  expect((await prisma.activity.findUnique({ where: { id: task.body.id } })).status).toBe('Scheduled');
  const rule = await prisma.validationRule.create({ data: { name: 'Reject follow-up', module: 'activities', condition: { field: 'subject', operator: 'equals', value: 'Rejected follow-up' }, errorMessage: 'Choose another subject', active: true } });
  const refused = await post(`/api/activities/${task.body.id}/complete`, { followUp: { date: '2027-01-10', subject: 'Rejected follow-up' } });
  expect(refused.status).toBe(400); expect(refused.body.code).toBe('VALIDATION_RULE');
  expect((await prisma.activity.findUnique({ where: { id: task.body.id } })).status).toBe('Scheduled');
  expect(await prisma.activity.count({ where: { subject: 'Rejected follow-up' } })).toBe(0);
  await prisma.validationRule.delete({ where: { id: rule.id } });
  const done = await post(`/api/activities/${task.body.id}/complete`, { result: 'Spoke to lead', followUp: { date: '2027-01-10', subject: 'Next conversation', type: 'Call' } });
  expect(done.status).toBe(200); expect(done.body.completedAt).toBeTruthy();
  const next = await prisma.activity.findFirst({ where: { subject: 'Next conversation' } }); expect(next.leadId).toBe(lead.id); expect(next.ownerId).toBe(rep.user.id);
});

test('pipeline moves retain validation rules and stage history', async () => {
  const deal = await createTestDeal(rep.user.id);
  const response = await request(app).put(`/api/deals/${deal.id}`).set(authHeader(rep.token)).set('If-Match', deal.updatedAt.toISOString()).send({ stage: 'Proposal' });
  expect(response.status).toBe(200); expect(await prisma.dealStageHistory.count({ where: { dealId: deal.id, toStage: 'Proposal' } })).toBe(1);
  const stale = await request(app).put(`/api/deals/${deal.id}`).set(authHeader(rep.token)).set('If-Match', deal.updatedAt.toISOString()).send({ stage: 'Negotiation' }); expect(stale.status).toBe(409);
});

test('sales insights use actual stage history and exclude private deals', async () => {
  await prisma.orgWideDefault.create({ data: { module: 'deals', internalAccess: 'Private' } }); invalidateOrgWideDefaultCache();
  const won = await createTestDeal(rep.user.id, { stage: 'Closed Won', createdAt: new Date('2026-01-01') });
  await prisma.dealStageHistory.create({ data: { dealId: won.id, fromStage: 'Negotiation', toStage: 'Closed Won', createdAt: new Date('2026-01-11') } });
  await createTestDeal(other.user.id, { stage: 'Closed Lost' });
  const response = await get('/api/sales-workspace/insights'); expect(response.status).toBe(200); expect(response.body).toMatchObject({ won: 1, lost: 0, winRate: 100, salesCycleDays: 10, cycleSample: 1 });
});

test('saved list definitions persist privately and public report execution still respects rows', async () => {
  const view = await post('/api/views', { name: 'My current pipeline', module: 'pipeline', filters: { mine: true, search: 'Acme' } }); expect(view.status).toBe(201);
  expect((await get('/api/views/pipeline', other)).body.data).toHaveLength(0);
  expect((await get('/api/views/pipeline')).body.data[0].filters.search).toBe('Acme');
  await prisma.orgWideDefault.create({ data: { module: 'deals', internalAccess: 'Private' } }); invalidateOrgWideDefaultCache();
  await createTestDeal(rep.user.id, { name: 'Mine', value: 100, currency: 'CAD' }); await createTestDeal(other.user.id, { name: 'Hidden', value: 900, currency: 'CAD' });
  const report = await post('/api/reports', { name: 'Shared pipeline', module: 'deals', reportType: 'summary', groupBy: ['currency'], aggregations: [{ field: 'value', function: 'sum' }], isPublic: true }, admin);
  const result = await post(`/api/reports/${report.body.id}/execute`, {}); expect(result.status).toBe(200); expect(result.body.summary.data[0]._sum.value).toBe(100);
});

test('sequence editor saves steps, guards delays, enrolls once, and locks running definitions', async () => {
  const contact = await createTestContact({ ownerId: rep.user.id });
  const sequence = await post('/api/sequences', { name: 'Follow up', steps: [{ delayDays: 0, subject: 'Hello', body: 'Hi' }] }); expect(sequence.status).toBe(201);
  expect((await post(`/api/sequences/${sequence.body.id}/activate`, {})).status).toBe(200);
  const enrollment = await post(`/api/sequences/${sequence.body.id}/enroll`, { contactIds: [contact.id, contact.id] }); expect(enrollment.body.enrolled).toBe(1);
  expect((await get(`/api/sequences/${sequence.body.id}/enrollments`)).body.data[0].person.id).toBe(contact.id);
  const changed = await request(app).put(`/api/sequences/${sequence.body.id}`).set(authHeader(rep.token)).send({ steps: [{ delayDays: 1, subject: 'Changed', body: 'Hi' }] }); expect(changed.status).toBe(409);
  expect((await post('/api/sequences', { name: 'Invalid', steps: [{ delayDays: -1 }] })).status).toBe(400);
  const empty = await post('/api/sequences', { name: 'Unfinished', steps: [{ delayDays: 0 }] });
  expect((await post(`/api/sequences/${empty.body.id}/activate`, {})).status).toBe(400);
});

async function mailbox(owner = rep) {
  return prisma.inboundEmailAccount.create({ data: { name: 'Personal', provider: 'microsoft', username: owner.user.email, mailboxAddress: owner.user.email, ownerId: owner.user.id, active: true, autoCreateCase: false, oauthAccessToken: encrypt('local-test-token'), oauthRefreshToken: encrypt('local-test-refresh'), oauthExpiresAt: new Date(Date.now() + 3600000) } });
}
test('personal mail cannot be read or replied to by another rep or through support routes', async () => {
  const account = await mailbox(); const message = await prisma.inboundEmailMessage.create({ data: { accountId: account.id, fromEmail: 'customer@example.com', subject: 'Private conversation', externalId: 'graph-private' } });
  expect((await get('/api/sales-mail/accounts', other)).body.data).toHaveLength(0);
  expect((await get('/api/sales-mail/messages', other)).body.data).toHaveLength(0);
  expect((await get(`/api/sales-mail/messages/${message.id}`, other)).status).toBe(404);
  expect((await post(`/api/sales-mail/messages/${message.id}/reply`, { body: 'No' }, other)).status).toBe(404);
  expect((await get('/api/inbound-email/messages', admin)).body.data).toHaveLength(0);
  expect((await post(`/api/inbound-email/messages/${message.id}/reply`, { body: 'No' }, admin)).status).toBe(404);
  expect((await get(`/api/inbound-email/accounts/${account.id}`, admin)).status).toBe(404);
  const support = await get('/api/inbound-email/analytics', admin);
  expect(support.status).toBe(200); expect(support.body.accounts).toBe(0); expect(support.body.byStatus).toEqual({});
  expect((await post('/api/inbound-email/rules/test', { accountId: account.id }, admin)).status).toBe(400);
  expect((await post('/api/emails/send', { to: 'customer@example.com', subject: 'No impersonation', body: 'No', mailboxId: account.id }, other)).status).toBe(403);
});

test('Outlook consent is bound to the initiating owner, expires, and cannot be replayed', async () => {
  process.env.MICROSOFT_CLIENT_ID = 'test-client'; process.env.MICROSOFT_CLIENT_SECRET = 'test-secret';
  const account = await mailbox();
  const authorize = await post(`/api/sales-mail/accounts/${account.id}/authorize`, {}); expect(authorize.status).toBe(200);
  const state = new URL(authorize.body.url).searchParams.get('state'); expect(state).toHaveLength(64);
  expect(new URL(authorize.body.url).searchParams.get('code_challenge_method')).toBe('S256');
  expect((await post('/api/sales-mail/connect', { state, code: 'test-code' }, other)).status).toBe(400);
  jest.spyOn(graph, 'exchangeCode').mockResolvedValue({ accessToken: 'new-token', refreshToken: 'new-refresh', expiresAt: new Date(Date.now() + 3600000) });
  jest.spyOn(graph, 'getProfile').mockResolvedValue({ mail: rep.user.email });
  const connected = await post('/api/sales-mail/connect', { state, code: 'test-code' }); expect(connected.status).toBe(200); expect(connected.body.oauthAccessToken).toBeUndefined();
  expect(graph.exchangeCode).toHaveBeenCalledWith(expect.objectContaining({ codeVerifier: expect.any(String) }));
  expect((await post('/api/sales-mail/connect', { state, code: 'test-code' })).status).toBe(400);
  const expired = new URL((await post(`/api/sales-mail/accounts/${account.id}/authorize`, {})).body.url).searchParams.get('state');
  await prisma.inboundEmailAccount.update({ where: { id: account.id }, data: { oauthStateExpiresAt: new Date(Date.now() - 1000) } });
  expect((await post('/api/sales-mail/connect', { state: expired, code: 'test-code' })).status).toBe(400);
});

test('mail sync associates only unique visible contacts and deals, deduplicates, and replies in thread', async () => {
  const account = await mailbox(); const contact = await createTestContact({ email: 'customer@example.com', ownerId: rep.user.id }); const deal = await createTestDeal(rep.user.id, { contactId: contact.id });
  jest.spyOn(graph, 'listMessagePage').mockImplementation(async ({ folder }) => ({ nextLink: null, messages: folder === 'SentItems' ? [] : [{ id: 'graph-1', conversationId: 'conversation-1', internetMessageId: 'msg-1', receivedDateTime: '2026-10-06T12:00:00Z', from: { emailAddress: { address: contact.email } }, subject: 'Proposal', body: { contentType: 'text', content: 'Please call me' } }] }));
  expect((await post(`/api/sales-mail/accounts/${account.id}/sync`, {})).body.imported).toBe(1);
  expect((await post(`/api/sales-mail/accounts/${account.id}/sync`, {})).body.imported).toBe(0);
  const message = (await get('/api/sales-mail/messages?unanswered=true')).body.data[0]; expect(message.contactId).toBe(contact.id); expect(message.dealId).toBe(deal.id);
  const reply = jest.spyOn(graph, 'replyToMessage').mockResolvedValue(null);
  expect((await post(`/api/sales-mail/messages/${message.id}/reply`, { body: 'I will call today.' })).status).toBe(200);
  expect(reply).toHaveBeenCalledWith(expect.objectContaining({ graphMessageId: 'graph-1', comment: 'I will call today.' }));
  expect((await get('/api/sales-mail/messages?unanswered=true')).body.total).toBe(0);
  expect((await get(`/api/sales-mail/messages/${message.id}`)).body.thread).toHaveLength(2);
  expect((await post(`/api/sales-mail/messages/${message.id}/reply`, { body: 'I will call today.' })).body.duplicate).toBe(true); expect(reply).toHaveBeenCalledTimes(1);
});

test('read-only users cannot perform new mailbox writes', async () => {
  const role = await createTestRole('Reader', [{ module: 'emails', level: 'read' }]); const reader = await createTestUser({ roleId: role.id });
  expect((await post('/api/sales-mail/accounts', {}, reader)).status).toBe(403);
  expect((await get('/api/sales-workspace/pipeline', reader)).status).toBe(403);
});

test('Sent Items answers older incoming mail and persists separate provider pagination cursors', async () => {
  const account = await mailbox();
  const incoming = await prisma.inboundEmailMessage.create({ data: { accountId: account.id, fromEmail: 'customer@example.com', threadKey: 'thread-2', receivedAt: new Date('2026-10-05'), direction: 'inbound', externalId: 'in-1' } });
  const nextLink = 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?$skiptoken=next';
  const messages = jest.spyOn(graph, 'listMessagePage').mockImplementation(async ({ folder }) => folder === 'Inbox' ? { messages: [], nextLink } : { messages: [{ id: 'out-1', conversationId: 'thread-2', subject: 'Re: Call', sentDateTime: '2026-10-06T12:00:00Z', receivedDateTime: '2026-10-06T12:00:00Z', from: { emailAddress: { address: rep.user.email } }, toRecipients: [{ emailAddress: { address: 'customer@example.com' } }], body: { contentType: 'text', content: 'Replied in Outlook' } }], nextLink: null });
  const first = await post(`/api/sales-mail/accounts/${account.id}/sync`, {}); expect(first.status).toBe(200); expect(first.body.moreMayBeAvailable).toBe(true);
  expect((await prisma.inboundEmailMessage.findUnique({ where: { id: incoming.id } })).status).toBe('Replied');
  messages.mockImplementation(async ({ folder }) => ({ nextLink: null, messages: folder === 'Inbox' ? [{ id: 'in-later-page', conversationId: 'thread-2', receivedDateTime: '2026-10-06T10:00:00Z', from: { emailAddress: { address: 'customer@example.com' } }, body: { contentType: 'text', content: 'Earlier incoming message on a later page' } }] : [] }));
  await post(`/api/sales-mail/accounts/${account.id}/sync`, {});
  expect(messages).toHaveBeenCalledWith(expect.objectContaining({ folder: 'Inbox', cursor: nextLink }));
  expect(await prisma.inboundEmailMessage.count({ where: { accountId: account.id, direction: 'outbound' } })).toBe(1);
  expect((await prisma.inboundEmailMessage.findFirst({ where: { externalId: 'in-later-page' } })).status).toBe('Replied');
  await expect(graph.listMessages({ accessToken: 'not-sent', cursor: 'https://example.com/steal' })).rejects.toMatchObject({ status: 400 });
});
