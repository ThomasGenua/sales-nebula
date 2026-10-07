/**
 * Webhook delivery does not follow redirects.
 *
 * The target's address is checked before the call (assertPublicHttpUrl) but
 * fetch followed a 3xx on its own to an address that was not, re-sending the
 * signed event there and keeping the answer in the delivery log. The address
 * check is mocked out here so two servers on the loopback can stand in for a
 * public endpoint (A) and an internal one (B).
 */
jest.mock('../src/utils/outboundUrl', () => ({ assertPublicHttpUrl: async () => ({ ok: true }) }));

const http = require('http');
const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestRole, createTestUser, authHeader } = require('./setup');
const { fireWebhookEvent } = require('../src/services/webhooks');

let prisma, app, user;
const servers = [];

/** A local server, and the requests it has seen. */
function listen(handler) {
  return new Promise(resolve => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res); });
    });
    server.listen(0, '127.0.0.1', () => { servers.push(server); resolve({ url: `http://127.0.0.1:${server.address().port}`, seen }); });
  });
}

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting for a webhook delivery');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

const makeWebhook = (url, over = {}) => prisma.webhook.create({
  data: { name: 'Probe', url, events: ['deal.created'], secret: 'shh', active: true, retries: 1, createdById: user.user.id, ...over },
});
const firstLog = webhookId => until(() => prisma.webhookLog.findFirst({ where: { webhookId } }));

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => {
  // fetch keeps its connections alive, and close() would wait for them.
  await Promise.all(servers.map(server => new Promise(resolve => {
    server.closeAllConnections?.();
    server.close(resolve);
  })));
  await teardown();
});
beforeEach(async () => {
  await cleanDatabase();
  const role = await createTestRole('Admin');
  user = await createTestUser({ email: 'hooks@test.com', roleId: role.id });
});

describe('webhook delivery', () => {
  it('does not follow a redirect to another address, and does not keep what that address says', async () => {
    const internal = await listen((req, res) => res.end('internal-secret-body'));
    const publicEndpoint = await listen((req, res) => { res.writeHead(307, { Location: `${internal.url}/latest/meta-data` }); res.end(); });
    const hook = await makeWebhook(`${publicEndpoint.url}/hook`);

    await fireWebhookEvent(prisma, 'deal.created', { id: 'deal-1' });
    const log = await firstLog(hook.id);

    expect(publicEndpoint.seen).toHaveLength(1);
    expect(internal.seen).toHaveLength(0);
    expect(log.success).toBe(false);
    expect(log.statusCode).toBe(307);
    expect(log.response).toMatch(/Redirect \(307\).*not followed/);
    expect(log.response).not.toMatch(/internal-secret-body/);
  });

  it('does not retry a redirect, which would answer the same way again', async () => {
    const elsewhere = await listen((req, res) => res.end('ok'));
    const redirecting = await listen((req, res) => { res.writeHead(302, { Location: elsewhere.url }); res.end(); });
    const hook = await makeWebhook(redirecting.url, { retries: 3 });

    await fireWebhookEvent(prisma, 'deal.created', { id: 'deal-2' });
    await firstLog(hook.id);
    await new Promise(resolve => setTimeout(resolve, 2500)); // the first retry would be due after 2 seconds

    expect(await prisma.webhookLog.count({ where: { webhookId: hook.id } })).toBe(1);
    expect(redirecting.seen).toHaveLength(1);
    expect(elsewhere.seen).toHaveLength(0);
  });

  it('still delivers to an address that answers directly, signed', async () => {
    const endpoint = await listen((req, res) => res.end('received'));
    const hook = await makeWebhook(`${endpoint.url}/hook`);

    await fireWebhookEvent(prisma, 'deal.created', { id: 'deal-3' });
    const log = await firstLog(hook.id);

    expect(log).toMatchObject({ success: true, statusCode: 200, response: 'received' });
    expect(endpoint.seen).toHaveLength(1);
    expect(endpoint.seen[0].method).toBe('POST');
    expect(endpoint.seen[0].headers['x-webhook-event']).toBe('deal.created');
    expect(endpoint.seen[0].headers['x-webhook-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(endpoint.seen[0].body).data).toMatchObject({ id: 'deal-3' });
  });
});

describe('testing a webhook', () => {
  it('pings the webhook tested, and no other', async () => {
    // The one tested takes deal events only; the other takes test.ping. The
    // test was an event, so it went to the other and never to this one.
    const tested = await listen((req, res) => res.end('ok'));
    const bystander = await listen((req, res) => res.end('ok'));
    const hook = await makeWebhook(`${tested.url}/hook`);
    const other = await makeWebhook(`${bystander.url}/hook`, { events: ['test.ping'] });

    const res = await request(app).post(`/api/webhooks/${hook.id}/test`).set(authHeader(user.token));
    expect(res.status).toBe(200);
    const log = await firstLog(hook.id);

    expect(log).toMatchObject({ success: true, event: 'test.ping' });
    expect(tested.seen).toHaveLength(1);
    expect(JSON.parse(tested.seen[0].body).data).toMatchObject({ webhookId: hook.id });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(bystander.seen).toHaveLength(0);
    expect(await prisma.webhookLog.count({ where: { webhookId: other.id } })).toBe(0);
  });
});
