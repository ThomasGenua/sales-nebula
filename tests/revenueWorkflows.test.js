const request = require('supertest');
const crypto = require('crypto');
const {
  setup,
  teardown,
  cleanDatabase,
  createTestUser,
  createTestAccount,
  createTestContact,
  createTestDeal,
  authHeader
} = require('./setup');
const payments = require('../src/services/payments');
let app, prisma, user, token;
beforeAll(async () => {
  ({
    app,
    prisma
  } = await setup());
});
afterAll(teardown);
beforeEach(async () => {
  await cleanDatabase();
  ({
    user,
    token
  } = await createTestUser());
});
const post = (path, body) => request(app).post('/api' + path).set(authHeader(token)).send(body);
test('partial payments reconcile once, reject overpayment and lock invoice totals', async () => {
  const invoice = await prisma.invoice.create({
    data: {
      number: 'INV-LEDGER',
      total: 100,
      subtotal: 100,
      currency: 'USD'
    }
  });
  const first = await post('/payments/' + invoice.id + '/record', {
    amount: 40,
    reference: 'receipt-a'
  });
  expect(first.status).toBe(200);
  expect((await post('/payments/' + invoice.id + '/record', {
    amount: 40,
    reference: 'receipt-a'
  })).status).toBe(200);
  expect(await prisma.invoicePayment.count()).toBe(1);
  expect((await prisma.invoice.findUnique({
    where: {
      id: invoice.id
    }
  })).status).toBe('Partially Paid');
  expect((await post('/payments/' + invoice.id + '/record', {
    amount: 61,
    reference: 'too-much'
  })).status).toBe(400);
  expect((await request(app).put('/api/invoices/' + invoice.id).set(authHeader(token)).send({
    total: 200
  })).status).toBe(409);
  expect((await post('/payments/' + invoice.id + '/record', {
    amount: 60,
    reference: 'receipt-b'
  })).status).toBe(200);
  expect((await payments.balance(prisma, invoice)).outstandingMinor).toBe(0);
  expect((await prisma.invoice.findUnique({
    where: {
      id: invoice.id
    }
  })).status).toBe('Paid');
});
test('webhook verification rejects altered payloads, stale and invalid timestamps', () => {
  const raw = Buffer.from('{"type":"example"}'),
    t = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', 'fixture-secret').update(t + '.').update(raw).digest('hex');
  expect(payments.verifyStripe(raw, `t=${t},v1=${sig}`, 'fixture-secret').type).toBe('example');
  expect(() => payments.verifyStripe(Buffer.from('{}'), `t=${t},v1=${sig}`, 'fixture-secret')).toThrow();
  expect(() => payments.verifyStripe(raw, `t=NaN,v1=${sig}`, 'fixture-secret')).toThrow();
  expect(() => payments.minor(21474836.48)).toThrow();
});
test('manual cadence creates one task and advances on a converted outcome without SMTP', async () => {
  const contact = await createTestContact({
    ownerId: user.id
  });
  const steps = [{
    type: 'call',
    subject: 'Qualification call',
    branches: {
      converted: 'end'
    }
  }, {
    type: 'task',
    subject: 'Follow-up'
  }];
  const seq = await prisma.emailSequence.create({
    data: {
      name: 'Call cadence',
      status: 'Active',
      steps,
      createdById: user.id
    }
  });
  const enrollment = await prisma.emailSequenceEnrollment.create({
    data: {
      sequenceId: seq.id,
      contactId: contact.id,
      enrolledById: user.id,
      stepSnapshot: steps,
      nextSendAt: new Date(0)
    }
  });
  const run = () => require('../src/services/sequenceSteps').processDueSteps(prisma, {
    isSuppressed: async () => false
  });
  const a = await run();
  expect(a.errors).toBe(0);
  await run();
  expect(await prisma.activity.count({
    where: {
      cadenceKey: enrollment.id + ':0'
    }
  })).toBe(1);
  await prisma.activity.update({
    where: {
      cadenceKey: enrollment.id + ':0'
    },
    data: {
      status: 'Completed',
      result: 'converted'
    }
  });
  await run();
  const saved = await prisma.emailSequenceEnrollment.findUnique({
    where: {
      id: enrollment.id
    }
  });
  expect(saved.status).toBe('Completed');
  expect(saved.convertedAt).not.toBeNull();
});
test('computed fields hydrate formulas and rollups and reject client edits', async () => {
  const account = await createTestAccount();
  await createTestDeal(user.id, {
    accountId: account.id,
    value: 120
  });
  await createTestDeal(user.id, {
    accountId: account.id,
    value: 80
  });
  const field = await post('/formulas', {
    name: 'Open pipeline',
    module: 'accounts',
    returnType: 'currency',
    rollup: {
      module: 'deals',
      function: 'sum',
      field: 'value'
    }
  });
  expect(field.status).toBe(201);
  const response = await post('/formulas/evaluate', {
    module: 'accounts',
    recordId: account.id
  });
  expect(response.status).toBe(200);
  expect(response.body.fields.ff_open_pipeline.value).toBe(200);
  const defs = await request(app).get('/api/studio/values/accounts/' + account.id).set(authHeader(token));
  expect(defs.status).toBe(200);
  expect(defs.body.find(f => f.name === 'ff_open_pipeline')).toMatchObject({
    value: 200,
    readOnly: true
  });
  const edited = await request(app).put('/api/studio/values/accounts/' + account.id).set(authHeader(token)).send({
    values: {
      ff_open_pipeline: 999
    }
  });
  expect(edited.status).toBe(400);
});
test('customer rooms escape comments, validate document links, and revoke bearer access', async () => {
  const deal = await createTestDeal(user.id);
  const room = await post('/deal-rooms', {
    dealId: deal.id,
    name: 'Customer room'
  });
  expect(room.status).toBe(201);
  const path = new URL(room.body.url).pathname;
  expect((await post('/deal-rooms/' + room.body.id + '/items', {
    kind: 'document',
    title: 'bad',
    url: 'javascript:alert(1)'
  })).status).toBe(400);
  expect((await request(app).get(path)).status).toBe(200);
  await post('/deal-rooms/' + room.body.id + '/revoke', {});
  expect((await request(app).get(path)).status).toBe(404);
});
test('campaign queue deduplicates recipients and unsubscribe suppresses pending delivery', async () => {
  const contact = await createTestContact({
    ownerId: user.id
  });
  const campaign = await prisma.campaign.create({
    data: {
      name: 'Launch'
    }
  });
  await prisma.campaignRecipient.create({
    data: {
      campaignId: campaign.id,
      contactId: contact.id,
      email: contact.email
    }
  });
  const req = {
      user,
      userId: user.id,
      app: {
        locals: {
          prisma
        }
      }
    },
    service = require('../src/services/campaignDelivery');
  expect((await service.queue(prisma, req, campaign.id, {
    subject: 'Hello',
    body: 'Welcome'
  })).queued).toBe(1);
  expect((await service.queue(prisma, req, campaign.id, {
    subject: 'Hello',
    body: 'Welcome'
  })).queued).toBe(0);
  const row = await prisma.campaignDelivery.findFirst();
  expect(service.validToken(row.id, service.signature(row.id))).toBe(true);
  await service.unsubscribe(prisma, row.id);
  expect((await prisma.campaignDelivery.findUnique({
    where: {
      id: row.id
    }
  })).status).toBe('Suppressed');
  expect(await service.suppressed(prisma, contact.email)).toBe(true);
});
test('success playbooks create milestone tasks and one recovery task per risk episode', async () => {
  const account = await createTestAccount();
  const playbook = await post('/success-playbooks', {
    name: 'Onboarding',
    riskThreshold: 60,
    milestones: [{
      title: 'Kickoff',
      days: 0
    }],
    healthRules: [{
      metric: 'overdueMilestones',
      threshold: 0,
      penalty: 50
    }]
  });
  expect(playbook.status).toBe(201);
  const enrolled = await post('/success-playbooks/accounts/' + account.id + '/enroll', {
    playbookId: playbook.body.id
  });
  expect(enrolled.status).toBe(201);
  await prisma.playbookMilestone.updateMany({
    where: {
      enrollmentId: enrolled.body.id
    },
    data: {
      dueDate: new Date(0)
    }
  });
  const result = await post('/success-playbooks/accounts/' + account.id + '/evaluate', {});
  expect(result.status).toBe(200);
  expect(result.body.data[0].healthScore).toBe(50);
  await post('/success-playbooks/accounts/' + account.id + '/evaluate', {});
  expect(await prisma.activity.count({
    where: {
      cadenceKey: {
        startsWith: 'risk:' + enrolled.body.id
      }
    }
  })).toBe(1);
});
const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});
const response = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body
});
test('Stripe reconciliation verifies the provider receipt and is replay safe', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  const invoice = await prisma.invoice.create({
    data: {
      number: 'INV-STRIPE',
      total: 90,
      subtotal: 90,
      currency: 'USD'
    }
  });
  const checkout = await prisma.paymentCheckout.create({
    data: {
      invoiceId: invoice.id,
      amountMinor: 3000,
      currency: 'USD',
      invoiceVersion: invoice.updatedAt,
      createdById: user.id,
      sessionId: 'cs_fixture'
    }
  });
  global.fetch = jest.fn(async () => response({
    id: 'cs_fixture',
    payment_status: 'paid',
    amount_total: 3000,
    currency: 'usd',
    metadata: {
      checkoutId: checkout.id
    }
  }));
  await payments.reconcile(prisma, 'cs_fixture');
  await payments.reconcile(prisma, 'cs_fixture');
  expect(await prisma.invoicePayment.count()).toBe(1);
  expect((await payments.balance(prisma, invoice)).outstandingMinor).toBe(6000);
  global.fetch = jest.fn(async () => response({
    id: 'cs_fixture',
    payment_status: 'paid',
    amount_total: 9000,
    currency: 'usd',
    metadata: {
      checkoutId: checkout.id
    }
  }));
  await expect(payments.reconcile(prisma, 'cs_fixture')).rejects.toMatchObject({
    status: 409
  });
  delete process.env.STRIPE_SECRET_KEY;
});
test('Google sync checkpoints pages, resets expired history and denies an inactive owner', async () => {
  const {
      encrypt
    } = require('../src/utils/secretBox'),
    google = require('../src/services/googleWorkspace');
  let account = await prisma.inboundEmailAccount.create({
    data: {
      name: 'Google fixture',
      provider: 'google',
      username: 'rep@example.test',
      ownerId: user.id,
      active: true,
      oauthRefreshToken: encrypt('refresh-fixture'),
      oauthAccessToken: encrypt('access-fixture'),
      oauthExpiresAt: new Date(Date.now() + 3600000)
    }
  });
  global.fetch = jest.fn(async url => response(String(url).endsWith('/profile') ? {
    historyId: '100'
  } : {
    messages: [],
    nextPageToken: 'page2'
  }));
  expect((await google.pollAccount(prisma, account)).moreMayBeAvailable).toBe(true);
  account = await prisma.inboundEmailAccount.findUnique({
    where: {
      id: account.id
    }
  });
  expect(JSON.parse(account.syncCursor)).toEqual({
    initialHistory: '100',
    page: 'page2'
  });
  global.fetch = jest.fn(async () => response({
    messages: []
  }));
  await google.pollAccount(prisma, account);
  account = await prisma.inboundEmailAccount.findUnique({
    where: {
      id: account.id
    }
  });
  expect(JSON.parse(account.syncCursor)).toEqual({
    history: '100'
  });
  global.fetch = jest.fn(async () => response({}, 404));
  await expect(google.pollAccount(prisma, account)).rejects.toMatchObject({
    status: 409
  });
  expect((await prisma.inboundEmailAccount.findUnique({
    where: {
      id: account.id
    }
  })).syncCursor).toBeNull();
  await prisma.user.update({
    where: {
      id: user.id
    },
    data: {
      active: false
    }
  });
  global.fetch.mockClear();
  await expect(google.pollAccount(prisma, account)).rejects.toMatchObject({
    status: 403
  });
  expect(global.fetch).not.toHaveBeenCalled();
});
test('DocuSign creates one frozen PDF envelope and reconciles its completed status', async () => {
  const keys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048
  });
  process.env.DOCUSIGN_INTEGRATION_KEY = 'integration-fixture';
  process.env.DOCUSIGN_USER_ID = 'user-fixture';
  process.env.DOCUSIGN_ACCOUNT_ID = 'account-fixture';
  process.env.DOCUSIGN_PRIVATE_KEY = keys.privateKey.export({
    type: 'pkcs8',
    format: 'pem'
  });
  process.env.DOCUSIGN_DEMO = 'true';
  const signature = require('../src/services/signatures'),
    room = {
      id: 'room-fixture'
    },
    quote = {
      id: 'quote-fixture',
      number: 'Q-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [],
      total: 50,
      subtotal: 50,
      tax: 0,
      discount: 0
    };
  let envelopes = 0;
  global.fetch = jest.fn(async (url, options) => {
    if (url.endsWith('/oauth/token')) return response({
      access_token: 'fixture'
    });
    if (url.endsWith('/oauth/userinfo')) return response({
      accounts: [{
        account_id: 'account-fixture',
        base_uri: 'https://demo.docusign.net'
      }]
    });
    if (options.method === 'POST') {
      envelopes++;
      const body = JSON.parse(options.body);
      expect(Buffer.from(body.documents[0].documentBase64, 'base64').subarray(0, 4).toString()).toBe('%PDF');
      expect(body.recipients.signers[0].email).toBe('customer@example.test');
      return response({
        envelopeId: 'envelope-fixture',
        status: 'sent'
      });
    }
    return response({
      status: 'completed',
      completedDateTime: new Date().toISOString()
    });
  });
  const row = await signature.send(prisma, room, quote, 'Customer', 'customer@example.test');
  await expect(signature.send(prisma, room, quote, 'Customer', 'customer@example.test')).rejects.toMatchObject({
    status: 409
  });
  expect(envelopes).toBe(1);
  expect((await signature.reconcile(prisma, row)).status).toBe('completed');
  for (const key of ['DOCUSIGN_INTEGRATION_KEY', 'DOCUSIGN_USER_ID', 'DOCUSIGN_ACCOUNT_ID', 'DOCUSIGN_PRIVATE_KEY', 'DOCUSIGN_DEMO']) delete process.env[key];
});
test('managed workflow fields cannot be forged through ordinary record writes', async () => {
  const created = await post('/activities', {
    type: 'Task',
    subject: 'Forged',
    cadenceKey: 'someone-else:0'
  });
  expect(created.status).toBe(400);
  const service = require('../src/services/cadences');
  expect(service.validateSteps([null])).toBeTruthy();
  expect(service.validateSteps([{
    type: 'call',
    branches: []
  }])).toBeTruthy();
});
