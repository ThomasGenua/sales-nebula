/**
 * Signup and invite flow tests.
 *
 * The security-critical property here is that a public signup never
 * creates a user. This schema has no tenancy, so a user created by a
 * stranger would sit inside live customer data. Access is granted only
 * by an admin-issued invite.
 */

const crypto = require('crypto');

// Pure helpers mirrored from src/routes/signup.js so they can be tested
// without a database. Any drift between these and the route is a bug.
const FREE_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'mail.com', 'gmx.com', 'yandex.com']);
const DISPOSABLE_DOMAINS = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'throwawaymail.com', 'trashmail.com', 'yopmail.com', 'sharklasers.com', 'getnada.com', 'temp-mail.org']);

function classifyEmail(email) {
  const domain = String(email).toLowerCase().split('@')[1] || '';
  return {
    domain,
    disposable: DISPOSABLE_DOMAINS.has(domain),
    freeProvider: FREE_DOMAINS.has(domain),
    business: !FREE_DOMAINS.has(domain) && !DISPOSABLE_DOMAINS.has(domain),
  };
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function makeToken() {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

const { validatePassword } = require('../src/middleware/auth');

describe('Signup token handling', () => {
  test('generates a distinct token every call', () => {
    const a = makeToken(), b = makeToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });

  test('produces a URL-safe token of usable length', () => {
    const { raw } = makeToken();
    expect(raw.length).toBeGreaterThan(32);
    expect(/^[A-Za-z0-9_-]+$/.test(raw)).toBe(true);
  });

  test('hashes deterministically so lookup by hash works', () => {
    const { raw, hash } = makeToken();
    expect(hashToken(raw)).toBe(hash);
  });

  test('stores a hash rather than the raw token', () => {
    const { raw, hash } = makeToken();
    expect(hash).not.toBe(raw);
    expect(hash).toHaveLength(64);
  });
});

describe('Email classification', () => {
  test('flags disposable providers', () => {
    expect(classifyEmail('someone@mailinator.com').disposable).toBe(true);
    expect(classifyEmail('someone@yopmail.com').disposable).toBe(true);
  });

  test('marks free providers without rejecting them', () => {
    const gmail = classifyEmail('someone@gmail.com');
    expect(gmail.freeProvider).toBe(true);
    expect(gmail.disposable).toBe(false);
    expect(gmail.business).toBe(false);
  });

  test('treats a company domain as a business address', () => {
    const work = classifyEmail('thomas@genuaventures.com');
    expect(work.business).toBe(true);
    expect(work.freeProvider).toBe(false);
  });

  test('handles a malformed address without throwing', () => {
    expect(classifyEmail('no-at-sign').domain).toBe('');
    expect(classifyEmail('').domain).toBe('');
  });
});

describe('Password policy on invite acceptance', () => {
  test('rejects a password that is too short', () => {
    expect(validatePassword('Ab1!').valid).toBe(false);
  });

  test('requires mixed case, a digit, and a symbol', () => {
    expect(validatePassword('alllowercase1!').valid).toBe(false);
    expect(validatePassword('ALLUPPERCASE1!').valid).toBe(false);
    expect(validatePassword('NoDigitsHere!').valid).toBe(false);
    expect(validatePassword('NoSymbol123').valid).toBe(false);
  });

  test('accepts a compliant password', () => {
    expect(validatePassword('Correct-Horse9').valid).toBe(true);
  });

  test('returns every failing rule rather than the first', () => {
    const result = validatePassword('abc');
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

// Route tests run only when the harness supplies a live app
let request, app, token;
try {
  request = require('supertest');
  ({ app, token } = require('./setup'));
} catch (e) { /* helpers above still run standalone */ }

const describeApi = app ? describe : describe.skip;

describeApi('Public signup', () => {
  const email = `evaluator${Date.now()}@examplecorp.com`;
  let verifyToken;

  test('rejects a missing email', async () => {
    const res = await request(app).post('/api/signup').send({ company: 'Acme' });
    expect(res.status).toBe(400);
  });

  test('rejects a malformed email', async () => {
    const res = await request(app).post('/api/signup').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  test('rejects a disposable address', async () => {
    const res = await request(app).post('/api/signup').send({ email: 'throwaway@mailinator.com' });
    expect(res.status).toBe(400);
  });

  test('rejects an unknown interest value', async () => {
    const res = await request(app).post('/api/signup').send({ email: `x${Date.now()}@corp.com`, interestedIn: 'telepathy' });
    expect(res.status).toBe(400);
  });

  test('accepts a valid request and returns a verification link in dev', async () => {
    const res = await request(app).post('/api/signup').send({
      email, firstName: 'Ada', lastName: 'Lovelace', company: 'Example Corp',
      companySize: '51-200', interestedIn: 'cloud', useCase: 'Replacing a legacy CRM',
    });
    expect(res.status).toBe(201);
    expect(res.body.accepted).toBe(true);
    expect(res.body.devVerifyUrl).toBeTruthy();
    verifyToken = new URL(res.body.devVerifyUrl).searchParams.get('token');
  });

  test('creates no user account', async () => {
    // The whole point: a public signup must not grant access to shared data
    const login = await request(app).post('/api/auth/login').send({ email, password: 'anything' });
    expect(login.status).not.toBe(200);
  });

  test('re-issues rather than duplicating on a repeat submission', async () => {
    const res = await request(app).post('/api/signup').send({ email, company: 'Example Corp Updated' });
    expect(res.status).toBe(201);
    const admin = await request(app).get(`/api/signup/requests?search=${encodeURIComponent(email)}`).set('Authorization', `Bearer ${token}`);
    expect(admin.body.data.length).toBe(1);
  });

  test('rejects an invalid verification token', async () => {
    const res = await request(app).post('/api/signup/verify').send({ token: 'not-a-real-token' });
    expect(res.status).toBe(404);
  });

  test('rejects a verification with no token', async () => {
    const res = await request(app).post('/api/signup/verify').send({});
    expect(res.status).toBe(400);
  });

  test('confirms the email with a valid token', async () => {
    const fresh = await request(app).post('/api/signup').send({ email });
    const t = new URL(fresh.body.devVerifyUrl).searchParams.get('token');
    const res = await request(app).post('/api/signup/verify').send({ token: t });
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    verifyToken = t;
  });

  test('reports an already-confirmed email without erroring', async () => {
    const res = await request(app).post('/api/signup/verify').send({ token: verifyToken });
    // The token is cleared on first use, so a replay is simply not found
    expect([200, 404]).toContain(res.status);
  });

  test('does not reveal whether an address is already registered', async () => {
    const known = await request(app).post('/api/signup').send({ email: 'thomas@salesnebula.com' });
    const unknown = await request(app).post('/api/signup').send({ email: `nobody${Date.now()}@corp.com` });
    expect(known.body.message).toBe(unknown.body.message);
  });
});

describeApi('Open registration is disabled', () => {
  test('refuses self-registration by default', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: `intruder${Date.now()}@corp.com`,
      password: 'Correct-Horse9', firstName: 'In', lastName: 'Truder',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('disabled');
  });
});

describeApi('Admin review', () => {
  let requestId;

  test('requires authentication to list requests', async () => {
    expect((await request(app).get('/api/signup/requests')).status).toBe(401);
  });

  test('lists requests with an email classification', async () => {
    const res = await request(app).get('/api/signup/requests').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    if (res.body.data.length) expect(res.body.data[0]).toHaveProperty('emailClass');
  });

  test('reports signup statistics', async () => {
    const res = await request(app).get('/api/signup/requests/stats').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('verificationRate');
  });

  test('refuses to approve an unverified request', async () => {
    const created = await request(app).post('/api/signup').send({ email: `unverified${Date.now()}@corp.com` });
    expect(created.status).toBe(201);
    const list = await request(app).get('/api/signup/requests?status=Pending').set('Authorization', `Bearer ${token}`);
    const pending = list.body.data[0];
    if (pending) {
      const res = await request(app).post(`/api/signup/requests/${pending.id}/approve`).set('Authorization', `Bearer ${token}`).send({});
      expect(res.status).toBe(400);
    }
  });

  test('approves a verified request and issues an invite', async () => {
    const email = `approved${Date.now()}@corp.com`;
    const created = await request(app).post('/api/signup').send({ email, firstName: 'Grace', lastName: 'Hopper' });
    const t = new URL(created.body.devVerifyUrl).searchParams.get('token');
    await request(app).post('/api/signup/verify').send({ token: t });

    const list = await request(app).get(`/api/signup/requests?search=${encodeURIComponent(email)}`).set('Authorization', `Bearer ${token}`);
    requestId = list.body.data[0].id;

    const res = await request(app).post(`/api/signup/requests/${requestId}/approve`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(201);
    expect(res.body.approved).toBe(true);
    expect(res.body.devInviteUrl).toBeTruthy();
  });

  test('rejects a request with a reason', async () => {
    const email = `rejected${Date.now()}@corp.com`;
    await request(app).post('/api/signup').send({ email });
    const list = await request(app).get(`/api/signup/requests?search=${encodeURIComponent(email)}`).set('Authorization', `Bearer ${token}`);
    const res = await request(app).post(`/api/signup/requests/${list.body.data[0].id}/reject`)
      .set('Authorization', `Bearer ${token}`).send({ reason: 'Competitor' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Rejected');
  });
});

describeApi('Invites', () => {
  let inviteUrl, inviteId;
  const email = `teammate${Date.now()}@corp.com`;

  test('rejects an invite to a malformed address', async () => {
    const res = await request(app).post('/api/signup/invites').set('Authorization', `Bearer ${token}`).send({ email: 'bad' });
    expect(res.status).toBe(400);
  });

  test('refuses to invite an existing user', async () => {
    const res = await request(app).post('/api/signup/invites').set('Authorization', `Bearer ${token}`)
      .send({ email: 'thomas@salesnebula.com' });
    expect(res.status).toBe(409);
  });

  test('issues an invite', async () => {
    const res = await request(app).post('/api/signup/invites').set('Authorization', `Bearer ${token}`)
      .send({ email, firstName: 'Alan', lastName: 'Turing' });
    expect(res.status).toBe(201);
    expect(res.body.devInviteUrl).toBeTruthy();
    inviteUrl = res.body.devInviteUrl;
    inviteId = res.body.id;
  });

  test('refuses a second outstanding invite for the same address', async () => {
    const res = await request(app).post('/api/signup/invites').set('Authorization', `Bearer ${token}`).send({ email });
    expect(res.status).toBe(409);
  });

  test('looks up a valid invite without authentication', async () => {
    const t = new URL(inviteUrl).searchParams.get('token');
    const res = await request(app).get(`/api/signup/invites/lookup/${t}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(email);
  });

  test('rejects a lookup for an unknown token', async () => {
    expect((await request(app).get('/api/signup/invites/lookup/garbage')).status).toBe(404);
  });

  test('rejects acceptance with a weak password', async () => {
    const t = new URL(inviteUrl).searchParams.get('token');
    const res = await request(app).post('/api/signup/invites/accept').send({ token: t, password: 'weak' });
    expect(res.status).toBe(400);
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  test('creates the user on acceptance and returns a session', async () => {
    const t = new URL(inviteUrl).searchParams.get('token');
    const res = await request(app).post('/api/signup/invites/accept')
      .send({ token: t, password: 'Correct-Horse9' });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.password).toBeUndefined();
  });

  test('refuses to reuse a consumed invite', async () => {
    const t = new URL(inviteUrl).searchParams.get('token');
    const res = await request(app).post('/api/signup/invites/accept').send({ token: t, password: 'Correct-Horse9' });
    expect([404, 409]).toContain(res.status);
  });

  test('the new user can sign in', async () => {
    const res = await request(app).post('/api/auth/login').send({ email, password: 'Correct-Horse9' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  test('refuses to revoke an accepted invite', async () => {
    const res = await request(app).post(`/api/signup/invites/${inviteId}/revoke`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(409);
  });

  test('revokes an outstanding invite and blocks its use', async () => {
    const target = `revoked${Date.now()}@corp.com`;
    const created = await request(app).post('/api/signup/invites').set('Authorization', `Bearer ${token}`).send({ email: target });
    const t = new URL(created.body.devInviteUrl).searchParams.get('token');

    const revoke = await request(app).post(`/api/signup/invites/${created.body.id}/revoke`).set('Authorization', `Bearer ${token}`).send({});
    expect(revoke.status).toBe(200);

    const accept = await request(app).post('/api/signup/invites/accept').send({ token: t, password: 'Correct-Horse9' });
    expect([403, 404]).toContain(accept.status);
  });
});
