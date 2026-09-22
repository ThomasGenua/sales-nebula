/**
 * Outbound URL guard.
 *
 * A webhook target is typed by a person and requested by the server, so an
 * unchecked one makes the application a proxy into its own network: the cloud
 * metadata endpoint, a database port on localhost, anything else behind the
 * firewall. Nothing validated the URL at either end.
 */

const request = require('supertest');
const {
  setup, teardown, cleanDatabase,
  createTestRole, createTestUser, authHeader,
} = require('./setup');
const { assertPublicHttpUrl, isPrivateAddress } = require('../src/utils/outboundUrl');

let app, prisma, admin;

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  const role = await createTestRole('Admin');
  admin = await createTestUser({ email: 'ssrf-admin@test.com', roleId: role.id });
});

describe('Reserved address detection', () => {
  it.each([
    ['169.254.169.254', 'cloud metadata'],
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private class A'],
    ['172.16.0.1', 'private class B'],
    ['192.168.1.1', 'private class C'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', 'this network'],
    ['::1', 'IPv6 loopback'],
    ['fd00::1', 'IPv6 unique local'],
    ['fe80::1', 'IPv6 link-local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
  ])('treats %s as reserved (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([['8.8.8.8'], ['1.1.1.1'], ['2001:4860:4860::8888']])('treats %s as public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('Outbound URL validation', () => {
  it.each([
    ['http://169.254.169.254/latest/meta-data/'],
    ['http://127.0.0.1:5432/'],
    ['http://localhost/hook'],
    ['https://10.0.0.5/hook'],
    ['http://[::1]/hook'],
    ['file:///etc/passwd'],
    ['gopher://example.com/'],
    ['not a url'],
    ['http://service.internal/hook'],
  ])('rejects %s', async (url) => {
    const verdict = await assertPublicHttpUrl(url, { resolve: false });
    expect(verdict.ok).toBe(false);
    expect(typeof verdict.reason).toBe('string');
  });

  it('allows an ordinary public https URL', async () => {
    expect((await assertPublicHttpUrl('https://example.com/hook', { resolve: false })).ok).toBe(true);
  });
});

describe('Webhook configuration', () => {
  it('refuses a webhook pointing at the metadata endpoint', async () => {
    const res = await request(app).post('/api/webhooks').set(authHeader(admin.token))
      .send({ name: 'Metadata', url: 'http://169.254.169.254/latest/meta-data/', events: ['deals.created'] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSAFE_WEBHOOK_URL');
    expect(await prisma.webhook.count()).toBe(0);
  });

  it('refuses a webhook pointing at loopback', async () => {
    const res = await request(app).post('/api/webhooks').set(authHeader(admin.token))
      .send({ name: 'Local', url: 'http://127.0.0.1:5432/', events: ['deals.created'] });
    expect(res.status).toBe(400);
  });

  it('accepts an ordinary public target', async () => {
    const res = await request(app).post('/api/webhooks').set(authHeader(admin.token))
      .send({ name: 'Public', url: 'https://example.com/hook', events: ['deals.created'] });
    expect(res.status).toBe(201);
  });

  it('refuses to be redirected inward by an update', async () => {
    const created = await request(app).post('/api/webhooks').set(authHeader(admin.token))
      .send({ name: 'Public', url: 'https://example.com/hook', events: ['deals.created'] });
    expect(created.status).toBe(201);

    const res = await request(app).put(`/api/webhooks/${created.body.id}`).set(authHeader(admin.token))
      .send({ url: 'http://169.254.169.254/' });
    expect(res.status).toBe(400);

    const after = await prisma.webhook.findUnique({ where: { id: created.body.id } });
    expect(after.url).toBe('https://example.com/hook');
  });
});
