/**
 * Changes to people and to sign-in that the audit log missed.
 *
 * Creating a user was audited and deleting one was not; changing an SSO
 * configuration, or turning on or removing someone's second factor, wrote no
 * entry at all. Each now records who did it, and no entry carries a secret.
 */
const request = require('supertest');
const { hotp, base32Decode } = require('../src/utils/totp');
const { setup, teardown, cleanDatabase, createTestUser, authHeader } = require('./setup');

let app, prisma, admin, token;
const PASSWORD = 'Test123!@';

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  ({ user: admin, token } = await createTestUser({ email: 'admin@test.com' }));
});

const api = (method, path, body = {}) => request(app)[method](path).set(authHeader(token)).send(body);
const entries = where => prisma.auditLog.findMany({ where, orderBy: { createdAt: 'asc' } });

test('deleting a user is audited, naming who was deleted', async () => {
  const { user: leaver } = await createTestUser({ email: 'leaver@test.com' });
  const res = await api('delete', `/api/users/${leaver.id}`);
  expect(res.status).toBe(200);
  const [entry] = await entries({ module: 'users', action: 'delete', recordId: leaver.id });
  expect(entry).toMatchObject({ userId: admin.id, details: 'Deleted user leaver@test.com' });
});

test('creating and changing an SSO configuration is audited, without its secret', async () => {
  const created = await api('post', '/api/security/sso', { provider: 'oidc', name: 'Okta', clientId: 'abc', clientSecret: 'shh-secret' });
  expect(created.status).toBe(201);
  expect((await api('put', `/api/security/sso/${created.body.id}`, { name: 'Okta EU' })).status).toBe(200);

  const logged = await entries({ module: 'security', recordId: created.body.id });
  expect(logged.map(e => [e.action, e.details, e.userId])).toEqual([
    ['create', 'SSO configuration created: Okta (oidc)', admin.id],
    ['update', 'SSO configuration updated: Okta EU (oidc)', admin.id],
  ]);
  expect(JSON.stringify(logged)).not.toContain('shh-secret');
});

test('turning on and removing a second factor is audited, without its secret or code', async () => {
  const enrolled = await api('post', '/api/security/mfa/enroll', { type: 'totp', currentPassword: PASSWORD });
  expect(enrolled.status).toBe(201);
  const code = hotp(base32Decode(enrolled.body.secret), Math.floor(Date.now() / 1000 / 30));
  expect((await api('post', '/api/security/mfa/verify', { deviceId: enrolled.body.deviceId, code })).status).toBe(200);
  expect((await api('delete', `/api/security/mfa/devices/${enrolled.body.deviceId}`, { currentPassword: PASSWORD })).status).toBe(200);

  const logged = await entries({ module: 'security', recordId: enrolled.body.deviceId });
  expect(logged.map(e => [e.action, e.details, e.userId])).toEqual([
    ['update', 'Two-factor authentication device verified', admin.id],
    ['delete', 'Two-factor authentication device removed', admin.id],
  ]);
  expect(JSON.stringify(logged)).not.toContain(enrolled.body.secret);
  expect(JSON.stringify(logged)).not.toContain(code);
});

test('a refused change writes no entry', async () => {
  const enrolled = await api('post', '/api/security/mfa/enroll', { type: 'totp', currentPassword: PASSWORD });
  expect((await api('post', '/api/security/mfa/verify', { deviceId: enrolled.body.deviceId, code: '000000' })).status).toBe(400);
  expect((await api('delete', `/api/security/mfa/devices/${enrolled.body.deviceId}`, {})).status).toBe(403);
  expect(await entries({ module: 'security' })).toHaveLength(0);
});
