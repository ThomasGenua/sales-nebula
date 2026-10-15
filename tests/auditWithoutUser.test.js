/**
 * Audit entries for changes no signed-in person made.
 *
 * AuditLog.userId was required, so the entry for a lead from the web form or
 * an invoice a job marked overdue failed to save, and the failure was only
 * logged. Those entries are kept now, with no user and the source in their
 * details. A person with entries still cannot be deleted, so an entry never
 * loses who made it.
 */
const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestUser, authHeader } = require('./setup');
const { setDatabaseClient, handlers } = require('../src/jobs/scheduler');

let app, prisma, admin, token;

beforeAll(async () => { ({ prisma, app } = await setup()); setDatabaseClient(prisma); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  ({ user: admin, token } = await createTestUser({ email: 'admin@test.com' }));
});

const fromTheForm = () => request(app).post('/api/public/web-to-lead')
  .send({ firstName: 'Ada', lastName: 'Lovelace', company: 'Acme', email: 'ada@acme.example' });

test('a lead from the web form is audited, with no user and where it came from', async () => {
  const res = await fromTheForm();
  expect(res.status).toBe(201);
  const entries = await prisma.auditLog.findMany({ where: { module: 'leads', recordId: res.body.leadId } });
  expect(entries).toEqual([expect.objectContaining({ action: 'create', userId: null, details: 'Created lead (web-to-lead)' })]);
});

test('an invoice a job marks overdue is audited', async () => {
  const invoice = await prisma.invoice.create({ data: { number: 'INV-1', status: 'Sent', dueDate: new Date(Date.now() - 86400000) } });
  expect(await handlers.checkOverdueInvoices()).toEqual({ updated: 1 });
  const entries = await prisma.auditLog.findMany({ where: { module: 'invoices', recordId: invoice.id } });
  expect(entries).toEqual([expect.objectContaining({ action: 'update', userId: null })]);
  expect(entries[0].details).toMatch(/\(past due\).*Overdue/);
});

test('the audit log lists an entry with no user beside one with a user', async () => {
  expect((await fromTheForm()).status).toBe(201);
  expect((await request(app).post('/api/contacts').set(authHeader(token)).send({ firstName: 'Grace', lastName: 'Hopper' })).status).toBe(201);

  const res = await request(app).get('/api/admin/audit-log').set(authHeader(token));
  expect(res.status).toBe(200);
  const who = res.body.data.filter(e => e.action === 'create').map(e => [e.module, e.user?.id ?? null]).sort();
  expect(who).toEqual([['contacts', admin.id], ['leads', null]]);
});

test('a person with entries still cannot be deleted, and the entries keep their name', async () => {
  const { user: rep } = await createTestUser({ email: 'rep@test.com' });
  await prisma.auditLog.create({ data: { action: 'login', module: 'auth', userId: rep.id } });

  const res = await request(app).delete(`/api/users/${rep.id}`).set(authHeader(token));
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('USER_HAS_HISTORY');
  expect(await prisma.auditLog.count({ where: { userId: rep.id } })).toBe(1);
});
