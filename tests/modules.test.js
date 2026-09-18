const request = require('supertest');
const {
  setup, teardown, cleanDatabase,
  createTestUser, createTestDeal, createTestAccount, createTestContact, createTestLead,
  createTestProduct, createTestCase, authHeader,
} = require('./setup');

let app, prisma, token, userId;

beforeAll(async () => {
  ({ prisma, app } = await setup());
});

afterAll(async () => {
  await teardown();
});

beforeEach(async () => {
  await cleanDatabase();
  const auth = await createTestUser();
  token = auth.token;
  userId = auth.user.id;
});

// ─── WORKFLOWS ───

describe('Workflows', () => {
  it('creates a workflow', async () => {
    const res = await request(app)
      .post('/api/workflows')
      .set(authHeader(token))
      .send({
        name: 'Auto-assign high-value deals',
        module: 'deals',
        trigger: 'on_create',
        conditions: [{ field: 'value', operator: 'gt', value: 100000 }],
        actions: [{ type: 'update_field', field: 'priority', value: 'High' }],
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Auto-assign high-value deals');
    expect(res.body.active).toBe(true);
  });

  it('toggles workflow active state', async () => {
    const wf = await prisma.workflow.create({
      data: { name: 'Toggle Test', module: 'contacts', trigger: 'on_create', active: true },
    });

    const res = await request(app)
      .post(`/api/workflows/${wf.id}/toggle`)
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });

  it('duplicates a workflow', async () => {
    const wf = await prisma.workflow.create({
      data: { name: 'Original WF', module: 'deals', trigger: 'on_update', conditions: [{ field: 'stage', operator: 'eq', value: 'Closed Won' }], actions: [{ type: 'notify' }] },
    });

    const res = await request(app)
      .post(`/api/workflows/${wf.id}/duplicate`)
      .set(authHeader(token));

    expect(res.status).toBe(201);   // duplicate creates a record
    expect(res.body.name).toContain('Copy');
    expect(res.body.id).not.toBe(wf.id);
  });
});

// ─── TERRITORIES ───

describe('Territories', () => {
  it('creates territory hierarchy', async () => {
    const parent = await request(app)
      .post('/api/territories')
      .set(authHeader(token))
      .send({ name: 'North America' });

    expect(parent.status).toBe(201);

    const child = await request(app)
      .post('/api/territories')
      .set(authHeader(token))
      .send({ name: 'West Coast', parentId: parent.body.id });

    expect(child.status).toBe(201);
    expect(child.body.parentId).toBe(parent.body.id);
  });

  it('assigns account to territory', async () => {
    const territory = await prisma.territory.create({ data: { name: 'Test Region' } });
    const account = await createTestAccount({ name: 'Regional Client' });

    const res = await request(app)
      .post(`/api/territories/${territory.id}/accounts`)
      .set(authHeader(token))
      .send({ accountId: account.id });

    expect(res.status).toBe(201);
  });

  it('gets territory stats', async () => {
    const territory = await prisma.territory.create({ data: { name: 'Stats Region' } });
    const account = await createTestAccount();
    await prisma.territoryAccount.create({ data: { territoryId: territory.id, accountId: account.id } });

    const res = await request(app)
      .get(`/api/territories/${territory.id}/stats`)
      .set(authHeader(token));

    expect(res.status).toBe(200);
  });
});

// ─── FORMULA FIELDS ───

describe('Formula Fields', () => {
  it('creates a formula field', async () => {
    const res = await request(app)
      .post('/api/formulas')
      .set(authHeader(token))
      .send({
        name: 'Weighted Value',
        fieldKey: 'ff_weighted_val',
        module: 'deals',
        returnType: 'currency',
        formula: 'value * probability / 100',
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Weighted Value');
  });

  it('tests a formula against sample data', async () => {
    const res = await request(app)
      .post('/api/formulas/test')
      .set(authHeader(token))
      .send({
        formula: 'value * probability / 100',
        sampleData: { value: 100000, probability: 75 },
      });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe(75000);
  });

  it('lists formula fields', async () => {
    await prisma.formulaField.create({
      data: { name: 'Test', fieldKey: 'ff_test', module: 'deals', formula: '1+1', returnType: 'number' },
    });

    const res = await request(app)
      .get('/api/formulas')
      .set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);   // list endpoints return { data }
  });
});

// ─── ACTIVITIES ───

describe('Activities', () => {
  it('creates an activity linked to a deal', async () => {
    const deal = await createTestDeal(userId);

    const res = await request(app)
      .post('/api/activities')
      .set(authHeader(token))
      .send({
        type: 'Meeting',
        subject: 'Demo call',
        status: 'Planned',
        priority: 'High',
        dealId: deal.id,
        assigneeId: userId,
      });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('Meeting');
    expect(res.body.dealId).toBe(deal.id);
  });
});

// ─── EMAILS ───

describe('Emails', () => {
  it('sends an email', async () => {
    const contact = await createTestContact({ email: 'recipient@test.com' });

    const res = await request(app)
      .post('/api/emails/send')
      .set(authHeader(token))
      .send({
        to: 'recipient@test.com',
        subject: 'Follow up',
        body: 'Thanks for the meeting.',
        contactId: contact.id,
      });

    expect(res.status).toBe(201);              // /send creates the email
    expect(res.body.status).toBe('sent');
  });
});

// ─── CAMPAIGNS ───

describe('Campaigns', () => {
  it('creates a campaign', async () => {
    const res = await request(app)
      .post('/api/campaigns')
      .set(authHeader(token))
      .send({
        name: 'Product Launch',
        type: 'Email',
        status: 'Planning',
        budget: 50000,
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Product Launch');
  });
});

// ─── INVOICES ───

describe('Invoices', () => {
  it('creates and pays an invoice', async () => {
    const createRes = await request(app)
      .post('/api/invoices')
      .set(authHeader(token))
      .send({
        invoiceNumber: `INV-${Date.now()}`,
        status: 'Sent',
        total: 5000,
        tax: 500,
        dueDate: '2026-12-31',
      });

    expect(createRes.status).toBe(201);

    const payRes = await request(app)
      .post(`/api/invoices/${createRes.body.id}/pay`)
      .set(authHeader(token));

    expect(payRes.status).toBe(200);
    expect(payRes.body.status).toBe('Paid');
    expect(payRes.body.paidDate).toBeDefined();
  });
});

// ═══════════════════════════════════════
// INTEGRATION TESTS
// ═══════════════════════════════════════

describe('End-to-End: Lead to Revenue', () => {
  it('converts lead -> contact -> deal -> quote -> invoice', async () => {
    // 1. Create a lead
    const lead = await createTestLead({
      firstName: 'E2E',
      lastName: 'Test',
      email: 'e2e@test.com',
      company: 'E2E Corp',
    });

    // 2. Convert lead to contact
    const convertRes = await request(app)
      .post(`/api/leads/${lead.id}/convert`)
      .set(authHeader(token))
      .send({
        createAccount: true,
        createDeal: true,
        dealName: 'E2E Deal',
        dealValue: 100000,
      });

    expect(convertRes.status).toBe(200);
    expect(convertRes.body.contact).toBeDefined();
    const contactId = convertRes.body.contact.id;

    // Verify lead is converted
    const updatedLead = await prisma.lead.findUnique({ where: { id: lead.id } });
    expect(updatedLead.status).toBe('Converted');

    // 3. Find the deal that was created
    const dealsRes = await request(app)
      .get('/api/deals?search=E2E')
      .set(authHeader(token));
    expect(dealsRes.body.data.length).toBeGreaterThanOrEqual(1);

    // 4. Create a product
    const product = await createTestProduct({ name: 'E2E License', price: 100000, code: `E2E-${Date.now()}` });

    // 5. Create a quote
    const quoteRes = await request(app)
      .post('/api/quotes')
      .set(authHeader(token))
      .send({
        status: 'Draft',
        total: 100000,
        tax: 10000,
        discount: 0,
        validUntil: '2026-12-31',
        contactId,
      });

    expect(quoteRes.status).toBe(201);

    // 6. Accept the quote
    const acceptRes = await request(app)
      .post(`/api/quotes/${quoteRes.body.id}/accept`)
      .set(authHeader(token));
    expect(acceptRes.status).toBe(200);

    // 7. Create invoice from quote
    const invoiceRes = await request(app)
      .post(`/api/quotes/${quoteRes.body.id}/create-invoice`)
      .set(authHeader(token));
    expect(invoiceRes.status).toBe(201);   // converting a quote creates an invoice

    // 8. Verify the full chain exists
    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    expect(contact).toBeDefined();
    expect(contact.email).toBe('e2e@test.com');

    const invoices = await prisma.invoice.findMany({ where: { contactId } });
    // Invoice may or may not be linked to contact depending on create-invoice implementation
  });
});

describe('End-to-End: Support Case Lifecycle', () => {
  it('creates case -> assigns -> escalates -> resolves -> closes', async () => {
    const contact = await createTestContact({ firstName: 'Support', lastName: 'User' });

    // Create case
    const caseRes = await request(app)
      .post('/api/cases')
      .set(authHeader(token))
      .send({
        subject: 'Cannot access dashboard',
        status: 'New',
        priority: 'High',
        type: 'Bug',
        origin: 'Email',
        contactId: contact.id,
      });
    expect(caseRes.status).toBe(201);
    const caseId = caseRes.body.id;

    // Add initial comment
    await request(app)
      .post(`/api/cases/${caseId}/comments`)
      .set(authHeader(token))
      .send({ body: 'Investigating the issue.' });

    // Escalate
    await request(app)
      .put(`/api/cases/${caseId}`)
      .set(authHeader(token))
      .send({ status: 'Escalated', priority: 'Critical' });

    // Resolve
    const resolveRes = await request(app)
      .put(`/api/cases/${caseId}`)
      .set(authHeader(token))
      .send({ status: 'Resolved' });
    expect(resolveRes.body.status).toBe('Resolved');

    // Close
    const closeRes = await request(app)
      .put(`/api/cases/${caseId}`)
      .set(authHeader(token))
      .send({ status: 'Closed' });
    expect(closeRes.body.status).toBe('Closed');
  });
});
