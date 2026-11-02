const request = require('supertest');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { setup, teardown, cleanDatabase, createTestUser, createTestRole, authHeader } = require('./setup');
let app, prisma;
const originalEnv = { ...process.env };
beforeAll(async () => { ({ app, prisma } = await setup()); await cleanDatabase(); });
afterAll(teardown);
afterEach(() => { jest.restoreAllMocks(); for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv); });
const actor = overrides => createTestUser({ email: `${crypto.randomUUID()}@test.com`, ...overrides });
const post = (token, path, body = {}) => request(app).post('/api' + path).set(authHeader(token)).send(body);
const get = (token, path) => request(app).get('/api' + path).set(authHeader(token));

test('onboarding persists per user, refuses forged milestones and records successful CRM work', async () => {
  const a = await actor(), b = await actor();
  expect((await post(a.token, '/onboarding/preferences', { firstDealAt: true })).status).toBe(400);
  expect((await post(a.token, '/deals', { name: 'Activation opportunity', value: 1250 })).status).toBe(201);
  const imported = await post(a.token, '/import/execute', { module: 'contacts', records: [{ firstName: 'Real', lastName: 'Import', email: `${crypto.randomUUID()}@example.com` }] });
  expect(imported.status).toBe(200); expect(imported.body.created).toBe(1);
  const quote = await post(a.token, '/quotes', { name: 'First proposal' });
  expect(quote.status).toBe(201);
  await post(a.token, '/onboarding/preferences', { dismissed: true });
  const current = await get(a.token, '/onboarding');
  expect(current.body.dismissed).toBe(true);
  expect(current.body.steps.find(s => s.id === 'deal').done).toBe(true);
  expect(current.body.steps.find(s => s.id === 'import').done).toBe(true);
  expect((await get(b.token, '/onboarding')).body.steps.find(s => s.id === 'deal').done).toBe(false);
  expect((await prisma.userOnboarding.findUnique({ where: { userId: a.user.id } })).firstQuoteAt).toBeTruthy();
});

test('rolled-back writes and unsuccessful imports do not complete milestones', async () => {
  const a = await actor();
  await expect(prisma.$transaction(async tx => {
    await require('../src/services/recordWrites').createRecord(tx, 'deals', { name: 'Rolled back' }, { userId: a.user.id, after: [], prisma });
    throw new Error('Rollback fixture');
  })).rejects.toThrow('Rollback fixture');
  await post(a.token, '/import/execute', { module: 'contacts', records: [{ email: 'missing-name@example.com' }] });
  const progress = (await get(a.token, '/onboarding')).body;
  expect(progress.steps.find(s => s.id === 'deal').done).toBe(false);
  expect(progress.steps.find(s => s.id === 'import').done).toBe(false);
});

test('pipeline templates require administrator permission and a current preview', async () => {
  const a = await actor();
  const role = await createTestRole('Onboarding reader', [{ module: 'deals', level: 'read' }]);
  const reader = await actor({ roleId: role.id });
  const preview = (await get(a.token, '/onboarding/pipeline')).body;
  expect((await post(reader.token, '/onboarding/pipeline', { template: 'flexible', baseHash: preview.baseHash })).status).toBe(403);
  expect((await post(reader.token, '/onboarding/pipeline')).status).toBe(200);
  expect((await post(a.token, '/onboarding/pipeline', { template: 'consultative', baseHash: preview.baseHash })).status).toBe(200);
  expect((await post(a.token, '/onboarding/pipeline', { template: 'flexible', baseHash: preview.baseHash })).status).toBe(409);
  await prisma.setting.delete({ where: { key: 'sales.stageRequirements' } });
});

test('activation reporting counts real milestones and distinct usage days, with opt-out and retention', async () => {
  const a = await actor();
  const visitId = crypto.randomUUID();
  await prisma.marketingVisit.create({ data: { id: visitId, page: '/', device: 'desktop' } });
  await prisma.signupRequest.create({ data: { email: a.user.email, convertedUserId: a.user.id, convertedAt: new Date(), marketingVisitId: visitId } });
  await require('../src/services/onboarding').milestone(prisma, a.user.id, 'firstDealAt');
  await post(a.token, '/onboarding/visit', { measurement: true });
  await post(a.token, '/onboarding/visit', { measurement: true });
  expect(await prisma.userUsageDay.count({ where: { userId: a.user.id } })).toBe(1);
  const yesterday = new Date(Date.now() - 86400000);
  await prisma.userUsageDay.create({ data: { userId: a.user.id, day: yesterday.toISOString().slice(0, 10), createdAt: yesterday } });
  let report = await get(a.token, '/marketing/summary');
  expect(report.body.activation).toMatchObject({ firstDeal: 1, repeatUsage: 1 });
  await post(a.token, '/onboarding/preferences', { analyticsOptOut: true });
  report = await get(a.token, '/marketing/summary');
  expect(report.body.activation).toMatchObject({ firstDeal: 0, repeatUsage: 0 });
  expect(await prisma.userUsageDay.count({ where: { userId: a.user.id } })).toBe(0);
  expect((await prisma.userOnboarding.findUnique({ where: { userId: a.user.id } })).firstDealAt).toBeTruthy();
  const old = new Date(Date.now() - 31 * 86400000);
  await prisma.userUsageDay.create({ data: { userId: a.user.id, day: old.toISOString().slice(0, 10), createdAt: old } });
  await require('../src/services/marketing').cleanup(prisma);
  expect(await prisma.userUsageDay.count({ where: { userId: a.user.id } })).toBe(0);
  await post(a.token, '/onboarding/preferences', { analyticsOptOut: false });
  await request(app).post('/api/onboarding/visit').set(authHeader(a.token)).set('DNT', '1').send({ measurement: true });
  expect((await prisma.userOnboarding.findUnique({ where: { userId: a.user.id } })).analyticsOptOut).toBe(true);
});

function oauthEnv() {
  process.env.OAUTH_LOGIN_ENABLED = 'true'; process.env.FRONTEND_URL = 'http://localhost:7544';
  process.env.MICROSOFT_CLIENT_ID = 'test-client'; process.env.MICROSOFT_CLIENT_SECRET = 'test-only-secret'; process.env.MICROSOFT_TENANT_ID = '11111111-2222-3333-4444-555555555555';
  process.env.GOOGLE_CLIENT_ID = 'google-test'; process.env.GOOGLE_CLIENT_SECRET = 'test-only-google-secret';
}
async function start(provider = 'microsoft') {
  const response = await request(app).post('/api/oauth/start/' + provider).send({});
  expect(response.status).toBe(200);
  const url = new URL(response.body.authorizationUrl), state = url.searchParams.get('state');
  const row = await prisma.oAuthLoginAttempt.findUnique({ where: { stateHash: crypto.createHash('sha256').update(state).digest('hex') } });
  return { response, url, state, row, cookie: response.headers['set-cookie'][0].split(';')[0] };
}
function msFetch(flow, email, overrides = {}) {
  return jest.spyOn(global, 'fetch').mockImplementation(async url => String(url).includes('/token') ? { ok: true, json: async () => ({ access_token: 'not-a-real-token', id_token: jwt.sign({ aud: 'test-client', tid: process.env.MICROSOFT_TENANT_ID, iss: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/v2.0`, nonce: flow.row.nonce, oid: 'test-object', ...overrides }, 'test-only', { expiresIn: 600 }) }) } : { ok: true, json: async () => ({ id: 'test-object', mail: email }) });
}
const callback = flow => request(app).post('/api/oauth/callback').set('Cookie', flow.cookie).send({ state: flow.state, code: 'test-code' });

test('browser OAuth binds state and PKCE to one browser and exchanges a callback once', async () => {
  oauthEnv(); const a = await actor(), flow = await start(); const fetch = msFetch(flow, a.user.email);
  expect(flow.url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(flow.response.headers['set-cookie'][0]).toContain('HttpOnly');
  expect((await request(app).post('/api/oauth/callback').send({ state: flow.state, code: 'test-code' })).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
  const signedIn = await callback(flow);
  expect(signedIn.status).toBe(200); expect(signedIn.body.session).toBe('cookie'); expect(signedIn.body.accessToken).toBeUndefined();
  expect(signedIn.headers['set-cookie'].some(c => c.startsWith('sn_access='))).toBe(true);
  const body = fetch.mock.calls[0][1].body;
  expect(body.get('code_verifier')).toBe(flow.row.verifier);
  expect((await callback(flow)).status).toBe(400); expect(fetch).toHaveBeenCalledTimes(2);
});

test('provider login keeps MFA, rejects wrong nonce and never provisions unknown users', async () => {
  oauthEnv(); const a = await actor();
  await prisma.mfaDevice.create({ data: { userId: a.user.id, type: 'totp', secret: 'JBSWY3DPEHPK3PXP', verified: true } });
  let flow = await start(), fetch = msFetch(flow, a.user.email);
  const challenge = await callback(flow);
  expect(challenge.status).toBe(200); expect(challenge.body.mfaRequired).toBe(true);
  expect(challenge.headers['set-cookie'].some(c => c.startsWith('sn_access='))).toBe(false);
  fetch.mockRestore(); flow = await start(); fetch = msFetch(flow, a.user.email, { nonce: 'wrong' });
  expect((await callback(flow)).status).toBe(403);
  fetch.mockRestore(); flow = await start(); msFetch(flow, 'not-provisioned@example.com');
  expect((await callback(flow)).status).toBe(403);
  expect(await prisma.user.count({ where: { email: 'not-provisioned@example.com' } })).toBe(0);
});

test('Google requires a verified address and matching nonce; cancelled or expired flows cannot be reused', async () => {
  oauthEnv(); const a = await actor();
  const flow = await start('google');
  const verify = jest.spyOn(require('google-auth-library').OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({ getPayload: () => ({ email: a.user.email, email_verified: true, nonce: flow.row.nonce }) });
  jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ id_token: 'test-id-token' }) });
  expect((await callback(flow)).body.session).toBe('cookie'); expect(verify).toHaveBeenCalled();
  const denied = await start('google');
  verify.mockResolvedValue({ getPayload: () => ({ email: a.user.email, email_verified: false, nonce: denied.row.nonce }) });
  expect((await callback(denied)).status).toBe(403);
  const cancelled = await start();
  expect((await request(app).post('/api/oauth/callback').set('Cookie', cancelled.cookie).send({ state: cancelled.state, error: 'access_denied' })).status).toBe(400);
  expect(await prisma.oAuthLoginAttempt.findUnique({ where: { stateHash: cancelled.row.stateHash } })).toBeNull();
  const expired = await start();
  await prisma.oAuthLoginAttempt.update({ where: { stateHash: expired.row.stateHash }, data: { expiresAt: new Date(0) } });
  expect((await callback(expired)).status).toBe(400);
  expect((await request(app).post('/api/oauth/start/microsoft').set('Origin', 'https://unrelated.example').send({})).status).toBe(403);
});

async function signatureFixture() {
  const a = await actor();
  const deal = await prisma.deal.create({ data: { name: 'Signature deal', ownerId: a.user.id } });
  const quote = await prisma.quote.create({ data: { number: crypto.randomUUID(), name: 'Frozen proposal', dealId: deal.id, status: 'Draft' } });
  const room = await prisma.dealRoom.create({ data: { dealId: deal.id, name: 'Signing room', tokenHash: crypto.randomUUID(), createdById: a.user.id, expiresAt: new Date(Date.now() + 86400000) } });
  const row = await prisma.signatureRequest.create({ data: { roomId: room.id, quoteId: quote.id, quoteVersion: quote.updatedAt, requestKey: crypto.randomUUID(), envelopeId: crypto.randomUUID(), signerName: 'Buyer', signerEmail: 'buyer@example.com', status: 'sent' } });
  return { a, row, quote };
}
function signedEvent(row, status, at, overrides = {}) {
  const body = JSON.stringify({ event: `envelope-${status}`, generatedDateTime: at.toISOString(), data: { accountId: 'test-account', envelopeId: row.envelopeId }, ...overrides });
  return { body, signature: crypto.createHmac('sha256', 'connect-test-key').update(body).digest('base64') };
}
const deliver = event => request(app).post('/api/public/docusign/webhook').set('Content-Type', 'application/json').set('X-DocuSign-Signature-1', event.signature).send(event.body);

test('DocuSign signed events are idempotent, cannot regress completion, and preserve quote approvals', async () => {
  process.env.DOCUSIGN_CONNECT_HMAC_KEY = 'connect-test-key'; process.env.DOCUSIGN_ACCOUNT_ID = 'test-account';
  const { a, row, quote } = await signatureFixture();
  const complete = signedEvent(row, 'completed', new Date(Date.now() - 10000));
  expect((await deliver({ ...complete, signature: 'invalid' })).status).toBe(401);
  expect((await deliver(complete)).body.updated).toBe(true);
  expect((await deliver(complete)).body.duplicate).toBe(true);
  expect((await deliver(signedEvent(row, 'delivered', new Date(Date.now() - 20000)))).body.updated).toBe(false);
  expect((await prisma.signatureRequest.findUnique({ where: { id: row.id } })).status).toBe('completed');
  expect(await prisma.notification.count({ where: { userId: a.user.id, title: 'Signature completed' } })).toBe(1);
  expect((await prisma.quote.findUnique({ where: { id: quote.id } })).status).toBe('Draft');
  const wrong = signedEvent(row, 'voided', new Date(), { data: { accountId: 'other', envelopeId: row.envelopeId } });
  expect((await deliver(wrong)).status).toBe(403);
  expect((await deliver({ ...complete, body: complete.body + ' ' })).status).toBe(401);
});

test('declined and voided envelopes notify once and HMAC key rotation accepts the previous key', async () => {
  process.env.DOCUSIGN_CONNECT_HMAC_KEY = 'rotated-test-key'; process.env.DOCUSIGN_CONNECT_HMAC_KEY_PREVIOUS = 'connect-test-key'; process.env.DOCUSIGN_ACCOUNT_ID = 'test-account';
  for (const status of ['declined', 'voided']) {
    const { a, row } = await signatureFixture();
    const event = signedEvent(row, status, new Date());
    expect((await deliver(event)).status).toBe(200);
    await deliver(event);
    expect(await prisma.notification.count({ where: { userId: a.user.id, title: `Signature ${status}` } })).toBe(1);
  }
  const { row } = await signatureFixture();
  expect((await deliver(signedEvent(row, 'completed', new Date(Date.now() + 3600000)))).status).toBe(400);
  expect((await deliver(signedEvent({ envelopeId: crypto.randomUUID() }, 'sent', new Date()))).status).toBe(409);
});

test('integration diagnostics restrict credentials and recovery to allowed records', async () => {
  process.env.STRIPE_SECRET_KEY = 'must-never-appear-in-diagnostics';
  const role = await createTestRole('No integrations access', [{ module: 'contacts', level: 'read' }]);
  const reader = await actor({ roleId: role.id }), a = await actor();
  await prisma.inboundEmailAccount.create({ data: { name: 'Private mailbox', username: a.user.email, ownerId: a.user.id, lastError: 'Private provider error' } });
  const restricted = await get(reader.token, '/sales-operations/integrations');
  expect(restricted.status).toBe(200); expect(restricted.body.setup).toEqual([]); expect(restricted.body.failures.items).toEqual([]);
  expect(JSON.stringify(restricted.body)).not.toContain('Private mailbox');
  expect((await post(reader.token, '/sales-operations/integrations/stripe/check')).status).toBe(403);
  const admin = await get(a.token, '/sales-operations/integrations');
  expect(admin.status).toBe(200); expect(JSON.stringify(admin.body)).not.toContain(process.env.STRIPE_SECRET_KEY);
  expect(admin.body.failures.items.some(r => r.kind === 'Mailbox')).toBe(true);
  const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
  expect((await post(a.token, '/sales-operations/integrations/stripe/check')).body.connected).toBe(true);
  expect(fetch.mock.calls[0][0]).toBe('https://api.stripe.com/v1/balance');
  expect(fetch.mock.calls[0][1].method).toBeUndefined();
});

test('uncertain signatures recover only a verified existing envelope and never create another', async () => {
  const { a, row } = await signatureFixture();
  await prisma.signatureRequest.update({ where: { id: row.id }, data: { envelopeId: null, status: 'Pending', error: 'Uncertain provider response' } });
  Object.assign(process.env, { DOCUSIGN_INTEGRATION_KEY: 'test-client', DOCUSIGN_USER_ID: 'test-user', DOCUSIGN_PRIVATE_KEY: 'test-key', DOCUSIGN_ACCOUNT_ID: 'test-account', DOCUSIGN_DEMO: 'true' });
  jest.spyOn(jwt, 'sign').mockReturnValue('test-assertion');
  let transactionId = 'unrelated-request';
  const fetch = jest.spyOn(global, 'fetch').mockImplementation(async url => ({ ok: true, json: async () => String(url).endsWith('/oauth/token') ? { access_token: 'test-token' } : String(url).endsWith('/oauth/userinfo') ? { accounts: [{ account_id: 'test-account', base_uri: 'https://demo.docusign.net' }] } : { transactionId, status: 'delivered', statusChangedDateTime: new Date().toISOString() } }));
  const path = `/deal-rooms/${row.roomId}/signatures/${row.id}/recover`;
  expect((await post(a.token, path, { envelopeId: row.envelopeId })).status).toBe(409);
  expect((await prisma.signatureRequest.findUnique({ where: { id: row.id } })).envelopeId).toBeNull();
  transactionId = row.id;
  const recovered = await post(a.token, path, { envelopeId: row.envelopeId });
  expect(recovered.status).toBe(200); expect(recovered.body.status).toBe('delivered');
  expect(fetch.mock.calls.some(([url, options]) => String(url).includes('/envelopes') && options.method === 'POST')).toBe(false);
});

test('concurrent milestone and usage writes remain idempotent', async () => {
  const a = await actor(), onboarding = require('../src/services/onboarding');
  await Promise.all(Array.from({ length: 4 }, () => onboarding.milestone(prisma, a.user.id, 'firstDealAt')));
  expect(await prisma.userOnboarding.count({ where: { userId: a.user.id } })).toBe(1);
  const results = await Promise.all(Array.from({ length: 4 }, () => post(a.token, '/onboarding/visit', { measurement: true })));
  expect(results.map(r => r.status)).toEqual([200, 200, 200, 200]);
  expect(await prisma.userUsageDay.count({ where: { userId: a.user.id } })).toBe(1);
  const changing = await Promise.all([
    ...Array.from({ length: 3 }, () => post(a.token, '/onboarding/visit', { measurement: true })),
    post(a.token, '/onboarding/preferences', { analyticsOptOut: true }),
  ]);
  expect(changing.every(r => r.status === 200)).toBe(true);
  expect(await prisma.userUsageDay.count({ where: { userId: a.user.id } })).toBe(0);
});

test('missing payment records return 404 and flow metadata exposes supported fields', async () => {
  const a = await actor(), missing = crypto.randomUUID();
  expect((await get(a.token, `/payments/${missing}`)).status).toBe(404);
  expect((await post(a.token, `/payments/${missing}/record`, { reference: 'missing-record', amount: 10 })).status).toBe(404);
  expect((await post(a.token, `/payments/${missing}/checkout`, { amount: 10 })).status).toBe(404);
  const metadata = await get(a.token, '/flows/field-metadata/contacts');
  expect(metadata.status).toBe(200);
  expect(metadata.body.fields).toContainEqual({ name: 'firstName', type: 'String' });
  expect(metadata.body.fields.some(f => f.name === 'ownerId')).toBe(false);
});

test('restore checker refuses a normal database or the source database as its target', () => {
  const { target } = require('../scripts/restore-check');
  expect(() => target('postgresql://postgres@localhost/sales_nebula')).toThrow(/restore_test/);
  process.env.DATABASE_URL = 'postgresql://postgres@localhost/sales_nebula_restore_test';
  expect(() => target(process.env.DATABASE_URL)).toThrow(/differ/);
  expect(target('postgresql://postgres@localhost/another_restore_test').args).toContain('another_restore_test');
});
