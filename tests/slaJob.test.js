/**
 * The SLA job (enforceSla): warn once, escalate once.
 *
 * It excluded only the status "Escalated", so a case an agent had picked up
 * (In Progress) after an escalation was escalated again on every run: a new
 * history row and a new case.escalated webhook every half hour.
 */
const {
  setup, teardown, cleanDatabase, createTestRole, createTestUser,
} = require('./setup');
const { handlers, setDatabaseClient } = require('../src/jobs/scheduler');

let prisma, user;
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  ({ prisma } = await setup());
  setDatabaseClient(prisma);
});
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  const role = await createTestRole('Admin');
  user = await createTestUser({ email: 'agent@test.com', roleId: role.id });
  // Warn after 2 hours, escalate after 4.
  await prisma.slaPolicy.create({ data: { name: 'High', priority: 'High', firstResponseMinutes: 120, escalateAfterMinutes: 240, active: true } });
});

const makeCase = (over = {}) => prisma.case.create({
  data: {
    caseNumber: `CS-${Math.random().toString(36).slice(2, 8)}`,
    subject: 'Printer on fire',
    priority: 'High',
    status: 'Open',
    assignedId: user.user.id,
    createdAt: new Date(Date.now() - 5 * HOUR),
    ...over,
  },
});

const historyRows = caseId => prisma.caseStatusHistory.count({ where: { caseId, toStatus: 'Escalated' } });
const warnings = caseId => prisma.notification.count({ where: { recordId: caseId, title: 'SLA Breach Warning' } });

describe('enforceSla', () => {
  it('escalates a case past its escalation time, and warns its assignee', async () => {
    const cs = await makeCase();
    const result = await handlers.enforceSla();

    expect(result.escalated).toBe(1);
    const saved = await prisma.case.findUnique({ where: { id: cs.id } });
    expect(saved).toMatchObject({ status: 'Escalated', isEscalated: true, slaBreached: true });
    expect(saved.escalatedAt).toBeInstanceOf(Date);
    expect(await historyRows(cs.id)).toBe(1);
    expect(await warnings(cs.id)).toBe(1);
  });

  it('does not escalate it a second time once an agent has picked it up', async () => {
    const cs = await makeCase();
    await handlers.enforceSla();
    // An agent takes the escalated case on.
    await prisma.case.update({ where: { id: cs.id }, data: { status: 'In Progress' } });

    const second = await handlers.enforceSla();

    expect(second.escalated).toBe(0);
    const saved = await prisma.case.findUnique({ where: { id: cs.id } });
    expect(saved.status).toBe('In Progress');
    expect(await historyRows(cs.id)).toBe(1);
    expect(await warnings(cs.id)).toBe(1);
  });

  it('leaves a case that was escalated by hand alone, whatever its status is now', async () => {
    const cs = await makeCase({ status: 'In Progress', isEscalated: true, escalatedAt: new Date(), slaBreached: true });
    const result = await handlers.enforceSla();

    expect(result.escalated).toBe(0);
    expect((await prisma.case.findUnique({ where: { id: cs.id } })).status).toBe('In Progress');
    expect(await historyRows(cs.id)).toBe(0);
  });

  it('warns once when a case is past the response time but not yet the escalation time', async () => {
    const cs = await makeCase({ createdAt: new Date(Date.now() - 3 * HOUR) });

    expect((await handlers.enforceSla()).warned).toBe(1);
    expect((await handlers.enforceSla()).warned).toBe(0);

    const saved = await prisma.case.findUnique({ where: { id: cs.id } });
    expect(saved).toMatchObject({ status: 'Open', isEscalated: false, slaBreached: true });
    expect(await warnings(cs.id)).toBe(1);
  });

  it('skips resolved, deleted and customer-paused cases, and cases inside the response time', async () => {
    await makeCase({ status: 'Resolved' });
    await makeCase({ deletedAt: new Date() });
    await makeCase({ status: 'Pending Customer' });
    await makeCase({ createdAt: new Date(Date.now() - 30 * 60 * 1000) });

    const result = await handlers.enforceSla();

    expect(result).toMatchObject({ escalated: 0, warned: 0 });
  });
});
