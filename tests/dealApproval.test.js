/**
 * Submitting a deal for approval (POST /api/deals/:id/submit).
 *
 * The other way in, POST /api/approvals/requests, fires approval.requested;
 * this one did not, so a subscription heard about some requests and not others.
 */
const supertest = require('supertest');
const {
  setup, teardown, cleanDatabase, createTestRole, createTestUser, createTestDeal, authHeader,
} = require('./setup');

let app, prisma, submitter, approver;

/**
 * The events in the webhook log. Deliveries are logged whether or not the
 * (unresolvable) target answers, but not synchronously: wait for `atLeast` of
 * them, or a moment when none is expected, to show that none came.
 */
async function loggedEvents({ atLeast = 0 } = {}) {
  const deadline = Date.now() + (atLeast ? 8000 : 600);
  for (;;) {
    const logs = await prisma.webhookLog.findMany();
    if ((atLeast && logs.length >= atLeast) || Date.now() > deadline) return logs.map(log => log.event);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  const repRole = await createTestRole('Sales Rep');
  const adminRole = await createTestRole('Admin');
  submitter = await createTestUser({ email: 'rep@test.com', roleId: repRole.id });
  approver = await createTestUser({ email: 'boss@test.com', roleId: adminRole.id });
  await prisma.approvalProcess.create({
    data: {
      name: 'Big deals', module: 'deals', active: true, entryConditions: [],
      steps: { create: [{ stepOrder: 1, name: 'Manager', approverType: 'user', approverId: approver.user.id }] },
    },
  });
  // Nothing can resolve this name, so the delivery fails; it is still logged.
  await prisma.webhook.create({
    data: { name: 'probe', url: 'https://review-probe.invalid/hook', events: ['approval.requested'], secret: 's', active: true, retries: 1, createdById: approver.user.id },
  });
});

describe('POST /api/deals/:id/submit', () => {
  it('files a pending request for the approver and fires approval.requested', async () => {
    const deal = await createTestDeal(submitter.user.id, { name: 'Big one', value: 900000 });

    const res = await supertest(app).post(`/api/deals/${deal.id}/submit`).set(authHeader(submitter.token)).send({});

    expect(res.status).toBe(200);
    expect(res.body.approvalRequest).toMatchObject({ module: 'deals', recordId: deal.id, status: 'Pending' });
    expect(await loggedEvents({ atLeast: 1 })).toEqual(['approval.requested']);
    const log = await prisma.webhookLog.findFirst();
    expect(log.payload).toMatchObject({ id: res.body.approvalRequest.id, module: 'deals', recordId: deal.id });
  });

  it('fires nothing when the submit is refused', async () => {
    const deal = await createTestDeal(submitter.user.id);
    await prisma.approvalProcess.updateMany({ data: { active: false } });

    const res = await supertest(app).post(`/api/deals/${deal.id}/submit`).set(authHeader(submitter.token)).send({});

    expect(res.status).toBe(400);
    expect(await loggedEvents()).toEqual([]);
  });
});

describe('submitting the same deal twice at the same moment', () => {
  const pending = deal => prisma.approvalRequest.count({ where: { recordId: deal.id, status: 'Pending' } });

  it('files one request: "is one open already?" and the create were two steps, and a double click passed both', async () => {
    const deal = await createTestDeal(submitter.user.id, { value: 900000 });
    const send = () => supertest(app).post(`/api/deals/${deal.id}/submit`).set(authHeader(submitter.token)).send({});

    const responses = await Promise.all([send(), send(), send()]);

    expect(responses.filter(r => r.status === 200)).toHaveLength(1);
    expect(responses.filter(r => r.status === 409)).toHaveLength(2);
    expect(await pending(deal)).toBe(1);
  });

  it('does not let the two ways of submitting race each other either', async () => {
    const deal = await createTestDeal(submitter.user.id, { value: 900000 });
    const process = await prisma.approvalProcess.findFirst();

    const responses = await Promise.all([
      supertest(app).post(`/api/deals/${deal.id}/submit`).set(authHeader(submitter.token)).send({}),
      supertest(app).post('/api/approvals/requests').set(authHeader(submitter.token)).send({ processId: process.id, recordId: deal.id }),
    ]);

    const statuses = responses.map(r => r.status).sort((a, b) => a - b);
    expect([200, 201]).toContain(statuses[0]); // one got through (200 from the deal route, 201 from the other)
    expect(statuses[1]).toBe(409);             // and the other was told it is already on its way
    expect(await pending(deal)).toBe(1);
  });

  it('lets the deal be submitted again once its request has been decided', async () => {
    const deal = await createTestDeal(submitter.user.id, { value: 900000 });
    const first = await supertest(app).post(`/api/deals/${deal.id}/submit`).set(authHeader(submitter.token)).send({});
    expect(first.status).toBe(200);
    await supertest(app).post(`/api/approvals/requests/${first.body.approvalRequest.id}/recall`).set(authHeader(submitter.token)).send({});

    const again = await supertest(app).post(`/api/deals/${deal.id}/submit`).set(authHeader(submitter.token)).send({});

    expect(again.status).toBe(200);
    expect(await pending(deal)).toBe(1);
  });
});
