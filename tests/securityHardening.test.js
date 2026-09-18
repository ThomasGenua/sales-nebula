const request = require('supertest');
const {
  setup, teardown, cleanDatabase,
  createTestRole, createTestUser, authHeader, getPrisma,
} = require('./setup');
const { verifyTotp, hotp, base32Decode } = require('../src/utils/totp');

let app, prisma;

/** The code an authenticator app would be showing right now. */
function currentCode(secret) {
  return hotp(base32Decode(secret), Math.floor(Date.now() / 1000 / 30));
}

async function login(email, password = 'Test123!@') {
  return request(app).post('/api/auth/login').send({ email, password });
}

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => { await cleanDatabase(); });

describe('Row-level security on the shared CRUD router', () => {
  async function seed() {
    const adminRole = await createTestRole('Admin');
    const salesRole = await createTestRole('Sales', [{ module: 'contacts', level: 'full' }]);
    const admin = await createTestUser({ email: 'admin@test.com', roleId: adminRole.id });
    const rep = await createTestUser({ email: 'rep@test.com', roleId: salesRole.id });
    const other = await createTestUser({ email: 'other@test.com', roleId: salesRole.id });
    return { admin, rep, other };
  }

  it('leaves the module open when nothing is group-controlled', async () => {
    const { rep } = await seed();
    await prisma.contact.create({ data: { firstName: 'Open', lastName: 'Record' } });

    const res = await request(app).get('/api/contacts').set(authHeader(rep.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('hides a group-restricted record from a non-member', async () => {
    const { rep, other } = await seed();
    const mine = await prisma.contact.create({ data: { firstName: 'Mine', lastName: 'Owned', ownerId: rep.user.id } });
    const theirs = await prisma.contact.create({ data: { firstName: 'Theirs', lastName: 'Restricted', ownerId: other.user.id } });

    const group = await prisma.securityGroup.create({ data: { name: `Their Team ${Math.random().toString(36).slice(2, 9)}`, active: true } });
    await prisma.securityGroupUser.create({ data: { securityGroupId: group.id, userId: other.user.id } });
    await prisma.securityGroupRecord.create({
      data: { securityGroupId: group.id, module: 'contacts', recordId: theirs.id, accessLevel: 'Full' },
    });

    const res = await request(app).get('/api/contacts').set(authHeader(rep.token));
    expect(res.status).toBe(200);            // no Prisma error on a model without assignedId
    const names = res.body.data.map(c => c.firstName);
    expect(names).toContain('Mine');
    expect(names).not.toContain('Theirs');

    const direct = await request(app).get(`/api/contacts/${theirs.id}`).set(authHeader(rep.token));
    expect(direct.status).toBe(404);
  });

  it('still shows the record to a member, and to an admin', async () => {
    const { admin, other } = await seed();
    const theirs = await prisma.contact.create({ data: { firstName: 'Theirs', lastName: 'Restricted', ownerId: other.user.id } });
    const group = await prisma.securityGroup.create({ data: { name: `Their Team ${Math.random().toString(36).slice(2, 9)}`, active: true } });
    await prisma.securityGroupUser.create({ data: { securityGroupId: group.id, userId: other.user.id } });
    await prisma.securityGroupRecord.create({
      data: { securityGroupId: group.id, module: 'contacts', recordId: theirs.id, accessLevel: 'Full' },
    });

    const member = await request(app).get('/api/contacts').set(authHeader(other.token));
    expect(member.body.data.map(c => c.firstName)).toContain('Theirs');

    const asAdmin = await request(app).get('/api/contacts').set(authHeader(admin.token));
    expect(asAdmin.body.data.map(c => c.firstName)).toContain('Theirs');
  });

  it('refuses an update on a record the caller cannot see', async () => {
    const { rep, other } = await seed();
    const theirs = await prisma.contact.create({ data: { firstName: 'Theirs', lastName: 'Restricted', ownerId: other.user.id } });
    const group = await prisma.securityGroup.create({ data: { name: `Their Team ${Math.random().toString(36).slice(2, 9)}`, active: true } });
    await prisma.securityGroupUser.create({ data: { securityGroupId: group.id, userId: other.user.id } });
    await prisma.securityGroupRecord.create({
      data: { securityGroupId: group.id, module: 'contacts', recordId: theirs.id, accessLevel: 'Full' },
    });

    const res = await request(app)
      .put(`/api/contacts/${theirs.id}`)
      .set(authHeader(rep.token))
      .send({ firstName: 'Hijacked' });
    expect(res.status).toBe(404);

    const after = await prisma.contact.findUnique({ where: { id: theirs.id } });
    expect(after.firstName).toBe('Theirs');
  });
});

describe('MFA is enforced at login', () => {
  it('issues a session directly when no device is enrolled', async () => {
    await createTestUser({ email: 'plain@test.com' });
    const res = await login('plain@test.com');
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.mfaRequired).toBeUndefined();
  });

  it('enrols a TOTP device and returns a usable secret', async () => {
    const user = await createTestUser({ email: 'enrol@test.com' });
    const res = await request(app).post('/api/security/mfa/enroll').set(authHeader(user.token)).send({ type: 'totp' });

    expect(res.status).toBe(201);                       // previously threw: base32 is not a Node encoding
    expect(res.body.secret).toMatch(/^[A-Z2-7]+$/);
    expect(res.body.otpAuthUrl).toContain('otpauth://totp/');
    expect(verifyTotp(res.body.secret, currentCode(res.body.secret))).toBe(true);
  });

  it('rejects a made-up code when confirming enrolment', async () => {
    const user = await createTestUser({ email: 'confirm@test.com' });
    const enrol = await request(app).post('/api/security/mfa/enroll').set(authHeader(user.token)).send({ type: 'totp' });

    const bad = await request(app).post('/api/security/mfa/verify')
      .set(authHeader(user.token)).send({ deviceId: enrol.body.deviceId, code: '000000' });
    expect(bad.status).toBe(400);

    const good = await request(app).post('/api/security/mfa/verify')
      .set(authHeader(user.token)).send({ deviceId: enrol.body.deviceId, code: currentCode(enrol.body.secret) });
    expect(good.status).toBe(200);
    expect(good.body.verified).toBe(true);
  });

  it('withholds the session until the code is supplied', async () => {
    const user = await createTestUser({ email: 'gated@test.com' });
    const enrol = await request(app).post('/api/security/mfa/enroll').set(authHeader(user.token)).send({ type: 'totp' });
    await request(app).post('/api/security/mfa/verify')
      .set(authHeader(user.token)).send({ deviceId: enrol.body.deviceId, code: currentCode(enrol.body.secret) });

    const gated = await login('gated@test.com');
    expect(gated.status).toBe(200);
    expect(gated.body.mfaRequired).toBe(true);
    expect(gated.body.token).toBeUndefined();          // the whole point
    expect(gated.body.accessToken).toBeUndefined();
    expect(gated.body.mfaToken).toBeDefined();

    const wrong = await request(app).post('/api/auth/mfa/verify')
      .send({ mfaToken: gated.body.mfaToken, deviceId: enrol.body.deviceId, code: '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.token).toBeUndefined();

    const right = await request(app).post('/api/auth/mfa/verify')
      .send({ mfaToken: gated.body.mfaToken, deviceId: enrol.body.deviceId, code: currentCode(enrol.body.secret) });
    expect(right.status).toBe(200);
    expect(right.body.token).toBeDefined();
    expect(right.body.user.email).toBe('gated@test.com');
  });
});

describe('SSO sign-in no longer issues sessions without an assertion', () => {
  it('refuses even with an active provider configured', async () => {
    const role = await createTestRole('Admin');
    const victim = await createTestUser({ email: 'victim@test.com', roleId: role.id });
    await prisma.ssoConfig.create({
      data: { name: `Okta ${Math.random().toString(36).slice(2, 9)}`, provider: 'okta', active: true, autoProvision: true, defaultRoleId: role.id },
    });

    const res = await request(app).post('/api/security/sso/login')
      .send({ provider: 'okta', token: 'anything-at-all', email: 'victim@test.com' });

    expect(res.status).toBe(501);
    expect(res.body.token).toBeUndefined();
    expect(victim.user.email).toBe('victim@test.com');
  });

  it('does not auto-provision an account from an unverified assertion', async () => {
    const role = await createTestRole('Admin');
    await prisma.ssoConfig.create({
      data: { name: `Okta ${Math.random().toString(36).slice(2, 9)}`, provider: 'okta', active: true, autoProvision: true, defaultRoleId: role.id },
    });

    await request(app).post('/api/security/sso/login')
      .send({ provider: 'okta', token: 'x', email: 'intruder@evil.test', firstName: 'In', lastName: 'Truder' });

    expect(await prisma.user.findUnique({ where: { email: 'intruder@evil.test' } })).toBeNull();
  });
});

describe('Campaign send reports only what it knows', () => {
  it('records no engagement and invents no revenue', async () => {
    const user = await createTestUser({ email: 'marketer@test.com' });
    const campaign = await prisma.campaign.create({ data: { name: 'Spring Push', status: 'Draft' } });
    const contact = await prisma.contact.create({ data: { firstName: 'Lead', lastName: 'One' } });
    await prisma.campaignRecipient.create({ data: { campaignId: campaign.id, contactId: contact.id } });

    const res = await request(app).post(`/api/campaigns/${campaign.id}/send`).set(authHeader(user.token)).send({});
    expect(res.status).toBe(200);

    const saved = await prisma.campaign.findUnique({ where: { id: campaign.id } });
    expect(saved.status).toBe('Sent');
    expect(res.body.delivery.queued).toBe(1);
    expect(res.body.delivery.implemented).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/revenue/);   // was Math.random() dollars

    const recipients = await prisma.campaignRecipient.findMany({ where: { campaignId: campaign.id } });
    expect(recipients.every(r => r.status === 'queued')).toBe(true);
    expect(recipients.every(r => r.sentAt)).toBe(true);
    // Nothing is claimed as opened or clicked, because nothing measured it.
    expect(recipients.some(r => r.openedAt || r.clickedAt)).toBe(false);
  });
});

describe('Content Security Policy', () => {
  // Helmet's default policy is `script-src 'self'`, which silently blocked the
  // shell's theme script in production. The hash is what lets it run without
  // opening the policy up to every other inline script on the page.
  const { inlineScriptHashes } = require('../src/app');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = html => { fs.writeFileSync(path.join(dir, 'index.html'), html); return dir; };

  it('hashes an inline script the way a browser does', () => {
    // sha256 of exactly `alert(1)`, base64 — the value Chromium asks for.
    const hashes = inlineScriptHashes(write('<html><head><script>alert(1)</script></head></html>'));
    expect(hashes).toEqual(["'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='"]);
  });

  it('ignores external scripts, which `self` already covers', () => {
    const hashes = inlineScriptHashes(write('<html><script type="module" src="/assets/app.js"></script></html>'));
    expect(hashes).toEqual([]);
  });

  it('ignores an empty script tag rather than emitting a useless hash', () => {
    expect(inlineScriptHashes(write('<html><script>  </script></html>'))).toEqual([]);
  });

  it('returns nothing when there is no built shell, leaving the default policy', () => {
    expect(inlineScriptHashes(path.join(dir, 'does-not-exist'))).toEqual([]);
  });
});
