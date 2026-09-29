/**
 * CORS in production.
 *
 * Only the origins listed in FRONTEND_URL passed, so the app opened at any
 * other address of the same server (127.0.0.1 where FRONTEND_URL says
 * localhost, a LAN name) had its own scripts and stylesheets answered 403
 * "CORS: origin not allowed" and showed a blank page. A request whose Origin is
 * the host it was sent to is the page talking to its own server; any other
 * origin must still be listed.
 *
 * The app is required while NODE_ENV is "test" (the auth module resolves its
 * signing key on load, and in production would insist on a real one) and
 * created in production mode, which is when createApp reads it.
 */
const supertest = require('supertest');
const { PrismaClient } = require('@prisma/client');
const { createApp } = require('../src/app');

const original = { env: process.env.NODE_ENV, frontend: process.env.FRONTEND_URL };
let app, prisma;

beforeAll(() => {
  process.env.NODE_ENV = 'production';
  process.env.FRONTEND_URL = 'https://crm.example.test, https://admin.example.test';
  prisma = new PrismaClient();
  app = createApp(prisma);
  process.env.NODE_ENV = original.env;
});
afterAll(async () => {
  if (original.frontend === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = original.frontend;
  await prisma.$disconnect();
});

/** GET /api/health from a page at `origin`, sent to the server as `host`. */
const from = (origin, host) => {
  const req = supertest(app).get('/api/health');
  if (host) req.set('Host', host);
  if (origin) req.set('Origin', origin);
  return req;
};

describe('an origin listed in FRONTEND_URL', () => {
  it('passes, whatever the host it reached', async () => {
    for (const origin of ['https://crm.example.test', 'https://admin.example.test']) {
      const res = await from(origin, '10.0.0.5:7544');
      expect(res.status).not.toBe(403);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    }
  });
});

describe('a page talking to the server that served it', () => {
  it('passes at an address FRONTEND_URL does not list', async () => {
    for (const [origin, host] of [
      ['http://127.0.0.1:7801', '127.0.0.1:7801'],
      ['http://192.168.1.20:7544', '192.168.1.20:7544'],
      ['https://crm.lan', 'crm.lan'],
    ]) {
      const res = await from(origin, host);
      expect(res.status).not.toBe(403);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  it('gets its preflight answered', async () => {
    const res = await supertest(app).options('/api/auth/login')
      .set('Host', '127.0.0.1:7801').set('Origin', 'http://127.0.0.1:7801')
      .set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type,x-csrf-token');
    expect(res.status).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:7801');
    expect(res.headers['access-control-allow-headers']).toMatch(/X-CSRF-Token/i);
  });
});

describe('any other origin', () => {
  it('is refused with 403', async () => {
    const res = await from('https://evil.example.test', 'crm.example.test');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'CORS: origin not allowed' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('is refused when it only starts with, or contains, a listed one or the host', async () => {
    for (const [origin, host] of [
      ['https://crm.example.test.evil.test', 'crm.example.test'],
      ['https://evil.test/crm.example.test', 'crm.example.test'],
      ['https://notcrm.example.test', 'crm.example.test'],
    ]) {
      expect((await from(origin, host)).status).toBe(403);
    }
  });

  it('is refused on the same host at another port, which is another origin', async () => {
    expect((await from('http://localhost:9999', 'localhost:7801')).status).toBe(403);
  });

  it('is refused when the Origin is not a URL at all', async () => {
    expect((await from('null', 'crm.example.test')).status).toBe(403);
    expect((await from('garbage', 'garbage')).status).toBe(403);
  });
});

describe('a request with no Origin', () => {
  it('passes, as a command-line client or a same-origin GET sends none', async () => {
    const res = await from(undefined, 'crm.example.test');
    expect(res.status).not.toBe(403);
  });
});
