const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestUser, createTestRole, createTestContact, createTestProduct, createTestDeal, authHeader } = require('./setup');
const { invalidateOrgWideDefaultCache } = require('../src/middleware/rowSecurity');
const { encrypt } = require('../src/utils/secretBox');
const graph = require('../src/services/microsoftGraph');
const policy = require('../src/services/sequencePolicy');
const calendar = require('../src/services/outlookCalendar');
let app, prisma, admin, rep, other;
const get = (path, actor = admin) => request(app).get(path).set(authHeader(actor.token));
const post = (path, body, actor = admin) => request(app).post(path).set(authHeader(actor.token)).send(body);
const put = (path, body, actor = admin) => request(app).put(path).set(authHeader(actor.token)).send(body);
beforeAll(async () => { ({ app, prisma } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase(); invalidateOrgWideDefaultCache();
  admin = await createTestUser({ email: 'admin@next.test' });
  const role = await createTestRole('Rep', ['contacts', 'leads', 'accounts', 'products', 'deals', 'activities', 'emails', 'workflows', 'quotes', 'reports'].map(module => ({ module, level: 'edit' })));
  rep = await createTestUser({ email: 'rep@next.test', roleId: role.id });
  other = await createTestUser({ email: 'other@next.test', roleId: role.id });
});
afterEach(() => { jest.restoreAllMocks(); });
const field = (name, fieldType, extra = {}) => prisma.customFieldDef.create({ data: { module: 'contacts', name, label: name, fieldType, ...extra } });
const valuesPath = id => '/api/studio/values/contacts/' + id;
async function mailbox(actor = rep) { return prisma.inboundEmailAccount.create({ data: { name: 'Outlook', username: actor.user.email, ownerId: actor.user.id, mailboxAddress: actor.user.email, provider: 'microsoft', active: true, calendarEnabled: true, oauthAccessToken: encrypt('calendar-test-token'), oauthRefreshToken: encrypt('calendar-test-refresh'), oauthExpiresAt: new Date(Date.now() + 3600000) } }); }
const remote = (id, extra = {}) => ({ id, subject: 'Customer meeting', body: { contentType: 'Text', content: 'Agenda' }, start: { dateTime: new Date(Date.now() + 86400000).toISOString().replace('Z', ''), timeZone: 'UTC' }, end: { dateTime: new Date(Date.now() + 90000000).toISOString().replace('Z', ''), timeZone: 'UTC' }, type: 'singleInstance', isOrganizer: true, isReminderOn: true, reminderMinutesBeforeStart: 15, attendees: [{ emailAddress: { address: 'customer@example.com', name: 'Customer' }, type: 'required', status: { response: 'accepted' } }], '@odata.etag': 'W/"v1"', ...extra });
async function quote() { const product = await createTestProduct(); const response = await post('/api/quotes', { items: [{ productId: product.id, quantity: 2, unitPrice: 40, discount: 0 }], terms: 'Payment on acceptance.' }); expect(response.status).toBe(201); return response.body; }
async function share(q) { const response = await post('/api/quotes/' + q.id + '/shares', { days: 10 }); expect(response.status).toBe(201); return { ...response.body, path: new URL(response.body.url).pathname }; }

test('custom values validate a whole form, preserve false and zero, enforce unique values, and reject stale saves', async () => {
  const score = await field('score', 'number', { required: true, minValue: 0 }), flag = await field('qualified', 'boolean', { required: true });
  await field('code', 'text', { unique: true });
  const a = await createTestContact({ ownerId: rep.user.id }), b = await createTestContact({ ownerId: rep.user.id });
  expect((await put(valuesPath(a.id), { values: { score: 0, qualified: false, code: 'ONE' } }, rep)).status).toBe(200);
  const loaded = await get(valuesPath(a.id), rep); expect(loaded.body.find(f => f.name === 'score').value).toBe(0); expect(loaded.body.find(f => f.name === 'qualified').value).toBe(false);
  expect((await put(valuesPath(a.id), { values: { score: -1, qualified: true, code: 'CHANGED' } }, rep)).status).toBe(400);
  expect((await prisma.studioFieldValue.findUnique({ where: { fieldId_recordId: { fieldId: flag.id, recordId: a.id } } })).value).toBe(false);
  expect((await put(valuesPath(b.id), { values: { score: 1, qualified: true, code: 'one' } }, rep)).status).toBe(409);
  expect(await prisma.studioFieldValue.count({ where: { recordId: b.id } })).toBe(0);
  const versions = Object.fromEntries(loaded.body.map(f => [f.id, f.version]));
  expect((await put(valuesPath(a.id), { values: { score: 1 }, versions }, rep)).status).toBe(200);
  expect((await put(valuesPath(a.id), { values: { score: 2 }, versions }, rep)).status).toBe(409);
  expect((await prisma.studioFieldValue.findUnique({ where: { fieldId_recordId: { fieldId: score.id, recordId: a.id } } })).value).toBe(1);
});

test('custom values and reports obey private records; list filters and grouped reports use stored values', async () => {
  await field('score', 'number'); await field('tier', 'text');
  await prisma.orgWideDefault.create({ data: { module: 'contacts', internalAccess: 'Private' } }); invalidateOrgWideDefaultCache();
  const a = await createTestContact({ ownerId: rep.user.id }), b = await createTestContact({ ownerId: other.user.id });
  expect((await put(valuesPath(a.id), { values: { score: 12, tier: 'Gold' } }, rep)).status).toBe(200);
  expect((await put(valuesPath(b.id), { values: { score: 999, tier: 'Gold' } }, other)).status).toBe(200);
  expect((await get(valuesPath(b.id), rep)).status).toBe(404);
  expect((await put(valuesPath(b.id), { values: { score: 1 } }, rep)).status).toBe(404);
  const list = await get('/api/contacts?custom.tier=Gold', rep); expect(list.status).toBe(200); expect(list.body.data.map(r => r.id)).toEqual([a.id]); expect(list.body.data[0]['custom.score']).toBe(12);
  const report = await post('/api/reports/execute', { module: 'contacts', reportType: 'summary', groupBy: ['custom.tier'], aggregations: [{ field: 'custom.score', function: 'sum' }] }, rep);
  expect(report.status).toBe(200); expect(report.body.summary.data[0]._sum['custom.score']).toBe(12); expect(report.body.totalCount).toBe(1);
});

test('custom picklist and date validation, read-only values, and definition deletion use the new storage', async () => {
  const list = await prisma.picklist.create({ data: { name: 'tier', label: 'Tier', values: { create: [{ value: 'Gold', label: 'Gold' }] } } });
  const tier = await field('tier', 'picklist', { picklistId: list.id }); await field('renewal', 'date'); await field('immutable', 'text', { readOnly: true });
  const a = await createTestContact({ ownerId: rep.user.id });
  expect((await put(valuesPath(a.id), { values: { tier: 'Bad', renewal: '2026-02-30' } }, rep)).status).toBe(400);
  expect((await put(valuesPath(a.id), { values: { immutable: 'changed' } }, rep)).status).toBe(400);
  expect((await put(valuesPath(a.id), { values: { tier: 'Gold', renewal: '2027-01-01' } }, rep)).status).toBe(200);
  expect((await put('/api/studio/fields/' + tier.id, { fieldType: 'number' })).status).toBe(409);
  expect((await request(app).delete('/api/studio/fields/' + tier.id).set(authHeader(admin.token))).status).toBe(409);
});

test('import preview checks mappings, existing and file duplicates, required custom values, and performs no writes', async () => {
  await field('score', 'number', { required: true });
  await createTestContact({ ownerId: rep.user.id, email: 'ada@example.com' });
  const records = [{ Given: 'Ada', Family: 'One', Email: 'ADA@example.com', Score: '0' }, { Given: 'Ada', Family: 'Two', Email: 'ADA@example.com', Score: 'bad' }];
  const body = { module: 'contacts', records, fieldMapping: { Given: 'firstName', Family: 'lastName', Email: 'email', Score: 'custom.score' } };
  const preview = await post('/api/import/validate', body, rep); expect(preview.status).toBe(200); expect(preview.body.duplicateCount).toBe(2); expect(preview.body.errorCount).toBe(1);
  expect(await prisma.contact.count()).toBe(1); expect(await prisma.studioFieldValue.count()).toBe(0);
  const result = await post('/api/import/execute', { ...body, records: [{ Given: 'New', Family: 'Valid', Email: 'new@example.com', Score: '2' }, { Given: 'New', Family: 'Invalid', Email: 'bad@example.com', Score: 'bad' }] }, rep);
  expect(result.status).toBe(200); expect(result.body.created).toBe(1); expect(result.body.errors[0].row).toBe(2); expect(await prisma.contact.count()).toBe(2);
  expect((await prisma.studioFieldValue.findFirst()).value).toBe(2);
});

test('workflow builder previews without writes and active owner/follow-up actions run on create', async () => {
  const metadata = await get('/api/workflows/builder/metadata'); expect(metadata.status).toBe(200); expect(metadata.body.modules.leads.some(f => f.name === 'company')).toBe(true);
  const definition = { name: 'New leads', module: 'leads', trigger: 'create', active: true, conditions: [{ field: 'company', operator: 'equals', value: 'Acme' }], actions: [{ type: 'assignOwner', config: { userId: other.user.id } }, { type: 'createActivity', config: { subject: 'First call', delayDays: 2 } }, { type: 'createNotification', config: { title: 'Assigned lead' } }] };
  expect((await post('/api/workflows', definition, rep)).status).toBe(403);
  const workflow = await post('/api/workflows', definition); expect(workflow.status).toBe(201);
  const lead = await post('/api/leads', { firstName: 'Ada', lastName: 'Lead', company: 'Acme' }, rep); expect(lead.status).toBe(201);
  expect((await prisma.lead.findUnique({ where: { id: lead.body.id } })).ownerId).toBe(other.user.id);
  const task = await prisma.activity.findFirst({ where: { subject: 'First call' } }); expect(task.leadId).toBe(lead.body.id); expect(task.assignedId).toBe(other.user.id); expect(task.dueDate > new Date()).toBe(true);
  expect(await prisma.workflowLog.findFirst({ where: { workflowId: workflow.body.id } })).toMatchObject({ success: true, actionsRun: ['Assigned owner', 'Created activity', 'Sent notification'] });
  const count = await prisma.activity.count();
  const preview = await post('/api/workflows/preview', { ...definition, recordId: lead.body.id }); expect(preview.status).toBe(200); expect(preview.body).toMatchObject({ matched: true, changed: false }); expect(await prisma.activity.count()).toBe(count);
  expect((await put('/api/workflows/' + workflow.body.id, { actions: definition.actions }, rep)).status).toBe(403);
});

test('sending windows respect weekends and daylight saving changes, and merge fields reject unknown tokens', () => {
  const window = { timezone: 'America/Toronto', days: [1, 2, 3, 4, 5], start: 540, end: 1020 };
  expect(policy.nextAllowed(window, new Date('2026-10-09T23:00:00Z')).toISOString()).toBe('2026-10-12T13:00:00.000Z');
  expect(policy.nextAllowed(window, new Date('2026-10-30T23:00:00Z')).toISOString()).toBe('2026-11-02T14:00:00.000Z');
  expect(policy.personalize('Hi {{firstName}} at {{company}}', { firstName: 'Ada', account: { name: 'Acme' } })).toBe('Hi Ada at Acme');
  expect(policy.templateProblem('{{unknown}}')).toMatch(/Unknown/);
  expect(policy.windowProblem({ ...window, timezone: 'Wrong/Zone' })).toBeTruthy();
});

test('unsubscribe links require confirmation, stop all matching enrollments, and reject forged tokens', async () => {
  const sequence = await prisma.emailSequence.create({ data: { name: 'S', steps: [], status: 'Active', createdById: rep.user.id } });
  const contact = await createTestContact({ ownerId: rep.user.id });
  const e = await prisma.emailSequenceEnrollment.create({ data: { sequenceId: sequence.id, contactId: contact.id, recipientEmail: 'customer@example.com', enrolledById: rep.user.id } });
  const url = new URL(policy.unsubscribeUrl(e.id)), path = url.pathname + url.search;
  expect((await request(app).get(path)).status).toBe(200); expect(await prisma.emailSuppression.count()).toBe(0);
  expect((await request(app).post(path)).status).toBe(200); expect((await prisma.emailSequenceEnrollment.findUnique({ where: { id: e.id } })).status).toBe('Opted Out');
  expect((await prisma.emailSuppression.findUnique({ where: { email: 'customer@example.com' } })).reason).toBe('Unsubscribe');
  expect((await request(app).post(url.pathname + '?token=' + '0'.repeat(64))).status).toBe(404);
});

test('quote PDFs are real PDF documents and customer acceptance records the version and signer once', async () => {
  const q = await quote(), s = await share(q);
  const internal = await get('/api/quotes/' + q.id + '/pdf'); expect(internal.status).toBe(200); expect(internal.headers['content-type']).toMatch(/application\/pdf/); expect(internal.body.subarray(0, 5).toString()).toBe('%PDF-');
  expect(internal.body.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1);
  const definition = await post('/api/studio/fields', { module: 'quotes', name: 'region', label: 'Region', fieldType: 'text' });
  expect(definition.status).toBe(201);
  expect((await put('/api/studio/values/quotes/' + q.id, { values: { region: 'Canada' } })).status).toBe(200);
  const filtered = await get('/api/quotes?custom.region=Canada');
  expect(filtered.body.data.map(row => row.id)).toEqual([q.id]);
  expect(filtered.body.data[0]['custom.region']).toBe('Canada');
  expect((await get('/api/quotes?custom.region=Other')).body.data).toHaveLength(0);
  const customer = await request(app).get(s.path); expect(customer.status).toBe(200); expect(customer.text).toContain('Payment on acceptance.'); expect(customer.text).not.toContain(q.id);
  const accept = await request(app).post(s.path + '/accept').type('form').send({ name: 'Ada Customer', email: 'ada@example.com', consent: 'yes' }); expect(accept.status).toBe(303);
  expect((await prisma.quote.findUnique({ where: { id: q.id } })).status).toBe('Accepted');
  const receipt = await prisma.quoteShare.findUnique({ where: { id: s.id } }); expect(receipt.acceptedName).toBe('Ada Customer');
  expect((await request(app).post(s.path + '/accept').type('form').send({ name: 'Changed signer', email: 'new@example.com', consent: 'yes' })).status).toBe(303);
  expect((await prisma.quoteShare.findUnique({ where: { id: s.id } })).acceptedName).toBe('Ada Customer');
});

test('modified, revoked, expired, and deleted quote links cannot be accepted', async () => {
  const q = await quote(), changed = await share(q);
  expect((await put('/api/quotes/' + q.id, { terms: 'Updated terms' })).status).toBe(200);
  expect((await request(app).get(changed.path)).status).toBe(410);
  const s = await share(q);
  expect((await request(app).delete('/api/quotes/' + q.id + '/shares/' + s.id).set(authHeader(admin.token))).status).toBe(200);
  expect((await request(app).post(s.path + '/accept').send({ name: 'A', email: 'a@example.com', consent: true })).status).toBe(410);
  const expired = await share(q); await prisma.quoteShare.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } }); expect((await request(app).get(expired.path)).status).toBe(410);
  const deleted = await share(q); await prisma.quote.update({ where: { id: q.id }, data: { deletedAt: new Date() } }); expect((await request(app).get(deleted.path)).status).toBe(410);
});

test('Outlook delta sync paginates, imports attendees/reminders privately, and checkpoints without duplicates', async () => {
  const account = await mailbox();
  const spy = jest.spyOn(graph, 'graphFetch').mockResolvedValueOnce({ value: [remote('remote-1')], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=one' }).mockResolvedValueOnce({ value: [remote('remote-2')], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=two' });
  const result = await post('/api/outlook-calendar/' + account.id + '/sync', {}, rep); expect(result.status).toBe(200); expect(result.body.synced).toBe(2); expect(spy).toHaveBeenCalledTimes(2);
  const event = await prisma.calendarEvent.findFirst({ include: calendar.include }); expect(event.visibility).toBe('Private'); expect(event.ownerId).toBe(rep.user.id); expect(event.invitees[0].responseStatus).toBe('Accepted'); expect(event.reminders).toHaveLength(1);
  expect((await get('/api/calendar/events/' + event.id, other)).status).toBe(404); expect((await get('/api/calendar/events/' + event.id, admin)).status).toBe(404);
  const saved = await prisma.inboundEmailAccount.findUnique({ where: { id: account.id } }); expect(saved.calendarCursor).toContain('deltatoken=two');
  spy.mockResolvedValue({ value: [remote('remote-1')], '@odata.deltaLink': saved.calendarCursor });
  expect((await post('/api/outlook-calendar/' + account.id + '/sync', {}, rep)).status).toBe(200); expect(await prisma.calendarEvent.count()).toBe(2);
  expect((await post('/api/outlook-calendar/' + account.id + '/sync', {}, other)).status).toBe(404);
});

test('Outlook preserves local edits during remote conflicts; explicit resolution refreshes attendees and reminders', async () => {
  const account = await mailbox(); await calendar.importEvent(prisma, account, remote('one'));
  let event = await prisma.calendarEvent.findFirst();
  await prisma.calendarEvent.update({ where: { id: event.id }, data: { title: 'Local revision' } });
  expect(await calendar.importEvent(prisma, account, remote('one', { subject: 'Remote revision', '@odata.etag': 'W/"v2"', attendees: [] }))).toBe('conflict');
  expect((await prisma.calendarEvent.findUnique({ where: { id: event.id } })).title).toBe('Local revision');
  expect((await prisma.outlookEventLink.findFirst()).conflict).toBe(true);
  jest.spyOn(graph, 'graphFetch').mockResolvedValue(remote('one', { subject: 'Remote revision', '@odata.etag': 'W/"v2"', attendees: [], isReminderOn: false }));
  expect((await post('/api/outlook-calendar/' + account.id + '/use-outlook/' + event.id, {}, rep)).status).toBe(200);
  event = await prisma.calendarEvent.findUnique({ where: { id: event.id }, include: calendar.include }); expect(event.title).toBe('Remote revision'); expect(event.invitees).toHaveLength(0); expect(event.reminders).toHaveLength(0);
});

test('Outlook publish uses an idempotency key, attendee updates and remote version checks; deal links stay local', async () => {
  const account = await mailbox(), deal = await createTestDeal(rep.user.id);
  const event = await prisma.calendarEvent.create({ data: { title: 'New meeting', ownerId: rep.user.id, startAt: new Date(Date.now() + 86400000), endAt: new Date(Date.now() + 90000000), dealId: deal.id, invitees: { create: [{ email: 'customer@example.com' }] }, reminders: { create: [{ userId: rep.user.id, minutesBefore: 10, triggerAt: new Date(Date.now() + 85800000) }] } } });
  const spy = jest.spyOn(graph, 'graphFetch').mockResolvedValue(remote('created'));
  const path = '/api/outlook-calendar/' + account.id + '/publish/' + event.id;
  expect((await post(path, {}, rep)).status).toBe(200);
  expect(spy.mock.calls[0][1].body).toMatchObject({ transactionId: event.id, attendees: [{ emailAddress: { address: 'customer@example.com' } }], isReminderOn: true });
  expect(spy.mock.calls[0][1].body.dealId).toBeUndefined();
  expect((await post(path, {}, other)).status).toBe(404);
  spy.mockRejectedValueOnce(new graph.GraphError('Precondition failed', { status: 412 }));
  expect((await post(path, {}, rep)).status).toBe(409);
  expect(spy.mock.calls[1][1].headers['If-Match']).toBe('W/"v1"');
  expect((await prisma.outlookEventLink.findFirst()).conflict).toBe(true);
});

test('Outlook removal verifies actual deletion and preserves local changes; an expired checkpoint can be restarted', async () => {
  const account = await mailbox(); await calendar.importEvent(prisma, account, remote('one'));
  const spy = jest.spyOn(graph, 'graphFetch').mockResolvedValueOnce(remote('one', { subject: 'Moved out of window', '@odata.etag': 'W/"v2"' }));
  await calendar.importEvent(prisma, account, { id: 'one', '@removed': { reason: 'deleted' } });
  expect((await prisma.calendarEvent.findFirst()).title).toBe('Moved out of window');
  spy.mockRejectedValueOnce(new graph.GraphError('Gone', { status: 404 }));
  await calendar.importEvent(prisma, account, { id: 'one', '@removed': { reason: 'deleted' } });
  expect((await prisma.calendarEvent.findFirst()).isCancelled).toBe(true);
  spy.mockRejectedValueOnce(new graph.GraphError('Expired', { status: 410 }));
  expect((await post('/api/outlook-calendar/' + account.id + '/sync', {}, rep)).status).toBe(409);
  expect((await prisma.inboundEmailAccount.findUnique({ where: { id: account.id } })).calendarCursor).toBeNull();
});
