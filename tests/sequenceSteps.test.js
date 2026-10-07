/**
 * Sending the due steps of email sequences (services/sequenceSteps), which the
 * scheduled job and POST /api/sequences/process share.
 *
 * They counted a step as sent when the mail was only logged (no SMTP server)
 * and moved the enrollment on whether or not the mail went, so a sequence ran
 * to its end in the CRM's records without an email leaving, and a failed send
 * lost its step for good. The mailer is replaced here so no mail can leave.
 */
jest.mock('../src/services/mailer', () => ({ sendEmail: jest.fn() }));

const supertest = require('supertest');
const { sendEmail } = require('../src/services/mailer');
const {
  setup, teardown, cleanDatabase, createTestRole, createTestUser, createTestLead, authHeader,
} = require('./setup');
const { processDueSteps, MAX_FAILURES } = require('../src/services/sequenceSteps');

let app, prisma, user;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const notSuppressed = async () => false;
const delivered = { status: 'sent', delivered: true, transport: 'smtp' };
const failed = { status: 'failed', delivered: false, transport: 'smtp', error: 'mailbox unavailable' };
const run = (isSuppressed = notSuppressed) => processDueSteps(prisma, { isSuppressed });

const STEPS = [
  { delayDays: 0, subject: 'Hello', body: 'one' },
  { delayDays: 2, subject: 'Follow up', body: 'two' },
  { delayDays: 3, subject: 'Last word', body: 'three' },
];

/** A contact enrolled in an active sequence, its next step due a moment ago. */
async function enroll({ steps = STEPS, sequence = {}, contact = {}, enrollment = {} } = {}) {
  const person = await prisma.contact.create({ data: { firstName: 'Sam', lastName: 'Prospect', email: 'prospect@example.test', ...contact } });
  const seq = await prisma.emailSequence.create({ data: { name: 'Nurture', status: 'Active', createdById: user.user.id, steps, ...sequence } });
  const row = await prisma.emailSequenceEnrollment.create({
    data: { sequenceId: seq.id, contactId: person.id, enrolledById: user.user.id, nextSendAt: new Date(Date.now() - 1000), ...enrollment },
  });
  return { person, seq, row };
}
const reload = id => prisma.emailSequenceEnrollment.findUnique({ where: { id } });

const originalSmtp = process.env.SMTP_HOST;

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => {
  if (originalSmtp === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = originalSmtp;
  await teardown();
});
beforeEach(async () => {
  await cleanDatabase();
  const role = await createTestRole('Admin');
  user = await createTestUser({ email: 'sender@test.com', roleId: role.id });
  process.env.SMTP_HOST = 'smtp.invalid'; // "configured": the mailer is replaced, so nothing connects
  sendEmail.mockReset();
  sendEmail.mockResolvedValue(delivered);
});

describe('with no SMTP server', () => {
  it('does nothing and says so: nothing is recorded as sent and no enrollment moves on', async () => {
    delete process.env.SMTP_HOST;
    const { row } = await enroll();

    const result = await run();

    expect(result.skipped).toMatch(/No SMTP server is configured/);
    expect(result.sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await prisma.email.count()).toBe(0);
    expect(await reload(row.id)).toMatchObject({ currentStep: 0, status: 'Active' });
  });

  it('answers the same through POST /api/sequences/process', async () => {
    delete process.env.SMTP_HOST;
    await enroll();

    const res = await supertest(app).post('/api/sequences/process').set(authHeader(user.token)).send({});

    expect(res.status).toBe(200);
    expect(res.body.skipped).toMatch(/No SMTP server is configured/);
  });
});

describe('a step that goes out', () => {
  it('is recorded as sent, and the enrollment moves to the next step at its delay', async () => {
    const { row, person } = await enroll();

    const result = await run();

    expect(result).toMatchObject({ processed: 1, sent: 1, completed: 0, retrying: 0, bounced: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(prisma, { to: 'prospect@example.test', subject: 'Hello', body: 'one' });
    const email = await prisma.email.findFirst();
    expect(email).toMatchObject({ subject: 'Hello', toEmail: 'prospect@example.test', status: 'sent', contactId: person.id });
    expect(email.sentAt).toBeInstanceOf(Date);
    const after = await reload(row.id);
    expect(after.currentStep).toBe(1);
    expect(after.lastSentAt).toBeInstanceOf(Date);
    expect(after.lastError).toBeNull();
    expect(after.nextSendAt.getTime()).toBeGreaterThan(Date.now() + 2 * DAY - 60000);
    expect(after.nextSendAt.getTime()).toBeLessThan(Date.now() + 2 * DAY + 60000);
  });

  it('completes the enrollment after the last step', async () => {
    const { row } = await enroll({ enrollment: { currentStep: 2 } });

    const result = await run();

    expect(result).toMatchObject({ sent: 1, completed: 1 });
    const after = await reload(row.id);
    expect(after).toMatchObject({ status: 'Completed', currentStep: 3, nextSendAt: null });
    expect(after.completedAt).toBeInstanceOf(Date);
  });

  it('goes to a lead as it does to a contact, filing the email on no one', async () => {
    const lead = await createTestLead({ email: 'lead@example.test' });
    const seq = await prisma.emailSequence.create({ data: { name: 'Leads', status: 'Active', createdById: user.user.id, steps: STEPS } });
    await prisma.emailSequenceEnrollment.create({ data: { sequenceId: seq.id, leadId: lead.id, enrolledById: user.user.id, nextSendAt: new Date(Date.now() - 1000) } });

    expect(await run()).toMatchObject({ sent: 1 });

    expect(sendEmail).toHaveBeenCalledWith(prisma, expect.objectContaining({ to: 'lead@example.test' }));
    expect((await prisma.email.findFirst()).contactId).toBeNull();
  });

  it('uses the step\'s template when the step carries no text', async () => {
    const template = await prisma.emailTemplate.create({ data: { name: 'Welcome', subject: 'From the template', body: 'template body', category: 'General' } });
    await enroll({ steps: [{ delayDays: 0, templateId: template.id }] });

    await run();

    expect(sendEmail).toHaveBeenCalledWith(prisma, { to: 'prospect@example.test', subject: 'From the template', body: 'template body' });
  });
});

describe('a send that fails', () => {
  beforeEach(() => { sendEmail.mockResolvedValue(failed); });

  it('leaves the enrollment on its step, to be tried again in an hour', async () => {
    const { row } = await enroll();

    const result = await run();

    expect(result).toMatchObject({ sent: 0, retrying: 1, bounced: 0 });
    const after = await reload(row.id);
    expect(after).toMatchObject({ currentStep: 0, status: 'Active' });
    expect(after.lastError).toBe('mailbox unavailable');
    expect(after.nextSendAt.getTime()).toBeGreaterThan(Date.now() + HOUR - 60000);
    expect(after.nextSendAt.getTime()).toBeLessThan(Date.now() + HOUR + 60000);
    expect(await prisma.email.findFirst()).toMatchObject({ status: 'failed', sentAt: null });
  });

  it('is not tried again before that hour is up', async () => {
    await enroll();
    await run();
    sendEmail.mockClear();

    expect(await run()).toMatchObject({ processed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it(`gives up after ${MAX_FAILURES} failures, marking the enrollment Bounced`, async () => {
    const { row } = await enroll();
    const results = [];
    for (let attempt = 0; attempt < MAX_FAILURES; attempt++) {
      results.push(await run());
      await prisma.emailSequenceEnrollment.updateMany({ where: { id: row.id, status: 'Active' }, data: { nextSendAt: new Date(Date.now() - 1000) } });
    }

    expect(results.map(r => r.retrying)).toEqual([1, 1, 0]);
    expect(results[MAX_FAILURES - 1].bounced).toBe(1);
    expect(await reload(row.id)).toMatchObject({ status: 'Bounced', nextSendAt: null, currentStep: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(MAX_FAILURES);

    sendEmail.mockClear();
    expect(await run()).toMatchObject({ processed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('is sent once it can be: the step is still there when the next attempt goes out', async () => {
    const { row } = await enroll();
    await run();
    await prisma.emailSequenceEnrollment.update({ where: { id: row.id }, data: { nextSendAt: new Date(Date.now() - 1000) } });
    sendEmail.mockResolvedValue(delivered);

    expect(await run()).toMatchObject({ sent: 1 });
    expect(await reload(row.id)).toMatchObject({ currentStep: 1, status: 'Active' });
  });
});

describe('two runs at the same moment', () => {
  it('send the step once', async () => {
    sendEmail.mockImplementation(async () => { await sleep(200); return delivered; });
    const { row } = await enroll();

    const [a, b] = await Promise.all([run(), run()]);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect([a, b].filter(r => r.skipped)).toHaveLength(1);
    expect([a, b].find(r => r.skipped).skipped).toMatch(/already being processed/);
    expect(await prisma.email.count()).toBe(1);
    expect((await reload(row.id)).currentStep).toBe(1);
  });
});

describe('what is left alone', () => {
  it('skips a suppressed address, sends nothing, and moves on', async () => {
    const { row } = await enroll();

    const result = await run(async address => address === 'prospect@example.test');

    expect(result).toMatchObject({ processed: 1, sent: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect((await reload(row.id)).currentStep).toBe(1);
  });

  it('skips a deleted contact, sends nothing, and moves on', async () => {
    const { row } = await enroll({ contact: { deletedAt: new Date() } });

    expect(await run()).toMatchObject({ processed: 1, sent: 0 });

    expect(sendEmail).not.toHaveBeenCalled();
    expect((await reload(row.id)).currentStep).toBe(1);
  });

  it('does not touch the enrollments of a paused sequence, or ones not yet due', async () => {
    await enroll({ sequence: { status: 'Paused' } });
    await enroll({ contact: { email: 'later@example.test' }, enrollment: { nextSendAt: new Date(Date.now() + DAY) } });

    expect(await run()).toMatchObject({ processed: 0, sent: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('completes an enrollment that has run past its last step, without sending', async () => {
    const { row } = await enroll({ enrollment: { currentStep: 5 } });

    expect(await run()).toMatchObject({ processed: 1, sent: 0, completed: 1 });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(await reload(row.id)).toMatchObject({ status: 'Completed', nextSendAt: null });
  });
});
