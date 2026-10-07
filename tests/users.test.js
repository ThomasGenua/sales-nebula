/**
 * Managing users from the Users screen: deactivating and reactivating, roles,
 * the reset link an administrator sends, and invites. The API took most of
 * this already; these are the rules the screen leans on.
 */
const request = require('supertest');
const {
  setup, teardown, cleanDatabase, createTestRole, createTestUser, authHeader,
} = require('./setup');

let app, prisma, admin;

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  admin = await createTestUser({ email: 'admin@users.test' });
});

const as = token => ({
  get: path => request(app).get(path).set(authHeader(token)),
  put: (path, body) => request(app).put(path).set(authHeader(token)).send(body),
  post: (path, body = {}) => request(app).post(path).set(authHeader(token)).send(body),
  del: path => request(app).delete(path).set(authHeader(token)),
});

const repRole = () => createTestRole('Sales Rep', [{ module: 'contacts', level: 'edit' }]);
/** Manages users, but is no administrator. */
const managerRole = () => createTestRole('User Manager', [
  { module: 'users', level: 'full' }, { module: 'roles', level: 'read' }, { module: 'contacts', level: 'full' },
]);

describe('the user list', () => {
  test('lists users with their roles and no passwords, to anyone who may read users', async () => {
    const rep = await createTestUser({ email: 'rep@users.test', roleId: (await repRole()).id });

    const res = await as(admin.token).get('/api/users');

    expect(res.status).toBe(200);
    expect(res.body.data.map(u => u.email).sort()).toEqual(['admin@users.test', 'rep@users.test']);
    expect(res.body.data.every(u => u.password === undefined && u.role?.name)).toBe(true);
    expect((await as(rep.token).get('/api/users')).status).toBe(403);
  });
});

describe('deactivating', () => {
  test('locks someone out at once, and reactivating lets them back in', async () => {
    const rep = await createTestUser({ email: 'rep@users.test', roleId: (await repRole()).id });
    expect((await as(rep.token).get('/api/contacts')).status).toBe(200);

    expect((await as(admin.token).put(`/api/users/${rep.user.id}`, { active: false })).status).toBe(200);
    const refused = await as(rep.token).get('/api/contacts');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('Account disabled');

    expect((await as(admin.token).put(`/api/users/${rep.user.id}`, { active: true })).status).toBe(200);
    expect((await as(rep.token).get('/api/contacts')).status).toBe(200);

    // The audit trail says what was done, not just "update".
    const entries = await prisma.auditLog.findMany({ where: { module: 'users', recordId: rep.user.id }, orderBy: { createdAt: 'asc' } });
    expect(entries.map(e => e.details)).toEqual([
      'Updated user rep@users.test: deactivated',
      'Updated user rep@users.test: reactivated',
    ]);
  });

  test("refuses to deactivate your own account", async () => {
    const res = await as(admin.token).put(`/api/users/${admin.user.id}`, { active: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("You can't deactivate your own account");
    expect((await prisma.user.findUnique({ where: { id: admin.user.id } })).active).toBe(true);
  });
});

describe('the last administrator', () => {
  test('cannot demote themselves while nobody else is one', async () => {
    const second = await createTestUser({ email: 'second@users.test', roleId: admin.user.roleId });
    const rep = await repRole();

    // With two, either may go.
    const demoted = await as(admin.token).put(`/api/users/${second.user.id}`, { roleId: rep.id });
    expect(demoted.status).toBe(200);
    expect(demoted.body.role.name).toBe('Sales Rep');

    // Now one is left, and stays one.
    const selfDemotion = await as(admin.token).put(`/api/users/${admin.user.id}`, { roleId: rep.id });
    expect(selfDemotion.status).toBe(409);
    expect(selfDemotion.body).toEqual({ error: 'This is the only active administrator. Make someone else an administrator first.', code: 'LAST_ADMIN' });
    expect((await prisma.user.findUnique({ where: { id: admin.user.id }, include: { role: true } })).role.name).toBe('Admin');

    // With another administrator again, they may step down.
    expect((await as(admin.token).put(`/api/users/${second.user.id}`, { roleId: admin.user.roleId })).status).toBe(200);
    expect((await as(admin.token).put(`/api/users/${admin.user.id}`, { roleId: rep.id })).status).toBe(200);
  });

  test('a deactivated administrator does not count', async () => {
    await createTestUser({ email: 'dormant@users.test', roleId: admin.user.roleId, active: false });

    const res = await as(admin.token).put(`/api/users/${admin.user.id}`, { roleId: (await repRole()).id });

    expect(res.status).toBe(409);
  });
});

describe('the password reset an administrator sends', () => {
  test('emails a link that sets a new password once; where email is not sent the link comes back', async () => {
    const rep = await createTestUser({ email: 'rep@users.test', password: 'Old-password-1!', roleId: (await repRole()).id });

    const sent = await as(admin.token).post(`/api/users/${rep.user.id}/password-reset`);

    // These tests send no email (no SMTP server), so the link is returned to pass on.
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ emailSent: false, expiresInMinutes: 60 });
    const token = new URL(sent.body.resetUrl).searchParams.get('token');
    // The old password works until a new one is chosen.
    expect((await request(app).post('/api/auth/login').send({ email: 'rep@users.test', password: 'Old-password-1!' })).status).toBe(200);

    const reset = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'New-password-2!' });
    expect(reset.status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ email: 'rep@users.test', password: 'New-password-2!' })).status).toBe(200);
    expect((await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'Third-password-3!' })).status).toBe(400);

    const audit = await prisma.auditLog.findFirst({ where: { module: 'users', recordId: rep.user.id, action: 'password_reset_request' } });
    expect(audit.details).toBe('Password reset link sent to rep@users.test');
  });

  test('is refused for a deactivated account', async () => {
    const gone = await createTestUser({ email: 'gone@users.test', roleId: (await repRole()).id, active: false });

    const res = await as(admin.token).post(`/api/users/${gone.user.id}/password-reset`);

    expect(res.status).toBe(409);
    expect(res.body.resetUrl).toBeUndefined();
  });

  test("is not for someone who manages users to send an administrator", async () => {
    const manager = await createTestUser({ email: 'manager@users.test', roleId: (await managerRole()).id });

    const res = await as(manager.token).post(`/api/users/${admin.user.id}/password-reset`);

    expect(res.status).toBe(403);
    expect(res.body.resetUrl).toBeUndefined();
  });

  test('takes users: full', async () => {
    const reader = await createTestUser({ email: 'reader@users.test', roleId: (await createTestRole('Reader', [{ module: 'users', level: 'read' }])).id });
    const rep = await createTestUser({ email: 'rep@users.test', roleId: (await repRole()).id });

    expect((await as(reader.token).post(`/api/users/${rep.user.id}/password-reset`)).status).toBe(403);
  });
});

describe('invites', () => {
  test("someone who manages users cannot resend or revoke an administrator's invite", async () => {
    const manager = await createTestUser({ email: 'manager@users.test', roleId: (await managerRole()).id });
    const rep = await repRole();
    const forAdmin = await as(admin.token).post('/api/signup/invites', { email: 'boss@users.test', roleId: admin.user.roleId });
    const forRep = await as(admin.token).post('/api/signup/invites', { email: 'new@users.test', roleId: rep.id });
    expect([forAdmin.status, forRep.status]).toEqual([201, 201]);

    // A resend returns the new link where no email is sent: taking an
    // administrator's invite that way made its taker an administrator.
    const resend = await as(manager.token).post(`/api/signup/invites/${forAdmin.body.id}/resend`);
    expect(resend.status).toBe(403);
    expect(resend.body.inviteUrl).toBeUndefined();
    expect((await as(manager.token).post(`/api/signup/invites/${forAdmin.body.id}/revoke`)).status).toBe(403);

    // An invite they could have sent themselves is theirs to resend and revoke.
    expect((await as(manager.token).post(`/api/signup/invites/${forRep.body.id}/resend`)).status).toBe(200);
    expect((await as(manager.token).post(`/api/signup/invites/${forRep.body.id}/revoke`)).status).toBe(200);
  });

  test('accepting one is the new user\'s first sign-in', async () => {
    const sent = await as(admin.token).post('/api/signup/invites', { email: 'new@users.test', firstName: 'New', lastName: 'Person', roleId: (await repRole()).id });
    const token = new URL(sent.body.inviteUrl).searchParams.get('token');

    const accepted = await request(app).post('/api/signup/invites/accept').send({ token, password: 'New-person-pass-1!' });

    expect(accepted.status).toBe(201);
    const user = await prisma.user.findUnique({ where: { email: 'new@users.test' } });
    expect(user.lastLoginAt).not.toBeNull();
  });

  test('are listed with the role each gives', async () => {
    const rep = await repRole();
    await as(admin.token).post('/api/signup/invites', { email: 'new@users.test', roleId: rep.id });

    const res = await as(admin.token).get('/api/signup/invites?status=Pending');

    expect(res.status).toBe(200);
    expect(res.body.map(i => [i.email, i.roleName])).toEqual([['new@users.test', 'Sales Rep']]);
  });
});
