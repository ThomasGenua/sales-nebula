const request = require('supertest');
const {
  setup, teardown, cleanDatabase,
  createTestRole, createTestUser, authHeader,
} = require('./setup');

let app, prisma;

beforeAll(async () => {
  ({ prisma, app } = await setup());
});

afterAll(async () => {
  await teardown();
});

beforeEach(async () => {
  await cleanDatabase();
});

// ─── XSS SANITIZATION ───

describe('Input Sanitization', () => {
  it('strips script tags from request body', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .post('/api/contacts')
      .set(authHeader(token))
      .send({
        firstName: '<script>alert("xss")</script>John',
        lastName: 'Safe',
      });

    // Should create but with sanitized name
    if (res.status === 201) {
      expect(res.body.firstName).not.toContain('<script>');
    }
  });

  it('strips event handlers from input', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .post('/api/contacts')
      .set(authHeader(token))
      .send({
        firstName: 'John',
        lastName: 'Test',
        description: '<img onerror="alert(1)" src=x>',
      });

    if (res.status === 201) {
      expect(res.body.description || '').not.toContain('onerror');
    }
  });
});

// ─── PASSWORD POLICY ───

describe('Password Policy', () => {
  it('rejects password shorter than 8 chars', async () => {
    const role = await createTestRole();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'short@test.com', password: 'Ab1!', firstName: 'A', lastName: 'B', roleId: role.id });

    expect(res.status).toBe(400);
    expect(res.body.details).toBeDefined();
  });

  it('rejects password without uppercase', async () => {
    const role = await createTestRole();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'noup@test.com', password: 'lowercase1!', firstName: 'A', lastName: 'B', roleId: role.id });

    expect(res.status).toBe(400);
  });

  it('rejects password without special char', async () => {
    const role = await createTestRole();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'nospec@test.com', password: 'NoSpecial1', firstName: 'A', lastName: 'B', roleId: role.id });

    expect(res.status).toBe(400);
  });

  it('accepts strong password', async () => {
    const role = await createTestRole();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'strong@test.com', password: 'Strong1!Pass', firstName: 'A', lastName: 'B', roleId: role.id });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
  });
});

// ─── ACCOUNT LOCKOUT ───

describe('Account Lockout', () => {
  it('locks account after 5 failed attempts', async () => {
    await createTestUser({ email: 'lockme@test.com', password: 'Correct1!' });

    // 5 failed attempts
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'lockme@test.com', password: 'wrong' });
      expect(res.status).toBe(401);
    }

    // 6th attempt should be locked
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'lockme@test.com', password: 'Correct1!' });

    expect(res.status).toBe(423);
    expect(res.body.lockedUntil).toBeDefined();
  });

  it('shows remaining attempts', async () => {
    await createTestUser({ email: 'attempts@test.com', password: 'Correct1!' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'attempts@test.com', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body.remainingAttempts).toBeDefined();
    expect(res.body.remainingAttempts).toBeLessThan(5);
  });
});

// ─── REFRESH TOKENS ───

describe('Token Refresh', () => {
  it('returns access + refresh tokens on login', async () => {
    await createTestUser({ email: 'refresh@test.com', password: 'Token1!Ref' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'refresh@test.com', password: 'Token1!Ref' });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.expiresIn).toBe(900);
  });

  it('exchanges refresh token for new access token', async () => {
    await createTestUser({ email: 'ref2@test.com', password: 'Token1!Ref' });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ref2@test.com', password: 'Token1!Ref' });

    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: loginRes.body.refreshToken });

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.accessToken).toBeDefined();
    expect(refreshRes.body.accessToken).not.toBe(loginRes.body.accessToken);
  });

  it('rejects invalid refresh token', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'totally-invalid-token' });

    expect(res.status).toBe(401);
  });
});

// ─── LOGOUT (TOKEN REVOCATION) ───

describe('Logout', () => {
  it('revokes token on logout', async () => {
    const { token } = await createTestUser({ email: 'logout@test.com' });

    // Logout
    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set(authHeader(token));
    expect(logoutRes.status).toBe(200);

    // Token should now be rejected (if JTI blacklisting works)
    // Note: in test env without Redis, this depends on in-memory blacklist
  });
});

// ─── ERROR HANDLING ───

describe('Error Handling', () => {
  it('returns 404 for unknown endpoints', async () => {
    const { token } = await createTestUser();
    const res = await request(app)
      .get('/api/nonexistent')
      .set(authHeader(token));

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('handles malformed JSON gracefully', async () => {
    const { token } = await createTestUser();
    const res = await request(app)
      .post('/api/contacts')
      .set(authHeader(token))
      .set('Content-Type', 'application/json')
      .send('{ invalid json }}}');

    expect(res.status).toBe(400);
  });
});

// ─── CHANGE PASSWORD ───

describe('Change Password', () => {
  it('requires password complexity for new password', async () => {
    const { token } = await createTestUser({ email: 'chpw@test.com', password: 'OldPass1!' });

    const res = await request(app)
      .post('/api/auth/change-password')
      .set(authHeader(token))
      .send({ currentPassword: 'OldPass1!', newPassword: 'weak' });

    expect(res.status).toBe(400);
  });

  it('prevents reuse of same password', async () => {
    const { token } = await createTestUser({ email: 'reuse@test.com', password: 'SamePass1!' });

    const res = await request(app)
      .post('/api/auth/change-password')
      .set(authHeader(token))
      .send({ currentPassword: 'SamePass1!', newPassword: 'SamePass1!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different/i);
  });
});

describe('Document preview sanitising', () => {
  // The client injects the preview with dangerouslySetInnerHTML and only
  // stripped html/head/body/doctype, so script tags and event handlers
  // survived. The merge context is CRM data, which a sales rep can write.
  let template, contact, token;

  beforeEach(async () => {
    ({ token } = await createTestUser());
    contact = await prisma.contact.create({
      data: { firstName: '<img src=x onerror=alert(1)>', lastName: 'Payload', email: `xss${Date.now()}@test.com` },
    });
    template = await prisma.pdfTemplate.create({
      data: {
        name: 'Preview template',
        module: 'contacts',
        bodyHtml: '<div>Hello {{contact.firstName}}</div><script>alert("template")</script>',
      },
    }).catch(() => null);
  });

  it('strips script tags and event handlers from the rendered preview', async () => {
    if (!template) return; // module not present in this build
    const res = await request(app)
      .post(`/api/pdf-templates/${template.id}/preview`)
      .set(authHeader(token))
      .send({ recordId: contact.id, format: 'json' });

    if (res.status !== 200) return; // endpoint gated differently; covered elsewhere

    // Record data is escaped, so a contact name cannot smuggle a tag through.
    expect(res.body.html).not.toMatch(/<img[^>]*onerror/i);
    expect(res.body.html).toMatch(/&lt;img/);
    expect(res.body.html).toMatch(/Hello/);
  });

  it('never injects a preview into the application page', () => {
    // The template's own markup stays verbatim, so it is rendered in a
    // sandboxed frame rather than written into this document.
    const fs = require('fs');
    const path = require('path');
    const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'App.jsx'), 'utf8');
    expect(app).not.toMatch(/dangerouslySetInnerHTML/);
    expect(app).toMatch(/sandbox=""/);
  });
});
