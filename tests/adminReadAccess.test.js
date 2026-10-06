/**
 * What `admin: read` reaches on its own.
 *
 * The seeded Sales Rep role has admin read ("limited admin": setup screens such
 * as Studio and Security Groups, read only). It also reached every user's
 * sign-ins with their IP addresses, the log of privacy requests, and the
 * admin dashboard's organisation-wide totals, which include deals the rep
 * cannot open. Those now take user-management read (sign-ins, the dashboard)
 * or admin edit (privacy requests) as well.
 */
const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestRole, createTestUser } = require('./setup');

const MODULES = ['contacts', 'leads', 'deals', 'accounts', 'activities', 'emails', 'cases', 'documents', 'campaigns', 'products', 'quotes', 'invoices', 'workflows', 'users', 'roles', 'settings', 'admin', 'reports', 'forecasts', 'territories', 'knowledge', 'chatter', 'formulas', 'approvals'];
// The grants the seed and the production bootstrap give these roles.
const GRANTS = {
  Admin: () => 'full',
  Manager: m => ['users', 'roles', 'settings', 'admin'].includes(m) ? 'read' : 'full',
  'Sales Rep': m => ['users', 'roles', 'settings'].includes(m) ? 'none' : ['products', 'invoices', 'workflows', 'admin'].includes(m) ? 'read' : 'edit',
  'Read Only': () => 'read',
};

let app, prisma;
const tokens = {};

beforeAll(async () => {
  ({ prisma, app } = await setup());
  await cleanDatabase();
  for (const [name, level] of Object.entries(GRANTS)) {
    const role = await createTestRole(name, MODULES.map(module => ({ module, level: level(module) })));
    const slug = name.toLowerCase().replace(/\s+/g, '-');
    tokens[name] = (await createTestUser({ email: `${slug}@admin-read.test`, roleId: role.id })).token;
  }
  // Something for each list to hold.
  const anyUser = await prisma.user.findFirst();
  await prisma.loginHistory.create({ data: { userId: anyUser.id, status: 'Success', sourceIp: '203.0.113.7', loginTime: new Date() } });
  await prisma.loginHistory.create({ data: { userId: anyUser.id, status: 'Failed', sourceIp: '198.51.100.9', loginTime: new Date() } });
});

afterAll(async () => { await teardown(); });

const get = (path, role) => request(app).get(path).set('Authorization', `Bearer ${tokens[role]}`);

/** The status each role gets, in the order Admin, Manager, Sales Rep, Read Only. */
async function statuses(path) {
  const out = [];
  for (const role of ['Admin', 'Manager', 'Sales Rep', 'Read Only']) out.push((await get(path, role)).status);
  return out;
}

describe('Sign-in records take user-management read', () => {
  test('login history', async () => {
    expect(await statuses('/api/monitoring/login-history')).toEqual([200, 200, 403, 200]);
    const res = await get('/api/monitoring/login-history', 'Sales Rep');
    expect(JSON.stringify(res.body)).not.toContain('203.0.113.7');
  });

  test('active sessions and failed sign-ins', async () => {
    expect(await statuses('/api/security/sessions')).toEqual([200, 200, 403, 200]);
    expect(await statuses('/api/security/threats')).toEqual([200, 200, 403, 200]);
  });
});

describe('The admin dashboard takes user-management read', () => {
  test('organisation-wide figures and the activity feed', async () => {
    expect(await statuses('/api/admin/dashboard/system')).toEqual([200, 200, 403, 200]);
    expect(await statuses('/api/admin/dashboard/activity')).toEqual([200, 200, 403, 200]);
  });
});

describe('Privacy requests take admin edit, as logging one does', () => {
  test('the list and a single request', async () => {
    const dsr = await prisma.dataSubjectRequest.create({ data: { requestType: 'erasure', subjectType: 'email', email: 'subject@example.com' } });
    expect(await statuses('/api/privacy/requests')).toEqual([200, 403, 403, 403]);
    expect(await statuses(`/api/privacy/requests/${dsr.id}`)).toEqual([200, 403, 403, 403]);
    const res = await get('/api/privacy/requests', 'Admin');
    expect(res.body.data.map(r => r.email)).toContain('subject@example.com');
  });
});

describe('Admin read still reaches setup configuration', () => {
  test('a rep can still read the Studio overview and the security group tree', async () => {
    expect((await get('/api/studio/overview', 'Sales Rep')).status).toBe(200);
    expect((await get('/api/security-groups/tree/all', 'Sales Rep')).status).toBe(200);
  });
});
