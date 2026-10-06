/**
 * The email-to-case webhook: who may thread a reply into an existing case.
 *
 * Case numbers run in sequence, so a "[Case# CS-001]" tag in a subject proves
 * nothing about the sender. Only the case's own contact threads by tag; anyone
 * else's mail opens a case of its own, as the mailbox pipeline already does.
 */
const request = require('supertest');
const { setup, teardown, cleanDatabase } = require('./setup');

const SECRET = 'test-email-to-case-secret';
let app, prisma, customer, ownCase;

beforeAll(async () => {
  ({ prisma, app } = await setup());
  await cleanDatabase();
  process.env.EMAIL_TO_CASE_SECRET = SECRET;
  customer = await prisma.contact.create({ data: { firstName: 'Jane', lastName: 'Customer', email: 'jane@customer.example' } });
});

afterAll(async () => {
  delete process.env.EMAIL_TO_CASE_SECRET;
  await teardown();
});

const inbound = payload => request(app).post('/api/public/email-to-case/inbound').set('X-Webhook-Secret', SECRET).send(payload);
const commentsOn = caseId => prisma.caseComment.findMany({ where: { caseId } });

describe('Email-to-case threading', () => {
  test('refuses a caller without the webhook secret', async () => {
    const res = await request(app).post('/api/public/email-to-case/inbound').send({ from: 'x@y.example', subject: 'Hello' });
    expect(res.status).toBe(401);
  });

  test('a new email from a known contact opens a case linked to them', async () => {
    const res = await inbound({ from: 'jane@customer.example', subject: 'Printer is on fire', body: 'Please help' });
    expect(res.status).toBe(201);
    expect(res.body.action).toBe('case_created');
    ownCase = await prisma.case.findUnique({ where: { id: res.body.caseId } });
    expect(ownCase.contactId).toBe(customer.id);
    expect(ownCase.contactEmail).toBe('jane@customer.example');
  });

  test('the case\'s own contact threads a reply by its tag', async () => {
    const res = await inbound({ from: 'jane@customer.example', subject: `Re: [Case# ${ownCase.caseNumber}] Printer is on fire`, body: 'Still burning' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: 'comment_added', caseId: ownCase.id });
    const comments = await commentsOn(ownCase.id);
    expect(comments.map(c => [c.text, c.isPublic, c.authorEmail])).toEqual([['Still burning', true, 'jane@customer.example']]);
  });

  test('anyone else using the tag opens a case of their own and writes nothing into this one', async () => {
    const before = await commentsOn(ownCase.id);
    const res = await inbound({ from: 'mallory@elsewhere.example', subject: `Re: [Case# ${ownCase.caseNumber}] Printer is on fire`, body: 'Click this link to pay your invoice' });
    expect(res.status).toBe(201);
    expect(res.body.action).toBe('case_created');
    expect(res.body.caseId).not.toBe(ownCase.id);
    expect(await commentsOn(ownCase.id)).toHaveLength(before.length);
    const theirs = await prisma.case.findUnique({ where: { id: res.body.caseId } });
    expect(theirs.contactEmail).toBe('mallory@elsewhere.example');
    expect(theirs.contactId).toBeNull();
  });

  test('a tag with only the digits of the number works for the owner, not for others', async () => {
    const digits = ownCase.caseNumber.replace(/^\D+/, '');
    const stranger = await inbound({ from: 'mallory@elsewhere.example', subject: `[Case# ${digits}] hello`, body: 'x' });
    expect(stranger.body.action).toBe('case_created');
    const owner = await inbound({ from: 'jane@customer.example', subject: `[Case# ${digits}] hello again`, body: 'y' });
    expect(owner.body).toMatchObject({ action: 'comment_added', caseId: ownCase.id });
  });

  test('the sender is matched by address whatever form the provider sends it in', async () => {
    for (const from of ['Jane Customer <JANE@Customer.Example>', { address: 'jane@customer.example', name: 'Jane' }, { email: 'Jane@customer.example' }]) {
      const res = await inbound({ from, subject: `[Case# ${ownCase.caseNumber}] update`, body: 'z' });
      expect([JSON.stringify(from), res.body.action, res.body.caseId]).toEqual([JSON.stringify(from), 'comment_added', ownCase.id]);
    }
    // And a new case from a display-name sender stores the address alone.
    const fresh = await inbound({ from: 'Jane Customer <jane@customer.example>', subject: 'Another question', body: 'q' });
    const created = await prisma.case.findUnique({ where: { id: fresh.body.caseId } });
    expect(created.contactEmail).toBe('jane@customer.example');
    expect(created.contactId).toBe(customer.id);
  });

  test('a case linked to a contact threads for that contact\'s address even when the case holds none', async () => {
    const linked = await prisma.case.create({ data: { caseNumber: 'CS-90001', subject: 'Opened by an agent', contactId: customer.id } });
    const res = await inbound({ from: 'jane@customer.example', subject: '[Case# CS-90001] thanks', body: 'ok' });
    expect(res.body).toMatchObject({ action: 'comment_added', caseId: linked.id });
    const other = await inbound({ from: 'someone@else.example', subject: '[Case# CS-90001] thanks', body: 'no' });
    expect(other.body.action).toBe('case_created');
  });
});
