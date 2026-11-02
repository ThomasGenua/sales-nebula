jest.mock('nodemailer', () => {
  const sendMail = jest.fn(async () => ({ messageId: 'acquisition-test' }));
  return { createTransport: jest.fn(() => ({ sendMail })), sendMail };
});
process.env.SMTP_HOST = 'smtp.test.invalid';
const crypto = require('crypto');
const request = require('supertest');
const mail = require('nodemailer');
const { setup, teardown, cleanDatabase, createTestRole, createTestUser } = require('./setup');
const marketing = require('../src/services/marketing');
const statusProof = require('../src/services/accessStatus');
let app, prisma, admin, outsider;
const auth = user => ({ Authorization: `Bearer ${user.token}` });
const event = (overrides = {}) => ({ visitId: crypto.randomUUID(), page: '/', device: 'desktop', event: 'visit', ...overrides });
const postEvent = body => request(app).post('/api/marketing/events').send(body);
const status = token => request(app).post('/api/signup/status').send({ token });

beforeAll(async () => {
  ({ app, prisma } = await setup()); await cleanDatabase();
  admin = await createTestUser({ email: 'acquisition-admin@example.org' });
  const role = await createTestRole('No access', [{ module: 'contacts', level: 'read' }]);
  outsider = await createTestUser({ email: 'acquisition-outsider@example.org', roleId: role.id });
  await createTestRole('Sales Rep', [{ module: 'leads', level: 'read' }]);
});
afterAll(async () => { await teardown(); });
beforeEach(async () => { await prisma.signupRequest.updateMany({ data: { marketingVisitId: null } }); await prisma.marketingVisit.deleteMany(); mail.sendMail.mockClear(); });

test('measurements deduplicate visits and retain the original campaign without personal payloads', async () => {
  const row = event({ utmSource: 'newsletter', utmMedium: 'email', utmCampaign: 'launch-2026', email: 'never-store@example.org', referrer: 'https://private.example/?secret=yes' });
  expect((await postEvent(row)).status).toBe(204);
  expect((await postEvent({ ...row, event: 'demo_start', utmSource: 'overwritten' })).status).toBe(204);
  await postEvent({ ...row, event: 'demo_start' });
  const stored = await prisma.marketingVisit.findUnique({ where: { id: row.visitId } });
  expect(stored.utmSource).toBe('newsletter'); expect(stored.demoStartedAt).toBeInstanceOf(Date);
  expect(JSON.stringify(stored)).not.toMatch(/never-store|private.example|secret/);
  expect(await prisma.marketingVisit.count()).toBe(1);
  expect(marketing.campaign('visitor@example.org')).toBeNull();
});

test('rejects forged conversion events, prototype keys, invalid metrics, and cross-site collection', async () => {
  for (const body of [event({ event: 'verified' }), event({ event: '__proto__' }), event({ event: 'vital', name: '__proto__', value: 1 }), event({ event: 'vital', name: 'LCP', value: -1 }), event({ event: 'vital', name: 'CLS', value: '1' }), event({ page: '/app/customer-secret' }), event({ visitId: 'not-an-id' })]) {
    expect((await postEvent(body)).status).toBe(400);
  }
  expect((await request(app).post('/api/marketing/events').set('Sec-Fetch-Site', 'cross-site').send(event())).status).toBe(403);
  expect(await prisma.marketingVisit.count()).toBe(0);
});

test('privacy signals and deployment opt-out disable collection', async () => {
  for (const header of ['DNT', 'Sec-GPC']) expect((await request(app).post('/api/marketing/events').set(header, '1').send(event())).status).toBe(204);
  process.env.MARKETING_ANALYTICS_ENABLED = 'false';
  try { expect((await postEvent(event())).status).toBe(204); } finally { delete process.env.MARKETING_ANALYTICS_ENABLED; }
  expect(await prisma.marketingVisit.count()).toBe(0);
});

test('aggregate access requires user-read permission and reports p75 with actual sample counts', async () => {
  for (const value of [100, 200, 300, 1000]) await postEvent(event({ event: 'vital', name: 'LCP', value }));
  expect((await request(app).get('/api/marketing/summary')).status).toBe(401);
  expect((await request(app).get('/api/marketing/summary').set(auth(outsider))).status).toBe(403);
  const response = await request(app).get('/api/marketing/summary?days=7').set(auth(admin));
  expect(response.status).toBe(200);
  expect(response.body.performance[0].metrics.lcpMs).toEqual({ p75: 300, samples: 4 });
  expect(response.body.performance[0].metrics.inpMs).toEqual({ p75: null, samples: 0 });
  expect(response.body.funnel).toMatchObject({ visits: 4, verified: 0, activated: 0 });
});

test('signup, verification, approval, invitation and first sign-in retain attribution and update private status', async () => {
  const visit = event({ utmSource: 'launch', utmMedium: 'social', utmCampaign: 'november' }); await postEvent(visit);
  const signup = await request(app).post('/api/signup').send({ email: 'acquisition-customer@example.org', firstName: 'Taylor', lastName: 'Example', marketingVisitId: visit.visitId });
  expect(signup.status).toBe(201);
  const token = new URL(signup.body.devVerifyUrl).searchParams.get('token');
  let row = await prisma.signupRequest.findFirst({ where: { email: 'acquisition-customer@example.org' } });
  expect(row).toMatchObject({ marketingVisitId: visit.visitId, utmSource: 'launch', utmMedium: 'social', utmCampaign: 'november' });
  const verified = await request(app).post('/api/signup/verify').send({ token });
  expect(verified.status).toBe(200); const proof = verified.body.statusToken;
  expect((await status(proof)).body).toMatchObject({ status: 'Verified', verified: true });
  expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${proof}`)).status).toBe(401);
  const approved = await request(app).post(`/api/signup/requests/${row.id}/approve`).set(auth(admin)).send({});
  expect(approved.status).toBe(201);
  expect((await status(proof)).body.status).toBe('Approved');
  const inviteMessage = mail.sendMail.mock.calls.find(([message]) => message.to === row.email && message.subject === 'You are invited to Sales Nebula')[0];
  const inviteToken = new URL(inviteMessage.text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
  const accepted = await request(app).post('/api/signup/invites/accept').set('X-Session-Mode', 'cookie').send({ token: inviteToken, password: 'Correct-Horse9!', firstName: 'Taylor', lastName: 'Example' });
  expect(accepted.status).toBe(201);
  expect(accepted.headers['set-cookie'].some(cookie => cookie.startsWith('sn_access='))).toBe(true);
  const result = await status(proof); expect(result.body.status).toBe('Converted');
  expect(result.body).not.toHaveProperty('email'); expect(result.body).not.toHaveProperty('rejectionReason');
  const overview = await request(app).get('/api/marketing/summary').set(auth(admin));
  expect(overview.body.funnel).toMatchObject({ visits: 1, requested: 1, verified: 1, activated: 1 });
  expect(overview.body.sources[0]).toMatchObject({ source: 'launch', activated: 1 });
});

test('status proofs reject tampering, expiry, missing tokens, and deleted requests', async () => {
  const row = await prisma.signupRequest.create({ data: { email: 'proof@example.org', status: 'Verified', verifiedAt: new Date() } });
  const proof = statusProof.issue(row);
  for (const bad of [undefined, 'invalid', proof + 'x']) expect((await status(bad)).status).toBe(401);
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 8 * 86400000);
  const expired = statusProof.issue(row); clock.mockRestore();
  expect((await status(expired)).status).toBe(401);
  await prisma.signupRequest.delete({ where: { id: row.id } });
  expect((await status(proof)).status).toBe(401);
});

test('status recovery responds identically for known and unknown addresses, including SMTP failure', async () => {
  const row = await prisma.signupRequest.create({ data: { email: 'recover@example.org', status: 'Pending', rejectionReason: 'Internal note, never public' } });
  const known = await request(app).post('/api/signup/status/link').send({ email: row.email });
  expect(known.status).toBe(202);
  const sent = mail.sendMail.mock.calls.find(([message]) => message.to === row.email)[0];
  const url = new URL(sent.text.match(/https?:\/\/\S+/)[0]);
  expect(url.pathname).toBe('/access-status'); expect(url.search).toBe('');
  const response = await status(new URLSearchParams(url.hash.slice(1)).get('token'));
  expect(response.body.status).toBe('Pending'); expect(JSON.stringify(response.body)).not.toContain('Internal note');
  const unknown = await request(app).post('/api/signup/status/link').send({ email: 'no-request@example.org' });
  expect(unknown.status).toBe(202); expect(unknown.body).toEqual(known.body);
  mail.sendMail.mockRejectedValueOnce(new Error('SMTP temporarily unavailable'));
  const failed = await request(app).post('/api/signup/status/link').send({ email: row.email });
  expect(failed.status).toBe(202); expect(failed.body).toEqual(known.body);
});

test('an approved request reports an expired invitation without exposing its token', async () => {
  const row = await prisma.signupRequest.create({ data: { email: 'expired-invite@example.org', status: 'Approved', verifiedAt: new Date() } });
  await prisma.userInvite.create({ data: { email: row.email, tokenHash: crypto.randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() - 60000), invitedById: admin.user.id, signupRequestId: row.id } });
  const response = await status(statusProof.issue(row));
  expect(response.body.invite).toMatchObject({ expired: true, status: 'Pending' });
  expect(response.body.invite).not.toHaveProperty('tokenHash');
});

test('retention deletes old measurements and removes request links while retaining recent sessions', async () => {
  const old = event(); const recent = event();
  await prisma.marketingVisit.create({ data: { id: old.visitId, page: '/', device: 'desktop', createdAt: new Date(Date.now() - 31 * 86400000) } });
  await prisma.marketingVisit.create({ data: { id: recent.visitId, page: '/', device: 'mobile' } });
  const row = await prisma.signupRequest.create({ data: { email: 'retained@example.org', marketingVisitId: old.visitId, utmSource: 'launch' } });
  await marketing.cleanup(prisma);
  expect(await prisma.marketingVisit.findUnique({ where: { id: old.visitId } })).toBeNull();
  expect(await prisma.marketingVisit.count()).toBe(1);
  expect(await prisma.signupRequest.findUnique({ where: { id: row.id } })).toMatchObject({ marketingVisitId: null, utmSource: 'launch' });
});
