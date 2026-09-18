const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestRole, createTestUser, authHeader } = require('./setup');
const graph = require('../src/services/microsoftGraph');
const graphMailbox = require('../src/services/graphMailbox');
const { decrypt, encrypt } = require('../src/utils/secretBox');

let app, prisma, admin;
let calls;              // every outbound request the code made
let realFetch;

/** A Graph message as the API actually returns one. */
function graphMessage(overrides = {}) {
  return {
    id: 'AAMkAGI2_' + Math.random().toString(36).slice(2, 10),
    internetMessageId: `<${Math.random().toString(36).slice(2)}@contoso.com>`,
    conversationId: 'conv-1',
    subject: 'Cannot log in',
    bodyPreview: 'I am locked out',
    from: { emailAddress: { name: 'Rita Okafor', address: 'rita@contoso.com' } },
    toRecipients: [{ emailAddress: { address: 'support@ourco.com' } }],
    ccRecipients: [],
    receivedDateTime: '2026-09-18T09:00:00Z',
    hasAttachments: false,
    body: { contentType: 'text', content: 'I am locked out of my account.' },
    internetMessageHeaders: [],
    ...overrides,
  };
}

/** Stub fetch with a queue of handlers matched on URL. */
function stubFetch(routes) {
  global.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, method: init.method || 'GET', body: init.body });
    for (const [pattern, responder] of routes) {
      if (href.includes(pattern)) {
        const out = typeof responder === 'function' ? await responder(href, init) : responder;
        return {
          ok: (out.status || 200) < 400,
          status: out.status || 200,
          headers: { get: name => (out.headers || {})[String(name).toLowerCase()] || null },
          json: async () => out.body ?? {},
        };
      }
    }
    throw new Error('unstubbed fetch: ' + href);
  };
}

const TOKEN_URL = 'login.microsoftonline.com';
const tokenResponse = (over = {}) => ({ body: { access_token: 'access-1', refresh_token: 'refresh-2', expires_in: 3600, ...over } });

async function makeAccount(data = {}) {
  return prisma.inboundEmailAccount.create({
    data: {
      name: 'Support Mailbox',
      provider: 'microsoft',
      mailboxAddress: 'support@ourco.com',
      username: 'support@ourco.com',
      tenantId: 'tenant-abc',
      oauthRefreshToken: encrypt('refresh-1'),
      autoCreateCase: true,
      active: true,
      ...data,
    },
  });
}

beforeAll(async () => {
  ({ prisma, app } = await setup());
  realFetch = global.fetch;
});
afterAll(async () => { global.fetch = realFetch; await teardown(); });

beforeEach(async () => {
  await cleanDatabase();
  calls = [];
  process.env.MICROSOFT_CLIENT_ID = 'client-id';
  process.env.MICROSOFT_CLIENT_SECRET = 'client-secret';
  const role = await createTestRole('Admin');
  admin = await createTestUser({ email: 'admin@test.com', roleId: role.id });
});

describe('Graph message normalization', () => {
  it('maps a Graph message onto what the ingestion pipeline expects', () => {
    const out = graph.normalizeMessage(graphMessage({
      internetMessageHeaders: [
        { name: 'In-Reply-To', value: '<prior@contoso.com>' },
        { name: 'References', value: '<a@x.com> <b@x.com>' },
      ],
    }));

    expect(out.from).toBe('Rita Okafor <rita@contoso.com>');
    expect(out.to).toBe('support@ourco.com');
    expect(out.inReplyTo).toBe('<prior@contoso.com>');
    expect(out.references).toEqual(['<a@x.com>', '<b@x.com>']);
    expect(out.text).toBe('I am locked out of my account.');
    expect(out.graphId).toBeDefined();
  });

  it('keeps html separate from text', () => {
    const out = graph.normalizeMessage(graphMessage({
      body: { contentType: 'html', content: '<p>hello</p>' },
      bodyPreview: 'hello',
    }));
    expect(out.html).toBe('<p>hello</p>');
    expect(out.text).toBe('hello');
  });
});

describe('Token lifecycle', () => {
  it('refreshes an expired token and stores the rotation encrypted', async () => {
    const account = await makeAccount({ oauthExpiresAt: new Date(Date.now() - 1000) });
    stubFetch([[TOKEN_URL, tokenResponse()]]);

    const token = await graphMailbox.getAccessToken(prisma, account);
    expect(token).toBe('access-1');

    const saved = await prisma.inboundEmailAccount.findUnique({ where: { id: account.id } });
    expect(decrypt(saved.oauthAccessToken)).toBe('access-1');
    expect(decrypt(saved.oauthRefreshToken)).toBe('refresh-2');   // Microsoft rotated it
    expect(saved.oauthAccessToken).not.toContain('access-1');     // stored encrypted, not in the clear
  });

  it('reuses a cached token instead of spending a refresh', async () => {
    const account = await makeAccount({
      oauthAccessToken: encrypt('cached-token'),
      oauthExpiresAt: new Date(Date.now() + 30 * 60_000),
    });
    stubFetch([[TOKEN_URL, tokenResponse()]]);

    expect(await graphMailbox.getAccessToken(prisma, account)).toBe('cached-token');
    expect(calls).toHaveLength(0);
  });

  it('refuses clearly when the mailbox was never connected', async () => {
    const account = await makeAccount({ oauthRefreshToken: null });
    await expect(graphMailbox.getAccessToken(prisma, account)).rejects.toThrow(/not connected/i);
  });

  it('refreshes once and retries when Graph rejects the cached token', async () => {
    const account = await makeAccount({
      oauthAccessToken: encrypt('stale'),
      oauthExpiresAt: new Date(Date.now() + 30 * 60_000),
    });
    let attempt = 0;
    stubFetch([
      [TOKEN_URL, tokenResponse({ access_token: 'fresh' })],
      ['graph.microsoft.com', () => {
        attempt++;
        return attempt === 1
          ? { status: 401, body: { error: { message: 'token expired' } } }
          : { body: { displayName: 'Support', mail: 'support@ourco.com' } };
      }],
    ]);

    const result = await graphMailbox.testConnection(prisma, account);
    expect(result.connected).toBe(true);
    expect(attempt).toBe(2);
    expect(calls.some(c => c.url.includes(TOKEN_URL))).toBe(true);
  });
});

describe('Polling a mailbox', () => {
  it('fetches, ingests, opens a case and advances the watermark', async () => {
    const account = await makeAccount();
    const message = graphMessage();
    stubFetch([
      [TOKEN_URL, tokenResponse()],
      ['/messages', { body: { value: [message] } }],
    ]);

    const result = await graphMailbox.pollAccount(prisma, account);
    expect(result.processed).toBe(1);
    expect(result.casesCreated).toBe(1);

    const stored = await prisma.inboundEmailMessage.findMany({ where: { accountId: account.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0].fromEmail).toBe('rita@contoso.com');
    expect(stored[0].externalId).toBe(message.id);   // needed to reply in thread

    const cases = await prisma.case.findMany({ where: { origin: 'Email' } });
    expect(cases).toHaveLength(1);
    expect(cases[0].contactEmail).toBe('rita@contoso.com');

    const after = await prisma.inboundEmailAccount.findUnique({ where: { id: account.id } });
    expect(after.status).toBe('Idle');
    expect(after.lastSyncAt).not.toBeNull();
  });

  it('asks only for mail newer than the last sync', async () => {
    const account = await makeAccount({ lastSyncAt: new Date('2026-09-17T00:00:00Z') });
    stubFetch([[TOKEN_URL, tokenResponse()], ['/messages', { body: { value: [] } }]]);

    await graphMailbox.pollAccount(prisma, account);
    const listCall = calls.find(c => c.url.includes('/messages'));
    expect(decodeURIComponent(listCall.url)).toContain('receivedDateTime gt 2026-09-17T00:00:00.000Z');
  });

  it('does not create the same case twice when a message is seen again', async () => {
    const account = await makeAccount();
    const message = graphMessage();
    stubFetch([[TOKEN_URL, tokenResponse()], ['/messages', { body: { value: [message] } }]]);

    await graphMailbox.pollAccount(prisma, account);
    const second = await graphMailbox.pollAccount(prisma, await prisma.inboundEmailAccount.findUnique({ where: { id: account.id } }));

    expect(second.skipped).toBe(1);
    expect(await prisma.case.count()).toBe(1);
    expect(await prisma.inboundEmailMessage.count()).toBe(1);
  });

  it('records the failure on the account rather than throwing it away', async () => {
    const account = await makeAccount();
    stubFetch([
      [TOKEN_URL, tokenResponse()],
      ['graph.microsoft.com', { status: 429, headers: { 'retry-after': '30' }, body: { error: { message: 'throttled' } } }],
    ]);

    await expect(graphMailbox.pollAccount(prisma, account)).rejects.toMatchObject({ isThrottled: true });
    const after = await prisma.inboundEmailAccount.findUnique({ where: { id: account.id } });
    expect(after.status).toBe('Error');
    expect(after.lastError).toMatch(/throttled/i);
  });
});

describe('Replying from the mailbox that received it', () => {
  it('replies on the thread and logs it against the case', async () => {
    const account = await makeAccount();
    const message = graphMessage();
    stubFetch([
      [TOKEN_URL, tokenResponse()],
      ['/messages?', { body: { value: [message] } }],
      ['/reply', { status: 202, body: {} }],
    ]);
    await graphMailbox.pollAccount(prisma, account);

    const stored = await prisma.inboundEmailMessage.findFirst({ where: { accountId: account.id } });
    const res = await request(app)
      .post(`/api/inbound-email/messages/${stored.id}/reply`)
      .set(authHeader(admin.token))
      .send({ body: 'We have reset your password.' });

    expect(res.status).toBe(200);
    expect(res.body.replied).toBe(true);

    const replyCall = calls.find(c => c.url.includes('/reply'));
    expect(replyCall.method).toBe('POST');
    expect(replyCall.url).toContain(encodeURIComponent(message.id));
    expect(JSON.parse(replyCall.body).comment).toBe('We have reset your password.');

    const after = await prisma.inboundEmailMessage.findUnique({ where: { id: stored.id } });
    expect(after.status).toBe('Replied');
    expect(after.repliedAt).not.toBeNull();

    const comments = await prisma.caseComment.findMany({ where: { caseId: after.caseId } });
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe('We have reset your password.');
  });

  it('rejects an empty reply', async () => {
    const account = await makeAccount();
    const stored = await prisma.inboundEmailMessage.create({
      data: { accountId: account.id, fromEmail: 'rita@contoso.com', subject: 'x', externalId: 'abc', status: 'Received' },
    });
    const res = await request(app)
      .post(`/api/inbound-email/messages/${stored.id}/reply`)
      .set(authHeader(admin.token))
      .send({ body: '   ' });
    expect(res.status).toBe(400);
  });

  it('will not pretend to reply on a thread it has no id for', async () => {
    const account = await makeAccount();
    const stored = await prisma.inboundEmailMessage.create({
      data: { accountId: account.id, fromEmail: 'rita@contoso.com', subject: 'x', status: 'Received' },
    });
    const res = await request(app)
      .post(`/api/inbound-email/messages/${stored.id}/reply`)
      .set(authHeader(admin.token))
      .send({ body: 'hello' });
    expect(res.status).toBe(409);
  });
});

describe('Account administration', () => {
  it('creates a Microsoft account without demanding a host or password', async () => {
    const res = await request(app)
      .post('/api/inbound-email/accounts')
      .set(authHeader(admin.token))
      .send({ name: 'Support', provider: 'microsoft', mailboxAddress: 'support@ourco.com' });

    expect(res.status).toBe(201);
    expect(res.body.provider).toBe('microsoft');
    expect(res.body.oauthConnected).toBe(false);
  });

  it('never returns token material', async () => {
    const account = await makeAccount({ oauthAccessToken: encrypt('access-1') });
    const res = await request(app)
      .get(`/api/inbound-email/accounts/${account.id}`)
      .set(authHeader(admin.token));

    expect(res.status).toBe(200);
    expect(res.body.oauthConnected).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('refresh-1');
    expect(res.body.oauthRefreshToken).toBeUndefined();
    expect(res.body.oauthAccessToken).toBeUndefined();
  });

  it('stores tokens from the consent redirect', async () => {
    const account = await makeAccount({ oauthRefreshToken: null });
    stubFetch([
      [TOKEN_URL, tokenResponse({ refresh_token: 'granted-refresh' })],
      ['graph.microsoft.com', { body: { mail: 'support@ourco.com', displayName: 'Support' } }],
    ]);

    const res = await request(app)
      .post(`/api/inbound-email/accounts/${account.id}/microsoft/connect`)
      .set(authHeader(admin.token))
      .send({ code: 'auth-code', redirectUri: 'https://crm.test/callback' });

    expect(res.status).toBe(200);
    const saved = await prisma.inboundEmailAccount.findUnique({ where: { id: account.id } });
    expect(decrypt(saved.oauthRefreshToken)).toBe('granted-refresh');
  });

  it('builds a consent URL carrying the mail scopes', async () => {
    const account = await makeAccount();
    const res = await request(app)
      .get(`/api/inbound-email/accounts/${account.id}/microsoft/authorize-url?redirectUri=https://crm.test/cb`)
      .set(authHeader(admin.token));

    expect(res.status).toBe(200);
    expect(res.body.url).toContain('tenant-abc');
    expect(decodeURIComponent(res.body.url)).toContain('Mail.Send');
    expect(decodeURIComponent(res.body.url)).toContain('offline_access');
  });
});
