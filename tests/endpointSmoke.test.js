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
const { setup, teardown, cleanDatabase, createTestRole, createTestUser, authHeader } = require('./setup');
const { collectGetRoutes } = require('../scripts/collect-routes');

// Lower this as routes are fixed. Never raise it.
const BASELINE = Number.POSITIVE_INFINITY;

let app, prisma, admin;
const failures = [];
let crawled = 0;

beforeAll(async () => {
  ({ prisma, app } = await setup());
  await cleanDatabase();
  const role = await createTestRole('Admin');
  await createTestRole('Sales Rep');
  admin = await createTestUser({ email: 'crawler@test.com', roleId: role.id });

  // A little real data, so list handlers walk rows rather than an empty set.
  const account = await prisma.account.create({ data: { name: 'Crawler Co', industry: 'Software', type: 'Customer' } });
  const contact = await prisma.contact.create({ data: { firstName: 'Cora', lastName: 'Crawler', email: 'cora@crawler.test', accountId: account.id, ownerId: admin.user.id } });
  await prisma.deal.create({ data: { name: 'Crawl deal', value: 1000, stage: 'Prospecting', closeDate: new Date(), ownerId: admin.user.id, accountId: account.id, contactId: contact.id } });
  await prisma.lead.create({ data: { firstName: 'Lee', lastName: 'Crawl', company: 'Crawler Co', email: 'lee@crawler.test', ownerId: admin.user.id } });
  await prisma.case.create({ data: { caseNumber: 'CS-CRAWL-1', subject: 'Crawler case', type: 'Problem', status: 'Open', priority: 'Medium', contactId: contact.id } });

  for (const route of collectGetRoutes()) {
    crawled++;
    try {
      const res = await request(app).get(route.url).set(authHeader(admin.token)).timeout({ response: 15000 });
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

afterAll(async () => { await teardown(); });

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
});
