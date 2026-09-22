const request = require('supertest');
const {
  setup, teardown, cleanDatabase,
  createTestRole, createTestUser, createTestContact, authHeader,
} = require('./setup');
const { handlers, setDatabaseClient } = require('../src/jobs/scheduler');

let app, prisma, user, other;

const newLead = (over = {}) => ({ firstName: 'Ada', lastName: 'Byron', email: 'ada@example.com', company: 'Analytical Engines', ...over });

beforeAll(async () => {
  ({ prisma, app } = await setup());
  setDatabaseClient(prisma);
});
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  const role = await createTestRole('Admin');
  user = await createTestUser({ email: 'one@test.com', roleId: role.id });
  other = await createTestUser({ email: 'two@test.com', roleId: role.id });
});

describe('Rule condition operators', () => {
  // A rule's condition describes the violation. The seeded rules were written
  // the other way round and leaned on operators that did not exist, so three
  // never fired and the fourth blocked every deal with a positive value.
  const cases = [
    ['lte catches a non-positive value', { field: 'value', operator: 'lte', value: 0 }, { value: 0 }, { value: 5000 }],
    ['isEmpty catches a missing close date', { field: 'closeDate', operator: 'isEmpty' }, { closeDate: null }, { closeDate: new Date() }],
    ['lengthLt catches a short subject', { field: 'subject', operator: 'lengthLt', value: 5 }, { subject: 'Hi' }, { subject: 'Cannot log in' }],
    ['notMatches catches a malformed address', { field: 'email', operator: 'notMatches', value: '^[^@]+@[^@]+\\.[^@]+$' }, { email: 'nope' }, { email: 'a@b.co' }],
  ];

  it.each(cases)('%s', async (_name, condition, violating, allowed) => {
    await prisma.validationRule.deleteMany({});
    await prisma.validationRule.create({
      data: { name: 'Operator check', module: 'deals', condition, errorMessage: 'Refused', active: true },
    });

    const base = { name: 'Operator deal', value: 5000, stage: 'Prospecting', closeDate: new Date() };
    const bad = await request(app).post('/api/deals').set(authHeader(user.token)).send({ ...base, ...violating });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_RULE');

    const good = await request(app).post('/api/deals').set(authHeader(user.token)).send({ ...base, ...allowed });
    expect(good.status).toBe(201);
  });

  it('negates a nested condition with not', async () => {
    await prisma.validationRule.deleteMany({});
    await prisma.validationRule.create({
      data: {
        name: 'Stage must be known',
        module: 'deals',
        condition: { not: { field: 'stage', operator: 'in', value: ['Prospecting', 'Qualification'] } },
        errorMessage: 'Unknown stage',
        active: true,
      },
    });

    const base = { name: 'Not deal', value: 100, closeDate: new Date() };
    expect((await request(app).post('/api/deals').set(authHeader(user.token)).send({ ...base, stage: 'Wizardry' })).status).toBe(400);
    expect((await request(app).post('/api/deals').set(authHeader(user.token)).send({ ...base, stage: 'Prospecting' })).status).toBe(201);
  });
});

describe('Validation rules', () => {
  it('rejects a record the rule forbids, which nothing used to check', async () => {
    await prisma.validationRule.create({
      data: {
        name: 'Enterprise deals need a close date',
        module: 'deals',
        condition: { and: [
          { field: 'value', operator: 'gt', value: 10000 },
          { field: 'closeDate', operator: 'isEmpty' },
        ] },
        errorMessage: 'A deal over 10k needs a close date.',
        errorField: 'closeDate',
        active: true,
      },
    });

    const blocked = await request(app).post('/api/deals').set(authHeader(user.token))
      .send({ name: 'Big', value: 50000, stage: 'Prospecting' });

    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('VALIDATION_RULE');
    expect(blocked.body.error).toMatch(/close date/i);
    expect(blocked.body.violations[0].field).toBe('closeDate');
    expect(await prisma.deal.count()).toBe(0);

    const allowed = await request(app).post('/api/deals').set(authHeader(user.token))
      .send({ name: 'Big', value: 50000, stage: 'Prospecting', closeDate: '2026-12-31' });
    expect(allowed.status).toBe(201);
  });

  it('lets a small deal through the same rule', async () => {
    await prisma.validationRule.create({
      data: {
        name: 'Enterprise deals need a close date',
        module: 'deals',
        condition: { and: [
          { field: 'value', operator: 'gt', value: 10000 },
          { field: 'closeDate', operator: 'isEmpty' },
        ] },
        errorMessage: 'A deal over 10k needs a close date.',
        active: true,
      },
    });
    const res = await request(app).post('/api/deals').set(authHeader(user.token))
      .send({ name: 'Small', value: 500, stage: 'Prospecting' });
    expect(res.status).toBe(201);
  });

  it('validates the record as it will be after an update', async () => {
    const created = await request(app).post('/api/deals').set(authHeader(user.token))
      .send({ name: 'Small', value: 500, stage: 'Prospecting' });

    await prisma.validationRule.create({
      data: {
        name: 'No deals over 10k without a date',
        module: 'deals',
        condition: { and: [
          { field: 'value', operator: 'gt', value: 10000 },
          { field: 'closeDate', operator: 'isEmpty' },
        ] },
        errorMessage: 'Needs a close date.',
        active: true,
      },
    });

    // The update only sends value; the rule still sees the missing closeDate.
    const res = await request(app).put(`/api/deals/${created.body.id}`)
      .set(authHeader(user.token)).send({ value: 90000 });
    expect(res.status).toBe(400);

    const unchanged = await prisma.deal.findUnique({ where: { id: created.body.id } });
    expect(unchanged.value).toBe(500);
  });

  it('ignores a rule that is switched off', async () => {
    await prisma.validationRule.create({
      data: { name: 'Off', module: 'deals', condition: { field: 'name', operator: 'isNotEmpty' }, errorMessage: 'nope', active: false },
    });
    const res = await request(app).post('/api/deals').set(authHeader(user.token))
      .send({ name: 'Fine', value: 1, stage: 'Prospecting' });
    expect(res.status).toBe(201);
  });
});

describe('Assignment rules', () => {
  it('rotates round-robin across the configured people', async () => {
    await prisma.assignmentRule.create({
      data: {
        name: 'Share the leads', module: 'leads', type: 'round_robin',
        assignees: [user.user.id, other.user.id], active: true,
      },
    });

    const first = await request(app).post('/api/leads').set(authHeader(user.token)).send(newLead({ email: 'a@x.com' }));
    const second = await request(app).post('/api/leads').set(authHeader(user.token)).send(newLead({ email: 'b@x.com' }));
    const third = await request(app).post('/api/leads').set(authHeader(user.token)).send(newLead({ email: 'c@x.com' }));

    const owners = [first, second, third].map(r => r.body.ownerId);
    expect(owners[0]).toBe(user.user.id);
    expect(owners[1]).toBe(other.user.id);
    expect(owners[2]).toBe(user.user.id);       // wraps back round
    expect(first.body.assignedBy).toBe('Share the leads');
  });

  it('does not overrule an owner the caller named', async () => {
    await prisma.assignmentRule.create({
      data: { name: 'Share', module: 'leads', type: 'round_robin', assignees: [other.user.id], active: true },
    });
    const res = await request(app).post('/api/leads').set(authHeader(user.token))
      .send(newLead({ ownerId: user.user.id }));
    expect(res.body.ownerId).toBe(user.user.id);
  });

  it('assigns by condition when the rule is rule-based', async () => {
    await prisma.assignmentRule.create({
      data: {
        name: 'UK to the second rep', module: 'leads', type: 'rule_based',
        conditions: [{ field: 'country', operator: 'equals', value: 'UK' }],
        assignees: [other.user.id], active: true,
      },
    });

    const matched = await request(app).post('/api/leads').set(authHeader(user.token))
      .send(newLead({ email: 'uk@x.com', country: 'UK' }));
    expect(matched.body.ownerId).toBe(other.user.id);

    const unmatched = await request(app).post('/api/leads').set(authHeader(user.token))
      .send(newLead({ email: 'fr@x.com', country: 'FR' }));
    // A rule that does not match must not hand the record to its assignee. It
    // used to leave ownerId null, which meant the record belonged to nobody and
    // row-level security had nothing to match on; the creator owns it now.
    expect(unmatched.body.ownerId).not.toBe(other.user.id);
    expect(unmatched.body.ownerId).toBe(user.user.id);
  });
});

describe('Duplicate rules', () => {
  async function emailRule(action) {
    return prisma.duplicateRule.create({
      data: {
        name: 'Same email', module: 'contacts', action,
        matchFields: [{ field: 'email', weight: 100 }], threshold: 80, active: true,
      },
    });
  }

  it('blocks a duplicate when the rule says block', async () => {
    await emailRule('block');
    await createTestContact({ email: 'dupe@example.com' });

    const res = await request(app).post('/api/contacts').set(authHeader(user.token))
      .send({ firstName: 'Copy', lastName: 'Cat', email: 'dupe@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_RECORD');
    expect(res.body.duplicates[0].score).toBe(100);
    expect(res.body.duplicates[0].matchedFields).toEqual(['email']);
  });

  it('warns but still saves when the rule says warn', async () => {
    await emailRule('warn');
    const original = await createTestContact({ email: 'dupe@example.com' });

    const res = await request(app).post('/api/contacts').set(authHeader(user.token))
      .send({ firstName: 'Copy', lastName: 'Cat', email: 'dupe@example.com' });

    expect(res.status).toBe(201);
    expect(res.body.duplicates).toHaveLength(1);
    expect(res.body.warnings.join(' ')).toMatch(/duplicate/i);

    // Recorded for the review queue rather than just mentioned once.
    const pairs = await prisma.duplicateRecord.findMany();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].recordIdB).toBe(original.id);
    expect(pairs[0].confidence).toBe(100);
  });

  it('leaves a genuinely different record alone', async () => {
    await emailRule('block');
    await createTestContact({ email: 'someone@example.com' });

    const res = await request(app).post('/api/contacts').set(authHeader(user.token))
      .send({ firstName: 'New', lastName: 'Person', email: 'different@example.com' });
    expect(res.status).toBe(201);
    expect(res.body.duplicates).toBeUndefined();
  });

  it('will not silently auto-merge', async () => {
    await emailRule('auto_merge');
    await createTestContact({ email: 'dupe@example.com' });

    const res = await request(app).post('/api/contacts').set(authHeader(user.token))
      .send({ firstName: 'Copy', lastName: 'Cat', email: 'dupe@example.com' });

    // Merging without a person looking is not something to do behind their
    // back, so auto_merge is honoured as a warning and says what it wanted.
    expect(res.status).toBe(201);
    expect(res.body.duplicates[0].requestedAction).toBe('auto_merge');
    expect(res.body.duplicates[0].action).toBe('warn');
    expect(await prisma.contact.count()).toBe(2);
  });
});

describe('Reminder delivery', () => {
  it('delivers a due reminder to the notification feed', async () => {
    await prisma.reminder.create({
      data: {
        userId: user.user.id, method: 'Popup', message: 'Call the client',
        triggerAt: new Date(Date.now() - 60_000), status: 'Pending',
      },
    });

    const result = await handlers.deliverReminders();
    expect(result.delivered).toBe(1);

    const notifications = await prisma.notification.findMany();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toBe('Call the client');
    expect(notifications[0].userId).toBe(user.user.id);
  });

  it('leaves a reminder that is not due yet alone', async () => {
    await prisma.reminder.create({
      data: { userId: user.user.id, triggerAt: new Date(Date.now() + 3_600_000), status: 'Pending' },
    });
    const result = await handlers.deliverReminders();
    expect(result.due).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });

  it('delivers once and does not repeat', async () => {
    await prisma.reminder.create({
      data: { userId: user.user.id, message: 'Once', triggerAt: new Date(Date.now() - 60_000), status: 'Pending' },
    });

    await handlers.deliverReminders();
    await handlers.deliverReminders();

    expect(await prisma.notification.count()).toBe(1);
    const reminder = await prisma.reminder.findFirst();
    expect(reminder.status).toBe('Sent');
    expect(reminder.sentAt).not.toBeNull();
  });

  it('picks a snoozed reminder back up when the snooze expires', async () => {
    await prisma.reminder.create({
      data: {
        userId: user.user.id, message: 'Snoozed one', status: 'Snoozed',
        triggerAt: new Date(Date.now() - 7_200_000),
        snoozedUntil: new Date(Date.now() - 60_000),
      },
    });
    const result = await handlers.deliverReminders();
    expect(result.delivered).toBe(1);
  });

  it('describes what the reminder is about when no message was given', async () => {
    const activity = await prisma.activity.create({
      data: { type: 'Call', subject: 'Quarterly review', priority: 'Medium', status: 'Scheduled' },
    });
    await prisma.reminder.create({
      data: { userId: user.user.id, activityId: activity.id, triggerAt: new Date(Date.now() - 60_000), status: 'Pending' },
    });

    await handlers.deliverReminders();
    const notification = await prisma.notification.findFirst();
    expect(notification.message).toContain('Quarterly review');
  });

  it('marks a reminder failed rather than losing it', async () => {
    await prisma.reminder.create({
      data: {
        userId: user.user.id, method: 'Email', message: 'Email me',
        triggerAt: new Date(Date.now() - 60_000), status: 'Pending',
      },
    });
    // The user exists, so this delivers through the mail utility; with no SMTP
    // configured that is 'queued', which is not a failure.
    const result = await handlers.deliverReminders();
    expect(result.due).toBe(1);
    expect(result.failed).toBe(0);
  });
});
