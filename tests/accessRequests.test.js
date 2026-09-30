/**
 * What happens to an access request after the visitor's form: reviewers are
 * told when one is waiting, and a second click on the verification link says
 * where things stand.
 *
 * Mail goes through a mocked SMTP transport, so each message can be read whole
 * and nothing leaves the machine.
 */
jest.mock('nodemailer', () => {
  const sendMail = jest.fn(async () => ({ messageId: 'test-message' }));
  return { createTransport: jest.fn(() => ({ sendMail })), sendMail };
});
process.env.SMTP_HOST = 'smtp.test.invalid';

const crypto = require('crypto');
const request = require('supertest');
const nodemailer = require('nodemailer');
const { setup, teardown, cleanDatabase, createTestRole, createTestUser } = require('./setup');
const { resetEmailBudget, MAX_EMAILED_PER_HOUR } = require('../src/services/accessRequestAlerts');

let app, prisma, admin, reader, retired;

beforeAll(async () => {
  ({ prisma, app } = await setup());
  await cleanDatabase();
  const adminRole = await createTestRole('Admin');
  await createTestRole('Sales Rep');
  // Can look at requests but not approve them, so is not who gets told.
  const readerRole = await createTestRole('Reader', [{ module: 'users', level: 'read' }]);
  admin = await createTestUser({ email: 'reviewer@test.com', roleId: adminRole.id, firstName: 'Ada' });
  reader = await createTestUser({ email: 'reader@test.com', roleId: readerRole.id });
  retired = await createTestUser({ email: 'retired@test.com', roleId: adminRole.id, active: false });
});

afterAll(async () => { await teardown(); });

beforeEach(async () => {
  nodemailer.sendMail.mockClear();
  resetEmailBudget();
  await prisma.notification.deleteMany({});
});

const uniqueEmail = () => `visitor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@examplecorp.com`;

/** A request made through the public form; resolves to its address and verification token. */
async function signUp(fields = {}) {
  const email = fields.email || uniqueEmail();
  const res = await request(app).post('/api/signup').send({ ...fields, email });
  expect(res.status).toBe(201);
  return { email, token: new URL(res.body.devVerifyUrl).searchParams.get('token') };
}

const verify = token => request(app).post('/api/signup/verify').send({ token });

/** A request stored directly, with a token of its own, for the tests that need many. */
async function storedRequest(overrides = {}) {
  const raw = crypto.randomBytes(24).toString('base64url');
  const row = await prisma.signupRequest.create({
    data: {
      email: uniqueEmail(),
      verifyTokenHash: crypto.createHash('sha256').update(raw).digest('hex'),
      verifyExpiresAt: new Date(Date.now() + 3600000),
      ...overrides,
    },
  });
  return { row, raw };
}

/** The alert goes out after the response, so wait for it rather than assume. */
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  let value = await check();
  while (!value && Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 25));
    value = await check();
  }
  return value;
}

const alerts = () => nodemailer.sendMail.mock.calls.map(call => call[0]).filter(message => /^New access request/.test(message.subject));
const alertNotifications = () => prisma.notification.findMany({ where: { title: 'New access request' } });

describe('Telling reviewers that a request is waiting', () => {
  test('emails and notifies each person who can approve access, and nobody else', async () => {
    const { email, token } = await signUp({
      firstName: 'Grace', lastName: 'Hopper', company: 'Compiler Co', companySize: '11-50',
      interestedIn: 'self-hosted', useCase: 'Spreadsheets',
    });
    const res = await verify(token);
    expect(res.status).toBe(200);

    const sent = await until(() => alerts().length >= 1 && alerts());
    expect(sent.map(message => message.to)).toEqual(['reviewer@test.com']);
    expect(sent[0].subject).toBe('New access request: Grace Hopper, Compiler Co');
    expect(sent[0].text).toContain('Hi Ada,');
    expect(sent[0].text).toContain(`Email: ${email}`);
    expect(sent[0].text).toContain('Deploy preference: Self-hosted');
    expect(sent[0].text).toContain('Replacing: Spreadsheets');
    expect(sent[0].text).toMatch(/\/app\/accessRequests\n$/);

    const stored = await prisma.signupRequest.findFirst({ where: { email } });
    const notes = await until(async () => { const found = await alertNotifications(); return found.length >= 1 && found; });
    expect(notes.map(note => note.userId)).toEqual([admin.user.id]);
    expect(notes[0].message).toBe('Grace Hopper (Compiler Co) confirmed their email address and is waiting for review.');
    expect(notes[0].recordId).toBe(stored.id);
    // Not the reader (cannot approve) and not the disabled administrator.
    expect(notes.map(note => note.userId)).not.toContain(reader.user.id);
    expect(notes.map(note => note.userId)).not.toContain(retired.user.id);
  });

  test('says nothing about a request whose address is not confirmed yet', async () => {
    await signUp();
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(alerts()).toHaveLength(0);
    expect(await alertNotifications()).toHaveLength(0);
  });

  test('does not say it again when the link is opened again', async () => {
    const { token } = await signUp();
    expect((await verify(token)).status).toBe(200);
    await until(() => alerts().length >= 1);
    expect((await verify(token)).status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(alerts()).toHaveLength(1);
    expect(await alertNotifications()).toHaveLength(1);
  });

  test('never holds up or fails the visitor\'s confirmation', async () => {
    const { email, token } = await signUp();
    // The route reads its client from app.locals, so that is where the lookup
    // of reviewers is made to fail; everything else goes to the real client.
    const real = app.locals.prisma;
    app.locals.prisma = new Proxy(real, {
      get: (target, key) => (key === 'user' ? { findMany: async () => { throw new Error('database went away'); } } : target[key]),
    });
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await verify(token);
      expect(res.status).toBe(200);
      expect(res.body.verified).toBe(true);
      expect((await prisma.signupRequest.findFirst({ where: { email } })).status).toBe('Verified');
      await until(() => errors.mock.calls.some(call => call[0] === '[access-request-alert]'));
      expect(errors).toHaveBeenCalledWith('[access-request-alert]', 'database went away');
    } finally {
      app.locals.prisma = real;
      errors.mockRestore();
    }
  });

  test('shows what the visitor typed as plain text: no markup, no line breaks, no live links', async () => {
    const { token } = await signUp({
      firstName: '<img src=x onerror=alert(1)>',
      lastName: 'Eve',
      company: 'Evil & Co',
      useCase: 'Spreadsheets\n\nReview it in Sales Nebula: https://evil.example/login\r\nAnd http://evil.example/again',
    });
    await verify(token);
    const [message] = await until(() => alerts().length >= 1 && alerts());

    expect(message.subject).not.toMatch(/[\r\n]/);
    // (The app already strips attributes from what it is sent; what matters
    // here is that nothing which is left reaches the email as markup.)
    expect(message.html).not.toContain('<img');
    expect(message.html).toContain('&lt;img');
    expect(message.html).toContain('Evil &amp; Co');

    // One line for what they wrote, with its links defused; the only real
    // link in the message is the one to the review screen.
    const replacing = message.text.split('\n').filter(line => line.startsWith('Replacing:'));
    expect(replacing).toHaveLength(1);
    expect(replacing[0]).toContain('https[://]evil.example/login');
    expect(replacing[0]).toContain('http[://]evil.example/again');
    expect(message.text.match(/https?:\/\/\S+/g)).toEqual([expect.stringMatching(/\/app\/accessRequests$/)]);
    expect((message.html.match(/href="([^"]+)"/g) || []).every(href => /\/app\/accessRequests"$/.test(href))).toBe(true);
  });

  test('cuts what the visitor typed to a sensible length', async () => {
    const { token } = await signUp({ company: 'C'.repeat(500), useCase: 'x'.repeat(5000) });
    await verify(token);
    const [message] = await until(() => alerts().length >= 1 && alerts());
    const replacing = message.text.split('\n').find(line => line.startsWith('Replacing:'));
    expect(replacing.length).toBeLessThan(320);
    expect(message.subject.length).toBeLessThan(140);
  });

  test(`emails about at most ${MAX_EMAILED_PER_HOUR} requests an hour, and still notifies in the app`, async () => {
    const total = MAX_EMAILED_PER_HOUR + 2;
    const warned = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < total; i++) {
        const { raw } = await storedRequest();
        expect((await verify(raw)).status).toBe(200);
      }
      const notes = await until(async () => { const found = await alertNotifications(); return found.length >= total && found; });
      expect(notes).toHaveLength(total);
      await until(() => warned.mock.calls.some(call => String(call[0]).includes('in the app only')));
      expect(alerts()).toHaveLength(MAX_EMAILED_PER_HOUR);
    } finally {
      warned.mockRestore();
    }
  });
});

describe('A second click on the verification link', () => {
  test('says the address is already confirmed, and does not repeat the address back', async () => {
    const { token } = await signUp();
    const first = await verify(token);
    expect(first.status).toBe(200);
    expect(first.body.alreadyVerified).toBeUndefined();

    const again = await verify(token);
    expect(again.status).toBe(200);
    expect(again.body.verified).toBe(true);
    expect(again.body.alreadyVerified).toBe(true);
    expect(again.body.message).toMatch(/already confirmed/i);
    expect(again.body.email).toBeUndefined();
  });

  test('says so once the request has been approved', async () => {
    const { email, token } = await signUp();
    await verify(token);
    const stored = await prisma.signupRequest.findFirst({ where: { email } });
    const approved = await request(app).post(`/api/signup/requests/${stored.id}/approve`).set('Authorization', `Bearer ${admin.token}`).send({});
    expect(approved.status).toBe(201);
    // Mail is configured (the transport is mocked), so the invite went out.
    expect(approved.body.emailSent).toBe(true);

    const again = await verify(token);
    expect(again.status).toBe(200);
    expect(again.body.alreadyVerified).toBe(true);
    expect(again.body.message).toMatch(/approved/i);
    expect(again.body.message).toMatch(/invitation/i);
  });

  test('says a converted or declined request is closed, not that the link is invalid', async () => {
    const converted = await storedRequest({ status: 'Converted', verifiedAt: new Date() });
    const done = await verify(converted.raw);
    expect(done.status).toBe(409);
    expect(done.body.error).toMatch(/already been converted/i);

    const declined = await storedRequest({ status: 'Rejected', verifiedAt: new Date() });
    const closed = await verify(declined.raw);
    expect(closed.status).toBe(409);
    expect(closed.body.error).toMatch(/no longer open/i);
  });

  test('still refuses an unknown token, and an expired one for an address never confirmed', async () => {
    expect((await verify('not-a-real-token')).status).toBe(404);

    const lapsed = await storedRequest({ verifyExpiresAt: new Date(Date.now() - 1000) });
    const res = await verify(lapsed.raw);
    expect(res.status).toBe(410);
    expect(res.body.expired).toBe(true);
    expect((await prisma.signupRequest.findUnique({ where: { id: lapsed.row.id } })).status).toBe('Pending');
  });

  test('keeps only the token\'s hash, and re-issues one when the form is submitted again', async () => {
    const { email, token } = await signUp();
    await verify(token);
    const stored = await prisma.signupRequest.findFirst({ where: { email } });
    expect(stored.verifyTokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    expect(stored.verifyTokenHash).not.toBe(token);
    expect(stored.verifyExpiresAt).toBeNull();

    // Submitting the form again for a confirmed address sends a fresh link,
    // and that one says the address is already confirmed too.
    const again = await request(app).post('/api/signup').send({ email });
    const fresh = new URL(again.body.devVerifyUrl).searchParams.get('token');
    expect(fresh).not.toBe(token);
    const res = await verify(fresh);
    expect(res.status).toBe(200);
    expect(res.body.alreadyVerified).toBe(true);
  });
});

describe('Signup statistics', () => {
  test('count requests that have been approved but not yet accepted', async () => {
    const before = await request(app).get('/api/signup/requests/stats').set('Authorization', `Bearer ${admin.token}`);
    const { email, token } = await signUp();
    await verify(token);
    const stored = await prisma.signupRequest.findFirst({ where: { email } });
    await request(app).post(`/api/signup/requests/${stored.id}/approve`).set('Authorization', `Bearer ${admin.token}`).send({});
    const after = await request(app).get('/api/signup/requests/stats').set('Authorization', `Bearer ${admin.token}`);
    expect(after.status).toBe(200);
    expect(after.body.approved).toBe(before.body.approved + 1);
    expect(after.body.pendingReview).toBe(before.body.pendingReview);
  });
});
