/**
 * Consent capture and data subject rights.
 *
 * The consent module shipped writing to columns the schema never had, so every
 * one of these endpoints answered 500 (or, for the bulk endpoint, reported
 * success having written nothing). Erasure did not exist at all: a deletion
 * request was filed as a consent row and left pending forever.
 */

const request = require('supertest');
const {
  setup, teardown, cleanDatabase,
  createTestRole, createTestUser, createTestContact, createTestLead, createTestDeal, authHeader,
} = require('./setup');
const { resolveSubject, eraseSubject, buildPlan } = require('../src/services/dataErasure');

let app, prisma, admin, viewer;

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });

beforeEach(async () => {
  await cleanDatabase();
  const adminRole = await createTestRole('Admin');
  admin = await createTestUser({ email: 'dpo@test.com', roleId: adminRole.id });
  const readOnly = await createTestRole('Support', [
    { module: 'contacts', level: 'read' },
    { module: 'admin', level: 'read' },
  ]);
  viewer = await createTestUser({ email: 'agent@test.com', roleId: readOnly.id });
});

// ─── CONSENT ───

describe('Consent capture', () => {
  it('records consent, which used to fail on columns that do not exist', async () => {
    const contact = await createTestContact({ email: 'rosa@example.com' });

    const res = await request(app).post('/api/consent').set(authHeader(admin.token))
      .send({ contactId: contact.id, type: 'email_marketing', channel: 'email', granted: true, source: 'web_form' });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('email_marketing');
    expect(res.body.granted).toBe(true);

    const stored = await prisma.consentRecord.findUnique({ where: { id: res.body.id } });
    expect(stored.consentType).toBe('email_marketing');
    expect(stored.status).toBe('OptIn');
    expect(stored.channel).toBe('email');
    expect(stored.recordedById).toBe(admin.user.id);
  });

  it('rejects a consent record that names no subject', async () => {
    const res = await request(app).post('/api/consent').set(authHeader(admin.token))
      .send({ type: 'email_marketing', granted: true });
    expect(res.status).toBe(400);
  });

  it('lists consent with the contact summary the relation could not provide', async () => {
    const contact = await createTestContact({ firstName: 'Ida', lastName: 'Wells', email: 'ida@example.com' });
    await request(app).post('/api/consent').set(authHeader(admin.token))
      .send({ contactId: contact.id, type: 'profiling', granted: false });

    const res = await request(app).get('/api/consent').set(authHeader(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].contact.lastName).toBe('Wells');
    expect(res.body.data[0].granted).toBe(false);
  });

  it('returns the latest preference per type and treats an expired one as withdrawn', async () => {
    const contact = await createTestContact();
    await prisma.consentRecord.create({
      data: { contactId: contact.id, consentType: 'email_marketing', status: 'OptIn', createdAt: new Date(Date.now() - 60000) },
    });
    await prisma.consentRecord.create({
      data: { contactId: contact.id, consentType: 'email_marketing', status: 'OptOut' },
    });
    await prisma.consentRecord.create({
      data: { contactId: contact.id, consentType: 'profiling', status: 'OptIn', expiryDate: new Date(Date.now() - 86400000) },
    });

    const res = await request(app).get(`/api/consent/preferences/${contact.id}`).set(authHeader(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.preferences.email_marketing.granted).toBe(false);
    expect(res.body.preferences.profiling.granted).toBe(false); // expired
  });

  it('writes a withdrawal row per purpose on opt-out', async () => {
    const contact = await createTestContact();
    const res = await request(app).post('/api/consent/opt-out').set(authHeader(admin.token))
      .send({ contactId: contact.id, types: ['email_marketing', 'profiling'] });

    expect(res.status).toBe(200);
    expect(res.body.records).toBe(2);
    const stored = await prisma.consentRecord.findMany({ where: { contactId: contact.id } });
    expect(stored).toHaveLength(2);
    expect(stored.every(r => r.status === 'OptOut')).toBe(true);
  });

  it('actually writes in bulk, instead of reporting a silent zero', async () => {
    const a = await createTestContact({ email: 'a@example.com' });
    const b = await createTestContact({ email: 'b@example.com' });

    const res = await request(app).post('/api/consent/bulk').set(authHeader(admin.token))
      .send({ contactIds: [a.id, b.id], type: 'data_processing', granted: true });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    expect(await prisma.consentRecord.count()).toBe(2);
  });

  it('exports a contact bundle including the notes the old query silently dropped', async () => {
    const contact = await createTestContact();
    await prisma.note.create({
      data: { body: 'Prefers to be called after 5pm', module: 'contacts', recordId: contact.id, authorId: admin.user.id },
    });

    const res = await request(app).get(`/api/consent/data-export/${contact.id}`).set(authHeader(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0].body).toMatch(/after 5pm/);
  });
});

// ─── SUBJECT RESOLUTION ───

describe('Resolving a data subject', () => {
  it('joins a contact to the lead it was converted from', async () => {
    const contact = await createTestContact({ email: 'dual@example.com' });
    const lead = await createTestLead({ email: 'dual@example.com', contactId: contact.id });

    const byContact = await resolveSubject(prisma, { contactId: contact.id });
    expect(byContact.leadId).toBe(lead.id);

    const byEmail = await resolveSubject(prisma, { email: 'dual@example.com' });
    expect(byEmail.contactId).toBe(contact.id);
    expect(byEmail.leadId).toBe(lead.id);
    expect(byEmail.emails).toContain('dual@example.com');
  });

  it('reports no match rather than erasing nothing quietly', async () => {
    const subject = await resolveSubject(prisma, { email: 'nobody@example.com' });
    expect(subject.found).toBe(false);
    await expect(eraseSubject(prisma, subject)).rejects.toThrow(/No data subject/);
  });
});

// ─── EXPORT ───

describe('Subject access request', () => {
  it('gathers the subject across every model that references them', async () => {
    const contact = await createTestContact({ email: 'sar@example.com' });
    await createTestDeal(admin.user.id, { contactId: contact.id, name: 'Renewal' });
    await prisma.activity.create({
      data: { type: 'call', subject: 'Discovery', date: new Date(), priority: 'Normal', status: 'Completed', contactId: contact.id },
    });

    const res = await request(app).post('/api/privacy/export').set(authHeader(admin.token))
      .send({ contactId: contact.id });

    expect(res.status).toBe(200);
    expect(res.body.records.Contact).toHaveLength(1);
    expect(res.body.records.Deal).toHaveLength(1);
    expect(res.body.records.Activity).toHaveLength(1);
    expect(res.body.recordCount).toBeGreaterThanOrEqual(3);
  });

  it('404s on an identifier that matches nobody', async () => {
    const res = await request(app).post('/api/privacy/export').set(authHeader(admin.token))
      .send({ email: 'ghost@example.com' });
    expect(res.status).toBe(404);
  });
});

// ─── ERASURE ───

describe('Erasure', () => {
  async function seedSubject() {
    const contact = await createTestContact({
      firstName: 'Marta', lastName: 'Vega', email: 'marta@example.com',
      phone: '+1-555-0100', address: '12 Rue Daru', city: 'Paris', country: 'France',
      description: 'Met at the Lisbon conference',
    });
    const deal = await createTestDeal(admin.user.id, { contactId: contact.id, name: 'Vega Renewal', value: 42000, description: 'Three-year term' });
    const kase = await prisma.case.create({
      data: {
        caseNumber: 'CS-90001', subject: 'Login trouble', type: 'Problem', status: 'Open', priority: 'High',
        contactId: contact.id, contactEmail: 'marta@example.com', contactPhone: '+1-555-0100',
        description: 'Marta cannot sign in from Paris',
      },
    });
    const email = await prisma.email.create({
      data: { subject: 'Re: Login trouble', body: 'Hello Marta, try this...', status: 'sent', contactId: contact.id, to: 'marta@example.com', toEmail: 'marta@example.com', toName: 'Marta Vega' },
    });
    const note = await prisma.note.create({
      data: { body: 'Marta mentioned she is moving to Berlin', module: 'contacts', recordId: contact.id, authorId: admin.user.id },
    });
    return { contact, deal, kase, email, note };
  }

  it('refuses to erase without an explicit confirmation', async () => {
    const { contact } = await seedSubject();
    const res = await request(app).post('/api/privacy/erase').set(authHeader(admin.token))
      .send({ contactId: contact.id });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONFIRMATION_REQUIRED');
    const still = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(still.email).toBe('marta@example.com');
  });

  it('strips the identifiers from the subject and everything linked to them', async () => {
    const { contact, kase, email } = await seedSubject();

    const res = await request(app).post('/api/privacy/erase').set(authHeader(admin.token))
      .send({ contactId: contact.id, confirm: true });
    expect(res.status).toBe(200);

    const erased = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(erased.email).toBeNull();
    expect(erased.phone).toBeNull();
    expect(erased.address).toBeNull();
    expect(erased.city).toBeNull();
    expect(erased.firstName).toBe('Erased');
    expect(erased.lastName).toMatch(/^Contact /);
    expect(erased.deletedAt).not.toBeNull();

    const scrubbedCase = await prisma.case.findUnique({ where: { id: kase.id } });
    expect(scrubbedCase.contactEmail).toBeNull();
    expect(scrubbedCase.contactPhone).toBeNull();

    const scrubbedEmail = await prisma.email.findUnique({ where: { id: email.id } });
    expect(scrubbedEmail.toEmail).toBeNull();
    expect(scrubbedEmail.toName).toBeNull();
  });

  it('keeps the business records that a company is obliged to retain', async () => {
    const { contact, deal } = await seedSubject();

    await request(app).post('/api/privacy/erase').set(authHeader(admin.token))
      .send({ contactId: contact.id, confirm: true }).expect(200);

    const survivor = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(survivor).not.toBeNull();
    expect(survivor.name).toBe('Vega Renewal');
    expect(survivor.value).toBe(42000);
    expect(survivor.description).toBe('Three-year term');
    expect(survivor.contactId).toBe(contact.id);
  });

  it('leaves correspondence alone when anonymising, and says so', async () => {
    const { contact, email, note } = await seedSubject();

    const res = await request(app).post('/api/privacy/erase').set(authHeader(admin.token))
      .send({ contactId: contact.id, confirm: true, strategy: 'anonymize' }).expect(200);

    expect((await prisma.email.findUnique({ where: { id: email.id } })).body).toMatch(/Hello Marta/);
    expect((await prisma.note.findUnique({ where: { id: note.id } })).body).toMatch(/Berlin/);

    const residual = res.body.result.residual;
    expect(residual.some(r => r.model === 'Email' && r.fields.includes('body'))).toBe(true);
    expect(residual.some(r => r.model === 'Note')).toBe(true);
  });

  it('redacts correspondence under purge, without touching business text', async () => {
    const { contact, deal, email, note, kase } = await seedSubject();

    const res = await request(app).post('/api/privacy/erase').set(authHeader(admin.token))
      .send({ contactId: contact.id, confirm: true, strategy: 'purge' }).expect(200);

    expect((await prisma.email.findUnique({ where: { id: email.id } })).body).toMatch(/redacted/);
    expect((await prisma.note.findUnique({ where: { id: note.id } })).body).toMatch(/redacted/);
    expect((await prisma.case.findUnique({ where: { id: kase.id } })).description).toBeNull();
    expect((await prisma.deal.findUnique({ where: { id: deal.id } })).description).toBe('Three-year term');

    expect(res.body.result.strategy).toBe('purge');
    expect(res.body.result.residual.some(r => r.model === 'Deal' && r.fields.includes('description'))).toBe(true);
  });

  it('suppresses the address so an import cannot bring them back', async () => {
    const { contact } = await seedSubject();

    await request(app).post('/api/privacy/erase').set(authHeader(admin.token))
      .send({ contactId: contact.id, confirm: true }).expect(200);

    const suppressed = await prisma.emailSuppression.findUnique({ where: { email: 'marta@example.com' } });
    expect(suppressed).not.toBeNull();
    expect(suppressed.reason).toBe('gdpr_erasure');
  });

  it('erases the lead and the contact together when they are one person', async () => {
    const contact = await createTestContact({ email: 'both@example.com' });
    const lead = await createTestLead({ email: 'both@example.com', contactId: contact.id, company: 'Northwind' });

    await request(app).post('/api/privacy/erase').set(authHeader(admin.token))
      .send({ email: 'both@example.com', confirm: true }).expect(200);

    const erasedLead = await prisma.lead.findUnique({ where: { id: lead.id } });
    expect(erasedLead.email).toBeNull();
    expect(erasedLead.firstName).toBe('Erased');
    expect(erasedLead.company).toBe('Northwind'); // the employer is not the subject
    expect((await prisma.contact.findUnique({ where: { id: contact.id } })).email).toBeNull();
  });

  it('withdraws consent along with the person it belonged to', async () => {
    const { contact } = await seedSubject();
    await prisma.consentRecord.create({
      data: { contactId: contact.id, consentType: 'email_marketing', status: 'OptIn', email: 'marta@example.com', ipAddress: '10.0.0.7' },
    });

    await request(app).post('/api/privacy/erase').set(authHeader(admin.token))
      .send({ contactId: contact.id, confirm: true }).expect(200);

    const [consent] = await prisma.consentRecord.findMany({ where: { contactId: contact.id } });
    expect(consent.status).toBe('OptOut');
    expect(consent.email).toBeNull();
    expect(consent.ipAddress).toBeNull();
  });

  it('records what it did, and does not erase its own audit trail', async () => {
    const { contact } = await seedSubject();

    const res = await request(app).post('/api/privacy/erase').set(authHeader(admin.token))
      .send({ contactId: contact.id, confirm: true, notes: 'Verified by passport' }).expect(200);

    expect(res.body.request.status).toBe('completed');
    expect(res.body.request.processedAt).not.toBeNull();
    expect(res.body.result.rowsTouched).toBeGreaterThan(0);
    expect(res.body.result.erased.Contact).toBe(1);

    // The request itself carries the subject's id and must survive the sweep.
    const stored = await prisma.dataSubjectRequest.findUnique({ where: { id: res.body.request.id } });
    expect(stored.contactId).toBe(contact.id);
    expect(stored.result.rowsTouched).toBeGreaterThan(0);

    const log = await prisma.auditLog.findFirst({ where: { action: 'erase', module: 'privacy' } });
    expect(log).not.toBeNull();
  });

  it('is safe to run twice', async () => {
    const { contact } = await seedSubject();
    await request(app).post('/api/privacy/erase').set(authHeader(admin.token))
      .send({ contactId: contact.id, confirm: true }).expect(200);
    const second = await request(app).post('/api/privacy/erase').set(authHeader(admin.token))
      .send({ contactId: contact.id, confirm: true });
    expect(second.status).toBe(200);
    expect(second.body.result.skipped).toEqual([]);
  });

  it('is refused to a user without full admin rights', async () => {
    const { contact } = await seedSubject();
    const res = await request(app).post('/api/privacy/erase').set(authHeader(viewer.token))
      .send({ contactId: contact.id, confirm: true });

    expect(res.status).toBe(403);
    expect((await prisma.contact.findUnique({ where: { id: contact.id } })).email).toBe('marta@example.com');
  });
});

// ─── REQUEST WORKFLOW ───

describe('Data subject request workflow', () => {
  it('logs a request, then carries it out on demand', async () => {
    const contact = await createTestContact({ email: 'queued@example.com' });

    const logged = await request(app).post('/api/privacy/requests').set(authHeader(admin.token))
      .send({ contactId: contact.id, requestType: 'erasure', strategy: 'anonymize' });
    expect(logged.status).toBe(201);
    expect(logged.body.status).toBe('pending');
    expect((await prisma.contact.findUnique({ where: { id: contact.id } })).email).toBe('queued@example.com');

    const processed = await request(app)
      .post(`/api/privacy/requests/${logged.body.id}/process`).set(authHeader(admin.token)).send({});
    expect(processed.status).toBe(200);
    expect(processed.body.request.status).toBe('completed');
    expect((await prisma.contact.findUnique({ where: { id: contact.id } })).email).toBeNull();
  });

  it('refuses to process the same request twice', async () => {
    const contact = await createTestContact();
    const logged = await request(app).post('/api/privacy/requests').set(authHeader(admin.token))
      .send({ contactId: contact.id, requestType: 'erasure' });
    await request(app).post(`/api/privacy/requests/${logged.body.id}/process`).set(authHeader(admin.token)).send({}).expect(200);

    const again = await request(app).post(`/api/privacy/requests/${logged.body.id}/process`).set(authHeader(admin.token)).send({});
    expect(again.status).toBe(409);
  });

  it('rejects a request type it does not recognise', async () => {
    const contact = await createTestContact();
    const res = await request(app).post('/api/privacy/requests').set(authHeader(admin.token))
      .send({ contactId: contact.id, requestType: 'shred' });
    expect(res.status).toBe(400);
  });

  it('lists requests filtered by status', async () => {
    const contact = await createTestContact();
    await request(app).post('/api/privacy/requests').set(authHeader(admin.token))
      .send({ contactId: contact.id, requestType: 'export' });

    const res = await request(app).get('/api/privacy/requests?status=pending').set(authHeader(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].requestType).toBe('export');
  });
});

// ─── THE PLAN ITSELF ───

describe('The erasure plan', () => {
  it('is derived from the schema, so a new table cannot be forgotten', () => {
    const plan = buildPlan();
    const names = plan.map(e => e.model);
    expect(names).toEqual(expect.arrayContaining(['Contact', 'Lead', 'PersonAccount', 'Case', 'Email', 'CampaignRecipient']));
    expect(plan.length).toBeGreaterThan(20);
  });

  it('never scrubs the audit trail of the erasure itself', () => {
    const names = buildPlan().map(e => e.model);
    expect(names).not.toContain('DataSubjectRequest');
    expect(names).not.toContain('EmailSuppression');
    expect(names).not.toContain('AuditLog');
    expect(names).not.toContain('User');
  });

  it('treats a business record name as business data, not as a person', () => {
    const deal = buildPlan().find(e => e.model === 'Deal');
    expect(deal.identifiers.map(f => f.name)).not.toContain('name');
  });
});
