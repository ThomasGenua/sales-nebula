/**
 * Appointments (/api/scheduler): booking and changing them are held to the
 * same checks.
 *
 * Booking refused a bad date, an end before the start and a clash with the
 * host's other appointments. Changing an appointment checked none of them, so
 * moving a meeting could double-book its host, and a bad date was a 500. Nor
 * was a change audited, though booking and cancelling were.
 */
const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestUser, authHeader } = require('./setup');

let app, prisma, user, token;

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  ({ user, token } = await createTestUser({ email: 'host@test.com' }));
});

const api = (method, path, body) => request(app)[method](path).set(authHeader(token)).send(body);
const at = hours => new Date(Date.UTC(2031, 0, 6, hours)).toISOString();

async function book(subject, from, to) {
  const res = await api('post', '/api/scheduler', { subject, startTime: at(from), endTime: at(to) });
  expect(res.status).toBe(201);
  return res.body;
}

describe('changing an appointment', () => {
  test('a move onto the host\'s other appointment is refused as booking it is', async () => {
    await book('Standup', 9, 10);
    const later = await book('Review', 11, 12);
    expect((await api('post', '/api/scheduler', { subject: 'Clash', startTime: at(9), endTime: at(10) })).status).toBe(409);

    const res = await api('put', `/api/scheduler/${later.id}`, { startTime: at(9), endTime: at(10) });
    expect(res.status).toBe(409);
    expect(res.body.conflicts.map(c => c.subject)).toEqual(['Standup']);
    const kept = await prisma.appointment.findUnique({ where: { id: later.id } });
    expect(kept.startTime.toISOString()).toBe(at(11));
  });

  test('moving only one end is checked against the other', async () => {
    await book('Standup', 9, 10);
    const later = await book('Review', 11, 12);
    expect((await api('put', `/api/scheduler/${later.id}`, { startTime: at(9) })).status).toBe(409);
    expect((await api('put', `/api/scheduler/${later.id}`, { endTime: at(10) })).status).toBe(400);
  });

  test('an appointment does not clash with itself', async () => {
    const apt = await book('Review', 11, 12);
    const res = await api('put', `/api/scheduler/${apt.id}`, { startTime: at(11), endTime: at(13) });
    expect(res.status).toBe(200);
    expect(new Date(res.body.endTime).toISOString()).toBe(at(13));
  });

  test('an unreadable date or an end before the start is a 400, not a 500', async () => {
    const apt = await book('Review', 11, 12);
    expect((await api('put', `/api/scheduler/${apt.id}`, { startTime: 'next Tuesday' })).status).toBe(400);
    expect((await api('put', `/api/scheduler/${apt.id}`, { startTime: at(12), endTime: at(11) })).status).toBe(400);
  });

  test('bringing back a cancelled appointment checks for a clash', async () => {
    const first = await book('Standup', 9, 10);
    expect((await api('post', `/api/scheduler/${first.id}/cancel`, {})).status).toBe(200);
    await book('Replacement', 9, 10);
    expect((await api('put', `/api/scheduler/${first.id}`, { status: 'Scheduled' })).status).toBe(409);
  });

  test('a change that touches no time needs no check, and is audited', async () => {
    const apt = await book('Review', 11, 12);
    const res = await api('put', `/api/scheduler/${apt.id}`, { location: 'Room 2' });
    expect(res.status).toBe(200);
    expect(res.body.location).toBe('Room 2');
    const entries = await prisma.auditLog.findMany({ where: { module: 'scheduler', recordId: apt.id, action: 'update' } });
    expect(entries).toHaveLength(1);
    expect(entries[0].userId).toBe(user.id);
  });
});
