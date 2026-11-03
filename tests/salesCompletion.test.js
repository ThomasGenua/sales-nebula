const request = require('supertest');
const crypto = require('crypto');
const { setup, teardown, cleanDatabase, createTestUser, createTestRole, createTestDeal, createTestContact, authHeader } = require('./setup');
const migration = require('../src/services/crmMigration');
const meetings = require('../src/services/meetingIntelligence');
const payments = require('../src/services/payments');
const adjustments = require('../src/services/billingAdjustments');
const identity = require('../src/services/enterpriseIdentity');
const mailbox = require('../src/services/mailboxCompletion');
const { encrypt } = require('../src/utils/secretBox');
let app, prisma, user, token;
const env = { ...process.env };
beforeAll(async () => { ({ app, prisma } = await setup()); });
afterAll(async () => { process.env = env; await teardown(); });
beforeEach(async () => { jest.restoreAllMocks(); await cleanDatabase(); ({ user, token } = await createTestUser({ email: 'admin@example.com' })); });
afterEach(() => { jest.restoreAllMocks(); for (const k of ['ENTERPRISE_SSO_ENABLED', 'ENTERPRISE_SSO_REQUIRED', 'ENTERPRISE_EMAIL_DOMAINS', 'ENTERPRISE_BREAK_GLASS_EMAILS', 'SCIM_BEARER_TOKEN', 'SCIM_DEFAULT_ROLE', 'ANTHROPIC_API_KEY', 'DEEPGRAM_API_KEY']) if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; });
const post = (url, body) => request(app).post('/api' + url).set(authHeader(token)).send(body);
const get = url => request(app).get('/api' + url).set(authHeader(token));
const context = () => ({ req: { user, userId: user.id, app: { locals: { prisma } } }, userId: user.id });
const invoice = () => prisma.invoice.create({ data: { number: 'INV-COMPLETE', total: 100, subtotal: 100, currency: 'USD', status: 'Sent' } });

test('migration preserves source IDs, owners and links and can undo unchanged records', async () => {
  const teammate = await createTestUser({ email: 'owner@example.com' });
  const staged = await post('/crm-migrations', { source: 'salesforce', sourceInstance: 'organization-one', ownerMap: { OWNER: teammate.user.email }, files: [
    { module: 'accounts', records: [{ Id: 'A1', Name: 'Imported company', OwnerId: 'OWNER' }] },
    { module: 'contacts', records: [{ AccountId: 'A1', Id: 'C1', FirstName: 'Imported', LastName: 'Person', Email: 'imported@example.com', OwnerId: 'OWNER' }] },
    { module: 'deals', records: [{ AccountId: 'A1', ContactId: 'C1', Id: 'D1', Name: 'Imported deal', Amount: '1200', StageName: 'Prospecting', OwnerId: 'OWNER' }] },
  ] });
  expect(staged.status).toBe(201);
  await prisma.migrationBatch.update({ where: { id: staged.body.id }, data: { status: 'Running' } });
  await migration.runBatch(prisma, staged.body.id);
  const detail = await get('/crm-migrations/' + staged.body.id);
  expect(detail.body.counts).toEqual({ Applied: 3 });
  const account = await prisma.account.findFirst({ where: { name: 'Imported company' } }), contact = await prisma.contact.findFirst({ where: { email: 'imported@example.com' } }), deal = await prisma.deal.findFirst({ where: { name: 'Imported deal' } });
  expect(contact.accountId).toBe(account.id); expect(deal.contactId).toBe(contact.id); expect(deal.accountId).toBe(account.id); expect(deal.ownerId).toBe(teammate.user.id);
  const preview = await get('/crm-migrations/' + staged.body.id + '/undo'); expect(preview.body.rows.every(r => !r.conflict)).toBe(true);
  const undone = await post('/crm-migrations/' + staged.body.id + '/undo', { hash: preview.body.hash }); expect(undone.status).toBe(200); expect(undone.body.undone).toBe(3);
  expect(await prisma.contact.count({ where: { deletedAt: null, id: contact.id } })).toBe(0);
});

test('migration preview rejects unmapped owners and safe undo refuses later edits', async () => {
  const staged = await post('/crm-migrations', { source: 'hubspot', sourceInstance: 'portal-two', files: [{ module: 'accounts', records: [{ 'Record ID': '1', Name: 'Preview company', OwnerId: 'unknown' }] }] });
  expect(staged.status).toBe(201);
  expect((await post('/crm-migrations/' + staged.body.id + '/start', { acknowledgeAutomation: true })).status).toBe(400);
  const row = (await get('/crm-migrations/' + staged.body.id)).body.rows[0];
  expect((await request(app).patch(`/api/crm-migrations/${staged.body.id}/rows/${row.id}`).set(authHeader(token)).send({ data: { ownerEmail: user.email } })).status).toBe(200);
  await prisma.migrationBatch.update({ where: { id: staged.body.id }, data: { status: 'Running' } }); await migration.runBatch(prisma, staged.body.id);
  const imported = await prisma.migrationRow.findUnique({ where: { id: row.id } }); expect(imported.status).toBe('Applied');
  const preview = await get(`/crm-migrations/${staged.body.id}/undo`);
  await prisma.account.update({ where: { id: imported.recordId }, data: { name: 'Later edit', updatedAt: new Date(Date.now() + 1000) } });
  expect((await post(`/crm-migrations/${staged.body.id}/undo`, { hash: preview.body.hash })).status).toBe(409);
  expect((await prisma.account.findUnique({ where: { id: imported.recordId } })).name).toBe('Later edit');
});

test('migration resumes failed dependencies without duplicating applied rows', async () => {
  const batch = await post('/crm-migrations', { source: 'salesforce', sourceInstance: 'org', files: [{ module: 'contacts', records: [{ Id: 'C', FirstName: 'Test', LastName: 'Customer', AccountId: 'missing' }] }] });
  await prisma.migrationBatch.update({ where: { id: batch.body.id }, data: { status: 'Running' } }); await migration.runBatch(prisma, batch.body.id);
  expect((await get('/crm-migrations/' + batch.body.id)).body.counts).toEqual({ Failed: 1 });
  const parent = await post('/crm-migrations', { source: 'salesforce', sourceInstance: 'org', files: [{ module: 'accounts', records: [{ Id: 'missing', Name: 'Parent company' }] }] });
  await prisma.migrationBatch.update({ where: { id: parent.body.id }, data: { status: 'Running' } }); await migration.runBatch(prisma, parent.body.id);
  await prisma.migrationRow.updateMany({ where: { batchId: batch.body.id }, data: { status: 'Pending' } }); await prisma.migrationBatch.update({ where: { id: batch.body.id }, data: { status: 'Running' } });
  await migration.runBatch(prisma, batch.body.id); await migration.runBatch(prisma, batch.body.id);
  expect(await prisma.contact.count({ where: { firstName: 'Test', lastName: 'Customer' } })).toBe(1);
});

test('meeting analysis creates a review draft and applies chosen tasks exactly once', async () => {
  const deal = await createTestDeal(user.id); process.env.ANTHROPIC_API_KEY = 'fixture-only';
  const processJob = meetings.processJob; jest.spyOn(meetings, 'processJob').mockResolvedValue();
  jest.spyOn(require('../src/services/claude'), 'complete').mockResolvedValue({ text: JSON.stringify({ summary: 'Customer requested a proposal.', tasks: [{ subject: 'Send proposal', dueDate: null }, { subject: 'Schedule review', dueDate: null }], nextStep: 'Send the proposal', nextStepDate: null }), truncated: false });
  const created = await post('/meetings', { title: 'Customer review', consent: true, transcript: 'The customer asked us to send a proposal and schedule a review.', dealId: deal.id }); expect(created.status).toBe(201);
  await processJob(prisma, created.body.id);
  expect((await get('/meetings/' + created.body.id)).body.job.status).toBe('Ready'); expect(await prisma.activity.count()).toBe(0);
  const body = { tasks: [{ subject: 'Send reviewed proposal', dueDate: null }], applyNextStep: true, nextStep: 'Send the reviewed proposal', nextStepDate: null };
  const applied = await post('/meetings/' + created.body.id + '/apply', body); expect(applied.status).toBe(200); expect(applied.body.taskIds).toHaveLength(1);
  expect((await post('/meetings/' + created.body.id + '/apply', body)).body.alreadyApplied).toBe(true); expect(await prisma.activity.count()).toBe(1);
  expect((await prisma.deal.findUnique({ where: { id: deal.id } })).nextStep).toBe(body.nextStep);
});

test('meeting review protects later deal edits and isolates recordings by owner', async () => {
  const deal = await createTestDeal(user.id), recording = await prisma.callRecording.create({ data: { userId: user.id, dealId: deal.id, title: 'Review', transcription: 'Original transcript' } });
  await prisma.meetingJob.create({ data: { recordingId: recording.id, userId: user.id, status: 'Ready', consentAt: new Date(), baseDealVersion: deal.updatedAt, suggestions: { summary: 'Draft', tasks: [], nextStep: 'Proposal' } } });
  await prisma.deal.update({ where: { id: deal.id }, data: { nextStep: 'New plan', updatedAt: new Date(Date.now() + 1000) } });
  expect((await post('/meetings/' + recording.id + '/apply', { tasks: [], applyNextStep: true, nextStep: 'Old plan' })).status).toBe(409);
  const role = await createTestRole('Meeting rep', [{ module: 'activities', level: 'full' }]); const other = await createTestUser({ roleId: role.id, email: 'other@example.com' });
  expect((await request(app).get('/api/meetings/' + recording.id).set(authHeader(other.token))).status).toBe(404);
  expect((await post('/meetings', { title: 'No consent', transcript: 'Meeting transcript without consent' })).status).toBe(400);
});

test('recording expiry preserves a concurrently queued retry and removes abandoned audio', async () => {
  const fs = require('node:fs/promises'), fileKey = crypto.randomUUID() + '.audio';
  await fs.mkdir(meetings.directory(), { recursive: true });
  await fs.writeFile(meetings.filePath(fileKey), 'recording fixture');
  const recording = await prisma.callRecording.create({ data: { userId: user.id, title: 'Retry at expiry' } });
  await prisma.meetingJob.create({ data: { recordingId: recording.id, userId: user.id, status: 'Failed', fileKey, consentAt: new Date(), createdAt: new Date(Date.now() - 25 * 3600000) } });
  const findMany = prisma.meetingJob.findMany.bind(prisma.meetingJob);
  const read = jest.spyOn(prisma.meetingJob, 'findMany').mockImplementation(async args => {
    const rows = await findMany(args);
    if (args.where.fileKey) await prisma.meetingJob.update({ where: { recordingId: recording.id }, data: { status: 'Queued' } });
    return rows;
  });
  try {
    await meetings.processDue(prisma);
    expect((await prisma.meetingJob.findUnique({ where: { recordingId: recording.id } })).fileKey).toBe(fileKey);
    expect(await fs.readFile(meetings.filePath(fileKey), 'utf8')).toBe('recording fixture');
    read.mockRestore();
    await prisma.meetingJob.update({ where: { recordingId: recording.id }, data: { status: 'Failed' } });
    await meetings.processDue(prisma);
    expect((await prisma.meetingJob.findUnique({ where: { recordingId: recording.id } })).fileKey).toBeNull();
    await expect(fs.access(meetings.filePath(fileKey))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await post('/meetings/' + recording.id + '/retry')).status).toBe(410);
  } finally { read.mockRestore(); await meetings.removeAudio(fileKey); }
});

test('credit notes are capped, idempotent, printable and protect invoice amounts', async () => {
  const inv = await invoice(), body = { requestId: crypto.randomUUID(), amount: 25, reason: 'Agreed price correction' };
  const first = await post('/payments/' + inv.id + '/credit-notes', body); expect(first.status).toBe(201);
  expect((await post('/payments/' + inv.id + '/credit-notes', body)).body.id).toBe(first.body.id);
  expect((await get('/payments/' + inv.id)).body.outstandingMinor).toBe(7500);
  expect((await post('/payments/' + inv.id + '/credit-notes', { ...body, requestId: crypto.randomUUID(), amount: 76 })).status).toBe(400);
  expect((await get(`/payments/${inv.id}/credit-notes/${first.body.id}/pdf`)).headers['content-type']).toContain('application/pdf');
  expect((await request(app).put('/api/invoices/' + inv.id).set(authHeader(token)).send({ total: 50 })).status).toBe(409);
});

test('Stripe refund timeout preserves a reservation and reconciliation does not send again', async () => {
  const inv = await invoice(); const receipt = await payments.recordPayment(prisma, inv.id, { provider: 'stripe', reference: 'cs_fixture', paymentIntentId: 'pi_fixture', amountMinor: 10000, currency: 'USD' });
  const stripe = jest.spyOn(payments, 'stripe').mockRejectedValue(new Error('network timeout'));
  const body = { requestId: crypto.randomUUID(), paymentId: receipt.id, amount: 40, reason: 'Customer request' };
  const first = await post('/payments/' + inv.id + '/refunds', body); expect(first.status).toBe(201); expect(first.body.status).toBe('Pending');
  await post('/payments/' + inv.id + '/refunds', body); expect(stripe).toHaveBeenCalledTimes(1);
  expect((await post('/payments/' + inv.id + '/refunds', { ...body, requestId: crypto.randomUUID(), amount: 61 })).status).toBe(400);
  const object = { id: 're_fixture', status: 'succeeded', payment_intent: 'pi_fixture', amount: 4000, currency: 'usd', metadata: { adjustmentId: first.body.id } };
  stripe.mockImplementation(async path => path.startsWith('refunds?') ? { data: [object], has_more: false } : path.startsWith('disputes?') ? { data: [], has_more: false } : object);
  const ledger = await post('/payments/' + inv.id + '/reconcile-ledger'); expect(ledger.status).toBe(200); expect(ledger.body.refundedMinor).toBe(4000); expect(ledger.body.outstandingMinor).toBe(4000);
  expect(await prisma.invoiceAdjustment.count()).toBe(1); expect(stripe.mock.calls.filter(c => c[0] === 'refunds')).toHaveLength(1);
});

test('dispute updates are idempotent and a win restores the paid balance', async () => {
  const inv = await invoice(); await payments.recordPayment(prisma, inv.id, { provider: 'stripe', reference: 'cs_dispute', paymentIntentId: 'pi_dispute', amountMinor: 10000, currency: 'USD' });
  const object = { id: 'du_fixture', payment_intent: 'pi_dispute', amount: 10000, currency: 'usd', status: 'needs_response', reason: 'fraudulent', evidence_details: { due_by: Math.floor(Date.now() / 1000) + 86400 } };
  await adjustments.synchronize(prisma, 'Dispute', object); await adjustments.synchronize(prisma, 'Dispute', object);
  expect((await payments.balance(prisma, inv)).disputedMinor).toBe(10000); expect((await prisma.invoice.findUnique({ where: { id: inv.id } })).status).toBe('Disputed');
  await adjustments.synchronize(prisma, 'Dispute', { ...object, status: 'won' });
  expect((await payments.balance(prisma, inv)).paidMinor).toBe(10000); expect(await prisma.invoiceAdjustment.count()).toBe(1);
  expect((await prisma.invoice.findUnique({ where: { id: inv.id } })).status).toBe('Paid');
});

test('SCIM provisions a safe role and revokes sessions across deactivate/reactivate', async () => {
  const role = await createTestRole('Provisioned sales', [{ module: 'contacts', level: 'read' }]); process.env.SCIM_DEFAULT_ROLE = role.name; process.env.SCIM_BEARER_TOKEN = 'fixture-scim-token-at-least-thirty-two-characters';
  const provision = (method, url, body) => request(app)[method]('/api/scim/v2' + url).set('Authorization', 'Bearer ' + process.env.SCIM_BEARER_TOKEN).set('Content-Type', 'application/scim+json').send(body);
  expect((await request(app).get('/api/scim/v2/Users')).status).toBe(401);
  const created = await provision('post', '/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'provisioned@example.com', externalId: 'external-user-one', name: { givenName: 'Provisioned', familyName: 'User' }, active: true });
  expect(created.status).toBe(201); expect(created.body.password).toBeUndefined();
  const id = created.body.id, oldToken = require('../src/middleware/auth').signAccessToken(id, role.name), refresh = require('../src/middleware/auth').signRefreshToken(id).token;
  expect((await request(app).get('/api/auth/me').set(authHeader(oldToken))).status).toBe(200);
  expect((await provision('patch', '/Users/' + id, { Operations: [{ op: 'Replace', path: 'active', value: false }] })).status).toBe(200);
  await provision('patch', '/Users/' + id, { Operations: [{ op: 'Replace', path: 'active', value: true }] });
  expect((await request(app).get('/api/auth/me').set(authHeader(oldToken))).status).toBe(401);
  expect((await post('/auth/refresh', { refreshToken: refresh })).status).toBe(401);
  const filtered = await request(app).get('/api/scim/v2/Users').query({ filter: 'userName eq "PROVISIONED@example.com"' }).set('Authorization', 'Bearer ' + process.env.SCIM_BEARER_TOKEN); expect(filtered.body.totalResults).toBe(1);
  expect((await provision('delete', '/Users/' + id)).status).toBe(204); expect((await provision('get', '/Users/' + id)).status).toBe(404);
});

test('enterprise subject binding cannot be redirected by a later email claim', async () => {
  process.env.ENTERPRISE_EMAIL_DOMAINS = 'example.com';
  const first = await identity.account(prisma, 'oidc:https://issuer.example.com', { subject: 'stable-one', email: user.email, verified: true }); expect(first.id).toBe(user.id);
  const other = await createTestUser({ email: 'identity-other@example.com' });
  const second = await identity.account(prisma, 'oidc:https://issuer.example.com', { subject: 'stable-one', email: other.user.email, verified: true }); expect(second.id).toBe(user.id);
  await expect(identity.account(prisma, 'oidc:https://issuer.example.com', { subject: 'different-subject', email: user.email, verified: true })).rejects.toMatchObject({ status: 403 });
  await expect(identity.account(prisma, 'oidc:https://issuer.example.com', { subject: 'unverified-subject', email: other.user.email, verified: false })).rejects.toMatchObject({ status: 403 });
});

test('SAML request cache consumes a request only once under concurrent replay', async () => {
  const cache = identity.cache(prisma); await cache.saveAsync('request-one', 'timestamp');
  const results = await Promise.all([cache.consumeAsync('request-one'), cache.consumeAsync('request-one')]); expect(results.sort()).toEqual([null, 'timestamp'].sort());
  expect(await cache.saveIfAbsentAsync('assertion-one', 'seen', Date.now() + 60000)).toBe(true); expect(await cache.saveIfAbsentAsync('assertion-one', 'seen', Date.now() + 60000)).toBe(false);
});

test('Microsoft push rejects a forged client state and handles removed subscriptions', async () => {
  await prisma.mailboxSubscription.create({ data: { accountId: 'mail-fixture', provider: 'microsoft', remoteId: 'sub-fixture', stateSecret: encrypt('secret-client-state'), renewAt: new Date(Date.now() + 86400000) } });
  await mailbox.microsoftNotification(prisma, [{ subscriptionId: 'sub-fixture', clientState: 'forged' }]); expect((await prisma.mailboxSubscription.findUnique({ where: { accountId: 'mail-fixture' } })).pendingAt).toBeNull();
  await mailbox.microsoftNotification(prisma, [{ subscriptionId: 'sub-fixture', clientState: 'secret-client-state', lifecycleEvent: 'subscriptionRemoved' }]);
  const row = await prisma.mailboxSubscription.findUnique({ where: { accountId: 'mail-fixture' } }); expect(row.pendingAt).not.toBeNull(); expect(row.remoteId).toBeNull();
  const validation = await request(app).post('/api/public/mail-notifications/microsoft?validationToken=fixture-check').send({}); expect(validation.text).toBe('fixture-check');
});

test('Gmail attachments include inline bytes and reject oversized downloads', async () => {
  const google = require('../src/services/googleWorkspace'), account = { active: true, provider: 'google', oauthRefreshToken: 'fixture' }, message = { externalId: 'message-one' };
  const fetch = jest.spyOn(google, 'request').mockResolvedValue({ payload: { parts: [{ filename: 'small.txt', mimeType: 'text/plain', body: { size: 5, data: Buffer.from('hello').toString('base64url') } }, { filename: 'large.zip', body: { size: 21 * 1024 * 1024, attachmentId: 'large' } }] } });
  const list = await mailbox.attachments(prisma, account, message); expect(list[0].data).toBeUndefined(); expect(list[1].downloadable).toBe(false);
  expect((await mailbox.download(prisma, account, message, list[0].id)).bytes.toString()).toBe('hello');
  await expect(mailbox.download(prisma, account, message, 'large')).rejects.toMatchObject({ status: 413 });
  expect(fetch.mock.calls.every(c => c[2].includes('/messages/message-one?'))).toBe(true);
});

test('audio upload is transcribed into speaker segments and removes its stored file', async () => {
  process.env.ANTHROPIC_API_KEY = 'fixture-only'; process.env.DEEPGRAM_API_KEY = 'fixture-only';
  const processJob = meetings.processJob; jest.spyOn(meetings, 'processJob').mockResolvedValue();
  const audio = Buffer.alloc(48); audio.write('RIFF'); audio.write('WAVE', 8);
  const created = await request(app).post('/api/meetings').set(authHeader(token)).field('title', 'Recorded meeting').field('consent', 'true').attach('audio', audio, { filename: 'meeting.wav', contentType: 'audio/wav' }); expect(created.status).toBe(201);
  const queued = await prisma.meetingJob.findUnique({ where: { recordingId: created.body.id } });
  jest.spyOn(global, 'fetch').mockImplementation(async (url, opts) => { expect(url).toContain('api.deepgram.com/v1/listen'); for await (const chunk of opts.body) { expect(chunk.length).toBeGreaterThan(0); } return { ok: true, json: async () => ({ metadata: { duration: 24 }, results: { channels: [{ alternatives: [{ transcript: 'We agreed to send a proposal.' }] }], utterances: [{ speaker: 0, start: 1, end: 4, transcript: 'We agreed to send a proposal.' }] } }) }; });
  jest.spyOn(require('../src/services/claude'), 'complete').mockResolvedValue({ text: JSON.stringify({ summary: 'Proposal requested', tasks: [{ subject: 'Send proposal', dueDate: null }], nextStep: null, nextStepDate: null }), truncated: false });
  await processJob(prisma, created.body.id);
  const ready = await get('/meetings/' + created.body.id); expect(ready.body.job.status).toBe('Ready'); expect(ready.body.job.segments[0].speaker).toBe(0);
  expect(require('fs').existsSync(meetings.filePath(queued.fileKey))).toBe(false); expect(await prisma.activity.count()).toBe(0);
});

test('privacy purge removes meeting drafts and migration undo snapshots', async () => {
  const contact = await createTestContact({ email: 'erase@example.com' });
  const batch = await prisma.migrationBatch.create({ data: { name: 'Privacy fixture', source: 'salesforce', sourceInstance: 'privacy', createdById: user.id, rows: { create: { module: 'contacts', sourceId: 'external-contact', position: 1, recordId: contact.id, status: 'Applied', data: { email: contact.email }, before: { firstName: 'Original private name' } } } } });
  const recording = await prisma.callRecording.create({ data: { userId: user.id, contactId: contact.id, transcription: 'Personal meeting transcript', summary: 'Personal summary' } });
  await prisma.meetingJob.create({ data: { recordingId: recording.id, userId: user.id, status: 'Ready', consentAt: new Date(), suggestions: { summary: 'Personal draft' }, segments: [{ text: 'Personal words' }] } });
  const privacy = require('../src/services/dataErasure'), subject = await privacy.resolveSubject(prisma, { contactId: contact.id });
  expect((await privacy.exportSubject(prisma, subject)).records.MeetingJob).toHaveLength(1);
  await privacy.eraseSubject(prisma, subject, { strategy: 'purge', actorId: user.id });
  const job = await prisma.meetingJob.findUnique({ where: { recordingId: recording.id } }); expect(job.status).toBe('Erased'); expect(job.suggestions).toBeNull();
  expect((await prisma.callRecording.findUnique({ where: { id: recording.id } })).transcription).toBeNull();
  const row = await prisma.migrationRow.findFirst({ where: { batchId: batch.id } }); expect(row.status).toBe('Erased'); expect(row.before).toBeNull(); expect(row.data).toEqual({});
});
