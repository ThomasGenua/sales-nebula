/**
 * Every GET route, called as an administrator, must not answer 5xx.
 *
 * This is the runtime half of tests/schemaFields.test.js. The static checker
 * reads column names in literal Prisma calls; this calls the endpoints and
 * catches what a static read cannot — a handler that dereferences a record
 * that was not found, a relation that is not there, an operator Prisma
 * rejects. Ids in the path are a well-formed UUID that matches nothing, so
 * the right answer is 404, not a crash.
 *
 * Like the schema check it is a ratchet: the count of failing routes may not
 * rise, and when it falls the baseline comes down with it.
 *
 * CRAWL_REPORT=1 prints every failing route with its error.
 */

const request = require('supertest');
const crypto = require('node:crypto');
const { setup, teardown, cleanDatabase, createTestRole, createTestUser, authHeader } = require('./setup');
const { collectGetRoutes } = require('../scripts/collect-routes');

// Lower this as routes are fixed. Never raise it. It was left at Infinity,
// which made the ratchet below unable to fail; a crawl of all 522 GET routes
// answers no 5xx, so it is 0 and a route that starts to fail now fails this.
const BASELINE = 0;

let app, prisma, admin;
const failures = [];
let crawled = 0;
const providerEnv = ['ENTERPRISE_SSO_ENABLED', 'ENTERPRISE_EMAIL_DOMAINS', 'SAML_ENTRY_POINT', 'SAML_IDP_ISSUER', 'SAML_IDP_CERT', 'SAML_SP_PRIVATE_KEY', 'SAML_SP_CERT', 'SCIM_BEARER_TOKEN'];
const previousEnv = Object.fromEntries(providerEnv.map(key => [key, process.env[key]]));
const scimHeader = { Authorization: 'Bearer smoke-test-provisioning-token-not-a-live-credential' };

beforeAll(async () => {
  // Exercise configured handlers without contacting an identity provider. Their
  // intentional disabled-state 503 responses are checked separately below.
  Object.assign(process.env, {
    ENTERPRISE_SSO_ENABLED: 'true', ENTERPRISE_EMAIL_DOMAINS: 'example.test',
    SAML_ENTRY_POINT: 'https://identity.example.test/saml', SAML_IDP_ISSUER: 'https://identity.example.test',
    SAML_IDP_CERT: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'pem', type: 'spki' }),
    SAML_SP_PRIVATE_KEY: '', SAML_SP_CERT: '', SCIM_BEARER_TOKEN: scimHeader.Authorization.slice(7),
  });
  ({ prisma, app } = await setup());
  await cleanDatabase();
  const role = await createTestRole('Admin');
  const salesRole = await createTestRole('Sales Rep');
  admin = await createTestUser({ email: 'crawler@test.com', roleId: role.id });
  const provisioned = await createTestUser({ email: 'provisioned@example.test', roleId: salesRole.id });
  await prisma.scimIdentity.create({ data: { userId: provisioned.user.id, externalId: 'crawler-provisioned' } });

  // A little real data, so list handlers walk rows rather than an empty set.
  const account = await prisma.account.create({ data: { name: 'Crawler Co', industry: 'Software', type: 'Customer' } });
  const contact = await prisma.contact.create({ data: { firstName: 'Cora', lastName: 'Crawler', email: 'cora@crawler.test', accountId: account.id, ownerId: admin.user.id } });
  await prisma.deal.create({ data: { name: 'Crawl deal', value: 1000, stage: 'Prospecting', closeDate: new Date(), ownerId: admin.user.id, accountId: account.id, contactId: contact.id } });
  await prisma.lead.create({ data: { firstName: 'Lee', lastName: 'Crawl', company: 'Crawler Co', email: 'lee@crawler.test', ownerId: admin.user.id } });
  await prisma.case.create({ data: { caseNumber: 'CS-CRAWL-1', subject: 'Crawler case', type: 'Problem', status: 'Open', priority: 'Medium', contactId: contact.id } });

  for (const route of collectGetRoutes()) {
    crawled++;
    try {
      const res = await request(app).get(route.url).set(route.mount === '/api/scim/v2' ? scimHeader : authHeader(admin.token)).timeout({ response: 15000 });
      if (res.status >= 500) {
        const message = typeof res.body?.error === 'string' ? res.body.error : JSON.stringify(res.body || res.text).slice(0, 300);
        failures.push({ ...route, status: res.status, message });
      }
    } catch (err) {
      failures.push({ ...route, status: 'error', message: err.message });
    }
  }

  if (process.env.CRAWL_REPORT) {
    const oneLine = s => String(s).replace(/\s+/g, ' ').replace(/\\n/g, ' ').slice(0, 220);
    console.log(`crawled ${crawled} GET routes, ${failures.length} answered 5xx\n` + failures
      .map(f => `${f.status}  ${f.url}   (${f.file}:${f.line})\n      ${oneLine(f.message)}`)
      .join('\n'));
  }
}, 600000);

afterAll(async () => {
  for (const key of providerEnv) {
    if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key];
  }
  await teardown();
});

describe('GET route smoke', () => {
  it('found the routes to crawl', () => {
    expect(crawled).toBeGreaterThan(400);
  });

  it('has no more failing routes than the recorded baseline', () => {
    const detail = failures.map(f => `  ${f.status} ${f.url} (${f.file}:${f.line}) ${String(f.message).slice(0, 120)}`).join('\n');
    expect(`${failures.length} failing routes\n${failures.length > BASELINE ? detail : ''}`)
      .toBe(`${Math.min(failures.length, BASELINE)} failing routes\n`);
  });

  it('keeps the baseline honest when routes are fixed', () => {
    // If this fails, fewer routes fail than recorded: lower BASELINE.
    if (Number.isFinite(BASELINE)) expect(failures.length).toBe(BASELINE);
  });

  it('serves configured SAML metadata and authenticated SCIM discovery', async () => {
    const metadata = await request(app).get('/api/enterprise/saml/metadata').expect(200);
    expect(metadata.text).toContain('EntityDescriptor');
    const schema = await request(app).get('/api/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:User').set(scimHeader).expect(200);
    expect(schema.body.id).toBe('urn:ietf:params:scim:schemas:core:2.0:User');
    const users = await request(app).get('/api/scim/v2/Users').set(scimHeader).expect(200);
    expect(users.body.Resources).toEqual([expect.objectContaining({ userName: 'provisioned@example.test' })]);
    await request(app).get('/api/scim/v2/Users/' + users.body.Resources[0].id).set(scimHeader).expect(200);
    await request(app).get('/api/scim/v2/ServiceProviderConfig').set(authHeader(admin.token)).expect(401);
  });

  it('reports unconfigured enterprise integrations explicitly', async () => {
    process.env.ENTERPRISE_SSO_ENABLED = 'false';
    delete process.env.SCIM_BEARER_TOKEN;
    try {
      const metadata = await request(app).get('/api/enterprise/saml/metadata').expect(503);
      expect(metadata.body.error).toBe('SAML is not configured');
      const scim = await request(app).get('/api/scim/v2/ServiceProviderConfig').expect(503);
      expect(scim.body.detail).toBe('SCIM is not configured');
    } finally {
      process.env.ENTERPRISE_SSO_ENABLED = 'true';
      process.env.SCIM_BEARER_TOKEN = scimHeader.Authorization.slice(7);
    }
  });
});
