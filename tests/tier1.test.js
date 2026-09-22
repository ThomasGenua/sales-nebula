/**
 * Tier 1 feature tests: calendar recurrence, project scheduling,
 * and security group access resolution.
 *
 * The pure engines are tested directly. Route behaviour is tested
 * against the Express app with a seeded token from tests/setup.js.
 */

const {
  parseRRule, expandRecurrence, describeRRule,
  buildICalendar, parseICalendar, findFreeSlots, mergeIntervals,
} = require('../src/utils/recurrence');

const {
  calculateCriticalPath, wouldCreateCycle, assignWbsCodes,
  rollUpProgress, buildGanttRows, topoSort,
} = require('../src/utils/scheduling');

const d = (y, m, day, h = 0, min = 0) => new Date(y, m - 1, day, h, min);
const iso = x => new Date(x).toISOString().slice(0, 10);

describe('Recurrence engine (RFC 5545)', () => {
  test('parses a full RRULE into normalized parts', () => {
    const r = parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10;WKST=SU');
    expect(r.freq).toBe('WEEKLY');
    expect(r.interval).toBe(2);
    expect(r.count).toBe(10);
    expect(r.byDay).toEqual([{ ordinal: 0, day: 1 }, { ordinal: 0, day: 3 }]);
    expect(r.wkst).toBe(0);
  });

  test('tolerates an RRULE: prefix and rejects a bad FREQ', () => {
    expect(parseRRule('RRULE:FREQ=DAILY').freq).toBe('DAILY');
    expect(parseRRule('FREQ=HOURLY')).toBeNull();
    expect(parseRRule('')).toBeNull();
    expect(parseRRule(null)).toBeNull();
  });

  test('parses ordinal BYDAY tokens', () => {
    expect(parseRRule('FREQ=MONTHLY;BYDAY=2FR').byDay).toEqual([{ ordinal: 2, day: 5 }]);
    expect(parseRRule('FREQ=MONTHLY;BYDAY=-1MO').byDay).toEqual([{ ordinal: -1, day: 1 }]);
  });

  test('expands a daily rule honouring COUNT', () => {
    const out = expandRecurrence(d(2026, 8, 10, 9), 'FREQ=DAILY;COUNT=5', d(2026, 8, 1), d(2026, 9, 30));
    expect(out.map(iso)).toEqual(['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']);
  });

  test('expands a weekly rule across multiple BYDAY values', () => {
    const out = expandRecurrence(d(2026, 8, 10, 9), 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6', d(2026, 8, 1), d(2026, 9, 30));
    expect(out.map(iso)).toEqual(['2026-08-10', '2026-08-12', '2026-08-17', '2026-08-19', '2026-08-24', '2026-08-26']);
  });

  test('honours INTERVAL on weekly rules', () => {
    const out = expandRecurrence(d(2026, 8, 14, 9), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;COUNT=4', d(2026, 8, 1), d(2026, 10, 30));
    expect(out.map(iso)).toEqual(['2026-08-14', '2026-08-28', '2026-09-11', '2026-09-25']);
  });

  test('resolves nth and last weekday of the month', () => {
    const second = expandRecurrence(d(2026, 8, 11, 9), 'FREQ=MONTHLY;BYDAY=2TU;COUNT=3', d(2026, 8, 1), d(2026, 12, 30));
    expect(second.map(iso)).toEqual(['2026-08-11', '2026-09-08', '2026-10-13']);

    const last = expandRecurrence(d(2026, 8, 28, 9), 'FREQ=MONTHLY;BYDAY=-1FR;COUNT=3', d(2026, 8, 1), d(2026, 12, 30));
    expect(last.map(iso)).toEqual(['2026-08-28', '2026-09-25', '2026-10-30']);
  });

  test('stops at UNTIL', () => {
    const out = expandRecurrence(d(2026, 8, 10, 9), 'FREQ=DAILY;UNTIL=20260813T235959Z', d(2026, 8, 1), d(2026, 9, 30));
    expect(out.map(iso)).toEqual(['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13']);
  });

  test('clips to the requested window without losing the COUNT budget', () => {
    const clipped = expandRecurrence(d(2026, 8, 1, 9), 'FREQ=DAILY;COUNT=100', d(2026, 8, 10), d(2026, 8, 12, 23, 59));
    expect(clipped.map(iso)).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);

    // COUNT is consumed before the window opens, so nothing shows
    const exhausted = expandRecurrence(d(2026, 8, 1, 9), 'FREQ=DAILY;COUNT=5', d(2026, 8, 10), d(2026, 8, 31, 23, 59));
    expect(exhausted).toHaveLength(0);
  });

  test('removes excluded dates', () => {
    const out = expandRecurrence(d(2026, 8, 10, 9), 'FREQ=DAILY;COUNT=4', d(2026, 8, 1), d(2026, 9, 1), { exdates: [d(2026, 8, 11, 9)] });
    expect(out.map(iso)).toEqual(['2026-08-10', '2026-08-12', '2026-08-13']);
  });

  test('preserves the time of day across occurrences', () => {
    const out = expandRecurrence(d(2026, 8, 10, 14, 30), 'FREQ=DAILY;COUNT=3', d(2026, 8, 1), d(2026, 9, 1));
    out.forEach(o => {
      expect(o.getHours()).toBe(14);
      expect(o.getMinutes()).toBe(30);
    });
  });

  test('falls back to a single date when there is no rule', () => {
    expect(expandRecurrence(d(2026, 8, 10), null, d(2026, 8, 1), d(2026, 9, 1))).toHaveLength(1);
  });

  test('describes a rule in plain language', () => {
    expect(describeRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10')).toBe('Every 2 weeks on Monday, Wednesday, 10 times');
    expect(describeRRule('FREQ=MONTHLY;BYDAY=-1FR')).toBe('Every month on the last Friday');
    expect(describeRRule(null)).toBe('Does not repeat');
  });
});

describe('iCalendar serialization', () => {
  const sample = [{
    id: 'evt-1', externalUid: 'uid-1', title: 'Quarterly Review',
    description: 'Line one\nLine two', location: 'Room A; Floor 2',
    startAt: d(2026, 8, 12, 14), endAt: d(2026, 8, 12, 15),
    status: 'Held', updatedAt: d(2026, 8, 1),
    invitees: [
      { email: 'organizer@example.com', name: 'Organizer', isOrganizer: true },
      { email: 'guest@example.com', name: 'Guest', responseStatus: 'Accepted', role: 'Required' },
    ],
    reminders: [{ minutesBefore: 30, method: 'Popup' }],
  }];

  test('emits a well-formed VCALENDAR', () => {
    const ics = buildICalendar(sample, { name: 'Test', domain: 'test.local' });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('SUMMARY:Quarterly Review');
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics).toContain('BEGIN:VALARM');
    expect(ics).toContain('TRIGGER:-PT30M');
    expect(ics).toContain('ORGANIZER;CN=Organizer:mailto:organizer@example.com');
    expect(ics).toContain('PARTSTAT=ACCEPTED');
    expect(ics.endsWith('\r\n')).toBe(true);
  });

  test('escapes reserved characters per the RFC', () => {
    const ics = buildICalendar(sample);
    expect(ics).toContain('LOCATION:Room A\\; Floor 2');
    expect(ics).toContain('DESCRIPTION:Line one\\nLine two');
  });

  test('folds lines longer than 75 octets', () => {
    const long = [{ id: 'x', title: 'T'.repeat(200), startAt: d(2026, 8, 12), endAt: d(2026, 8, 12, 1) }];
    const ics = buildICalendar(long);
    ics.split('\r\n').forEach(line => expect(line.length).toBeLessThanOrEqual(75));
  });

  test('round-trips through the parser', () => {
    const ics = buildICalendar(sample, { domain: 'test.local' });
    const parsed = parseICalendar(ics);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('Quarterly Review');
    expect(parsed[0].location).toBe('Room A; Floor 2');
    expect(parsed[0].description).toBe('Line one\nLine two');
    expect(parsed[0].invitees.length).toBe(2);
  });

  test('carries an RRULE through the round trip', () => {
    const recurring = [{ id: 'r1', title: 'Standup', startAt: d(2026, 8, 10, 9), endAt: d(2026, 8, 10, 9, 15), rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' }];
    const parsed = parseICalendar(buildICalendar(recurring));
    expect(parsed[0].rrule).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    expect(parsed[0].isRecurring).toBe(true);
  });

  test('ignores malformed input rather than throwing', () => {
    expect(parseICalendar('not a calendar')).toEqual([]);
    expect(parseICalendar('')).toEqual([]);
    expect(parseICalendar(null)).toEqual([]);
  });
});

describe('Free/busy and availability', () => {
  test('merges overlapping busy intervals', () => {
    const merged = mergeIntervals([
      { start: d(2026, 8, 10, 9), end: d(2026, 8, 10, 10) },
      { start: d(2026, 8, 10, 9, 30), end: d(2026, 8, 10, 11) },
      { start: d(2026, 8, 10, 14), end: d(2026, 8, 10, 15) },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].end.getHours()).toBe(11);
  });

  test('finds gaps between meetings inside working hours', () => {
    const busy = [
      { start: d(2026, 8, 10, 10), end: d(2026, 8, 10, 11) },
      { start: d(2026, 8, 10, 14), end: d(2026, 8, 10, 15, 30) },
    ];
    const hours = [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020, isWorkingDay: true }];
    const slots = findFreeSlots(busy, d(2026, 8, 10), d(2026, 8, 10, 23, 59), 60, hours);
    expect(slots).toHaveLength(3);
    expect(slots[0].start.getHours()).toBe(9);
    expect(slots[1].start.getHours()).toBe(11);
    expect(slots[2].start.getHours()).toBe(15);
  });

  test('excludes gaps shorter than the requested duration', () => {
    const busy = [
      { start: d(2026, 8, 10, 9, 30), end: d(2026, 8, 10, 10) },
      { start: d(2026, 8, 10, 10, 30), end: d(2026, 8, 10, 17) },
    ];
    const hours = [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020, isWorkingDay: true }];
    // Only two 30-minute gaps exist, so a 60-minute request finds nothing
    expect(findFreeSlots(busy, d(2026, 8, 10), d(2026, 8, 10, 23, 59), 60, hours)).toHaveLength(0);
    expect(findFreeSlots(busy, d(2026, 8, 10), d(2026, 8, 10, 23, 59), 30, hours).length).toBeGreaterThan(0);
  });

  test('skips non-working days', () => {
    const hours = [{ dayOfWeek: 0, startMinute: 540, endMinute: 1020, isWorkingDay: false }];
    // 2026-08-09 is a Sunday
    expect(findFreeSlots([], d(2026, 8, 9), d(2026, 8, 9, 23, 59), 30, hours)).toHaveLength(0);
  });

  test('returns the whole window when nothing is booked', () => {
    const hours = [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020, isWorkingDay: true }];
    const slots = findFreeSlots([], d(2026, 8, 10), d(2026, 8, 10, 23, 59), 30, hours);
    expect(slots).toHaveLength(1);
    expect(slots[0].start.getHours()).toBe(9);
    expect(slots[0].end.getHours()).toBe(17);
  });
});

describe('Critical path scheduling', () => {
  // A(3) -> B(4) -> D(2) and A(3) -> C(2) -> D(2)
  const tasks = [
    { id: 'A', name: 'A', durationDays: 3, sortOrder: 0 },
    { id: 'B', name: 'B', durationDays: 4, sortOrder: 1 },
    { id: 'C', name: 'C', durationDays: 2, sortOrder: 2 },
    { id: 'D', name: 'D', durationDays: 2, sortOrder: 3 },
  ];
  const deps = [
    { predecessorId: 'A', successorId: 'B', dependencyType: 'FS', lagDays: 0 },
    { predecessorId: 'A', successorId: 'C', dependencyType: 'FS', lagDays: 0 },
    { predecessorId: 'B', successorId: 'D', dependencyType: 'FS', lagDays: 0 },
    { predecessorId: 'C', successorId: 'D', dependencyType: 'FS', lagDays: 0 },
  ];

  test('computes duration and identifies the critical path', () => {
    const r = calculateCriticalPath(tasks, deps, d(2026, 8, 10));
    expect(r.projectDuration).toBe(9);
    expect(r.criticalPath).toEqual(['A', 'B', 'D']);
  });

  test('computes total float, with slack only on the non-critical branch', () => {
    const r = calculateCriticalPath(tasks, deps, d(2026, 8, 10));
    const f = id => r.schedule.find(s => s.taskId === id);
    expect(f('A').totalFloat).toBe(0);
    expect(f('B').totalFloat).toBe(0);
    expect(f('C').totalFloat).toBe(2);
    expect(f('D').totalFloat).toBe(0);
    expect(f('C').isCritical).toBe(false);
  });

  test('applies lag on finish-to-start links', () => {
    const r = calculateCriticalPath(
      [{ id: 'X', name: 'X', durationDays: 2 }, { id: 'Y', name: 'Y', durationDays: 3 }],
      [{ predecessorId: 'X', successorId: 'Y', dependencyType: 'FS', lagDays: 5 }],
      d(2026, 8, 10),
    );
    expect(r.projectDuration).toBe(10);
  });

  test('supports start-to-start and finish-to-finish links', () => {
    const ss = calculateCriticalPath(
      [{ id: 'X', name: 'X', durationDays: 5 }, { id: 'Y', name: 'Y', durationDays: 3 }],
      [{ predecessorId: 'X', successorId: 'Y', dependencyType: 'SS', lagDays: 0 }],
      d(2026, 8, 10),
    );
    expect(ss.projectDuration).toBe(5);

    const ff = calculateCriticalPath(
      [{ id: 'X', name: 'X', durationDays: 5 }, { id: 'Y', name: 'Y', durationDays: 2 }],
      [{ predecessorId: 'X', successorId: 'Y', dependencyType: 'FF', lagDays: 0 }],
      d(2026, 8, 10),
    );
    expect(ff.projectDuration).toBe(5);
  });

  test('degrades gracefully when the network is cyclic', () => {
    const cyclic = calculateCriticalPath(
      [{ id: 'A', name: 'A', durationDays: 1 }, { id: 'B', name: 'B', durationDays: 1 }],
      [{ predecessorId: 'A', successorId: 'B' }, { predecessorId: 'B', successorId: 'A' }],
      d(2026, 8, 10),
    );
    expect(cyclic.cycle.length).toBeGreaterThan(0);
    expect(cyclic.criticalPath).toEqual([]);
  });

  test('handles an empty task set', () => {
    const r = calculateCriticalPath([], [], d(2026, 8, 10));
    expect(r.schedule).toEqual([]);
    expect(r.projectDuration).toBe(0);
  });

  test('topologically orders independent chains', () => {
    const { order, cycle } = topoSort(tasks, deps);
    expect(cycle).toEqual([]);
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'));
  });
});

describe('Dependency cycle guard', () => {
  test('rejects a self-dependency', () => {
    expect(wouldCreateCycle([], 'A', 'A')).toBe(true);
  });

  test('rejects a link that closes a loop', () => {
    expect(wouldCreateCycle([{ predecessorId: 'A', successorId: 'B' }], 'B', 'A')).toBe(true);
  });

  test('rejects a link that closes a longer loop', () => {
    const deps = [
      { predecessorId: 'A', successorId: 'B' },
      { predecessorId: 'B', successorId: 'C' },
    ];
    expect(wouldCreateCycle(deps, 'C', 'A')).toBe(true);
  });

  test('allows a link that keeps the graph acyclic', () => {
    expect(wouldCreateCycle([{ predecessorId: 'A', successorId: 'B' }], 'B', 'C')).toBe(false);
  });
});

describe('WBS numbering and progress roll-up', () => {
  const tree = [
    { id: 'p1', name: 'Phase 1', sortOrder: 0, parentTaskId: null },
    { id: 't1', name: 'Task 1', sortOrder: 0, parentTaskId: 'p1' },
    { id: 't2', name: 'Task 2', sortOrder: 1, parentTaskId: 'p1' },
    { id: 's1', name: 'Sub 1', sortOrder: 0, parentTaskId: 't2' },
    { id: 'p2', name: 'Phase 2', sortOrder: 1, parentTaskId: null },
  ];

  test('assigns hierarchical codes', () => {
    const codes = assignWbsCodes(tree);
    expect(codes.get('p1')).toBe('1');
    expect(codes.get('t1')).toBe('1.1');
    expect(codes.get('t2')).toBe('1.2');
    expect(codes.get('s1')).toBe('1.2.1');
    expect(codes.get('p2')).toBe('2');
  });

  test('weights child progress by estimated hours', () => {
    const { taskProgress } = rollUpProgress([
      { id: 'p', name: 'Parent', parentTaskId: null },
      { id: 'a', name: 'A', parentTaskId: 'p', estimatedHours: 10, percentComplete: 100 },
      { id: 'b', name: 'B', parentTaskId: 'p', estimatedHours: 30, percentComplete: 0 },
    ]);
    expect(taskProgress.get('p')).toBe(25);
  });

  test('treats a completed task as 100 percent regardless of stored value', () => {
    const { taskProgress } = rollUpProgress([
      { id: 'x', name: 'X', parentTaskId: null, status: 'Completed', percentComplete: 40 },
    ]);
    expect(taskProgress.get('x')).toBe(100);
  });

  test('rolls a multi-level tree up to the project figure', () => {
    const { projectPercent } = rollUpProgress([
      { id: 'p', name: 'P', parentTaskId: null },
      { id: 'a', name: 'A', parentTaskId: 'p', estimatedHours: 10, percentComplete: 100 },
      { id: 'b', name: 'B', parentTaskId: 'p', estimatedHours: 10, percentComplete: 50 },
    ]);
    expect(projectPercent).toBe(75);
  });

  test('builds indented Gantt rows in hierarchy order', () => {
    const rows = buildGanttRows(tree, [], assignWbsCodes(tree));
    expect(rows[0].id).toBe('p1');
    expect(rows[0].level).toBe(0);
    expect(rows[0].hasChildren).toBe(true);
    expect(rows.find(r => r.id === 's1').level).toBe(2);
    expect(rows[rows.length - 1].id).toBe('p2');
  });
});

// The route tests below were gated on `app` being truthy at module-evaluation
// time, but `app` is only assigned once setup() has run, and ./setup exports
// setup/teardown rather than an app and a token. So the guard was always false
// and every block here was skipped — they had never once run. They use the same
// lifecycle as every other suite now.
const request = require('supertest');
const { setup, teardown, cleanDatabase, createTestRole, createTestUser } = require('./setup');

let app, prisma, token;

beforeAll(async () => {
  ({ prisma, app } = await setup());
  await cleanDatabase();
  const role = await createTestRole('Admin');
  // A seeded installation has a Sales Rep role, and the signup and invite
  // endpoints correctly refuse to guess one when it is absent.
  await createTestRole('Sales Rep');
  const auth = await createTestUser({ email: `api-${Date.now()}@test.com`, roleId: role.id });
  token = auth.token;
});

afterAll(async () => { await teardown(); });

const describeApi = describe;

describeApi('Calendar API', () => {
  let eventId;

  test('rejects an event with no title', async () => {
    const res = await request(app).post('/api/calendar/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ startAt: d(2026, 9, 1, 10), endAt: d(2026, 9, 1, 11) });
    expect(res.status).toBe(400);
  });

  test('rejects an event that ends before it starts', async () => {
    const res = await request(app).post('/api/calendar/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Backwards', startAt: d(2026, 9, 1, 11), endAt: d(2026, 9, 1, 10) });
    expect(res.status).toBe(400);
  });

  test('rejects an invalid RRULE', async () => {
    const res = await request(app).post('/api/calendar/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Bad rule', startAt: d(2026, 9, 1, 10), endAt: d(2026, 9, 1, 11), rrule: 'FREQ=FORTNIGHTLY' });
    expect(res.status).toBe(400);
  });

  test('creates an event and adds the creator as organizer', async () => {
    const res = await request(app).post('/api/calendar/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Kickoff', startAt: d(2026, 9, 1, 10), endAt: d(2026, 9, 1, 11), eventType: 'Meeting' });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Kickoff');
    expect(res.body.invitees.some(i => i.isOrganizer)).toBe(true);
    eventId = res.body.id;
  });

  test('creates a recurring series and expands it in a range query', async () => {
    const created = await request(app).post('/api/calendar/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Standup', startAt: d(2026, 9, 7, 9), endAt: d(2026, 9, 7, 9, 15), rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4' });
    expect(created.status).toBe(201);

    const listed = await request(app)
      .get('/api/calendar/events?start=2026-09-01&end=2026-09-30')
      .set('Authorization', `Bearer ${token}`);
    expect(listed.status).toBe(200);
    const standups = listed.body.events.filter(e => e.title === 'Standup');
    expect(standups.length).toBe(4);
    expect(standups[0].isOccurrence).toBe(true);
  });

  test('returns events bucketed by date for a month view', async () => {
    const res = await request(app)
      .get('/api/calendar/view/month?date=2026-09-15')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('month');
    expect(typeof res.body.byDate).toBe('object');
  });

  test('exports a single event as iCalendar', async () => {
    const res = await request(app)
      .get(`/api/calendar/events/${eventId}/export.ics`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(res.text).toContain('BEGIN:VCALENDAR');
  });

  test('suggests availability slots for a duration', async () => {
    const res = await request(app).post('/api/calendar/availability')
      .set('Authorization', `Bearer ${token}`)
      .send({ durationMinutes: 30, start: d(2026, 9, 14), end: d(2026, 9, 18) });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.suggestions)).toBe(true);
  });

  test('rejects a non-positive meeting duration', async () => {
    const res = await request(app).post('/api/calendar/availability')
      .set('Authorization', `Bearer ${token}`)
      .send({ durationMinutes: 0 });
    expect(res.status).toBe(400);
  });

  test('rejects an unknown invitation response', async () => {
    const res = await request(app).post(`/api/calendar/events/${eventId}/respond`)
      .set('Authorization', `Bearer ${token}`)
      .send({ response: 'Maybe' });
    expect(res.status).toBe(400);
  });

  test('records an accepted invitation', async () => {
    const res = await request(app).post(`/api/calendar/events/${eventId}/respond`)
      .set('Authorization', `Bearer ${token}`)
      .send({ response: 'Accepted' });
    expect(res.status).toBe(200);
    expect(res.body.responseStatus).toBe('Accepted');
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/api/calendar/events');
    expect(res.status).toBe(401);
  });
});

describeApi('Projects API', () => {
  let projectId, taskA, taskB;

  test('rejects a project with no name', async () => {
    const res = await request(app).post('/api/projects')
      .set('Authorization', `Bearer ${token}`).send({ description: 'no name' });
    expect(res.status).toBe(400);
  });

  test('rejects an end date before the start date', async () => {
    const res = await request(app).post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Backwards', startDate: d(2026, 10, 10), endDate: d(2026, 10, 1) });
    expect(res.status).toBe(400);
  });

  test('creates a project with the creator as manager', async () => {
    const res = await request(app).post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Website Rebuild', startDate: d(2026, 10, 1), endDate: d(2026, 12, 1), budget: 50000 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Website Rebuild');
    projectId = res.body.id;
  });

  test('adds tasks to the project', async () => {
    const a = await request(app).post(`/api/projects/${projectId}/tasks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Discovery', durationDays: 5, estimatedHours: 40 });
    expect(a.status).toBe(201);
    taskA = a.body.id;

    const b = await request(app).post(`/api/projects/${projectId}/tasks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Build', durationDays: 10, estimatedHours: 80 });
    expect(b.status).toBe(201);
    taskB = b.body.id;
  });

  test('links tasks with a dependency', async () => {
    const res = await request(app).post(`/api/projects/tasks/${taskB}/dependencies`)
      .set('Authorization', `Bearer ${token}`)
      .send({ predecessorId: taskA, dependencyType: 'FS', lagDays: 0 });
    expect(res.status).toBe(201);
  });

  test('refuses a dependency that would create a cycle', async () => {
    const res = await request(app).post(`/api/projects/tasks/${taskA}/dependencies`)
      .set('Authorization', `Bearer ${token}`)
      .send({ predecessorId: taskB });
    expect(res.status).toBe(409);
  });

  test('rejects an unknown dependency type', async () => {
    const res = await request(app).post(`/api/projects/tasks/${taskB}/dependencies`)
      .set('Authorization', `Bearer ${token}`)
      .send({ predecessorId: taskA, dependencyType: 'XX' });
    expect(res.status).toBe(400);
  });

  test('returns Gantt rows with the critical path marked', async () => {
    const res = await request(app).get(`/api/projects/${projectId}/gantt`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThanOrEqual(2);
    expect(res.body.criticalPath.length).toBeGreaterThan(0);
    expect(res.body.hasCycle).toBe(false);
  });

  test('logs time and rolls it into the project total', async () => {
    const res = await request(app).post(`/api/projects/${projectId}/time`)
      .set('Authorization', `Bearer ${token}`)
      .send({ taskId: taskA, hours: 8, description: 'Workshop' });
    expect(res.status).toBe(201);

    const project = await request(app).get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(project.body.actualHours).toBeGreaterThanOrEqual(8);
  });

  test('rejects an implausible time entry', async () => {
    const zero = await request(app).post(`/api/projects/${projectId}/time`)
      .set('Authorization', `Bearer ${token}`).send({ hours: 0 });
    expect(zero.status).toBe(400);

    const tooMany = await request(app).post(`/api/projects/${projectId}/time`)
      .set('Authorization', `Bearer ${token}`).send({ hours: 30 });
    expect(tooMany.status).toBe(400);
  });

  test('refuses to make a task its own descendant', async () => {
    const res = await request(app).put(`/api/projects/tasks/${taskA}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parentTaskId: taskA });
    expect(res.status).toBe(400);
  });

  test('reports portfolio health', async () => {
    const res = await request(app).get('/api/projects/analytics/portfolio')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalProjects');
    expect(res.body).toHaveProperty('byHealth');
  });
});

describeApi('Security groups API', () => {
  let groupId, childId;

  test('rejects a group with no name', async () => {
    const res = await request(app).post('/api/security-groups')
      .set('Authorization', `Bearer ${token}`).send({ description: 'nameless' });
    expect(res.status).toBe(400);
  });

  test('creates a group', async () => {
    const res = await request(app).post('/api/security-groups')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `EMEA Sales ${Date.now()}`, description: 'Regional team' });
    expect(res.status).toBe(201);
    groupId = res.body.id;
  });

  test('refuses a duplicate group name', async () => {
    const name = `Duplicate ${Date.now()}`;
    await request(app).post('/api/security-groups').set('Authorization', `Bearer ${token}`).send({ name });
    const res = await request(app).post('/api/security-groups').set('Authorization', `Bearer ${token}`).send({ name });
    expect(res.status).toBe(409);
  });

  test('creates a child group and returns the hierarchy', async () => {
    const child = await request(app).post('/api/security-groups')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `EMEA North ${Date.now()}`, parentGroupId: groupId });
    expect(child.status).toBe(201);
    childId = child.body.id;

    const tree = await request(app).get('/api/security-groups/tree/all')
      .set('Authorization', `Bearer ${token}`);
    expect(tree.status).toBe(200);
    expect(Array.isArray(tree.body)).toBe(true);
  });

  test('refuses to make a group its own parent', async () => {
    const res = await request(app).put(`/api/security-groups/${groupId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parentGroupId: groupId });
    expect(res.status).toBe(400);
  });

  test('refuses a circular hierarchy', async () => {
    const res = await request(app).put(`/api/security-groups/${groupId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parentGroupId: childId });
    expect(res.status).toBe(400);
  });

  test('rejects an unsupported module on record assignment', async () => {
    const res = await request(app).post(`/api/security-groups/${groupId}/records`)
      .set('Authorization', `Bearer ${token}`)
      .send({ module: 'nonexistent', recordIds: ['x'] });
    expect(res.status).toBe(400);
  });

  test('rejects an invalid access level', async () => {
    const res = await request(app).post(`/api/security-groups/${groupId}/records`)
      .set('Authorization', `Bearer ${token}`)
      .send({ module: 'contacts', recordIds: ['x'], accessLevel: 'Superuser' });
    expect(res.status).toBe(400);
  });

  test('explains access for a record', async () => {
    const res = await request(app).get(`/api/security-groups/explain/contacts/some-record-id`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('hasAccess');
    expect(Array.isArray(res.body.reasons)).toBe(true);
  });

  test('rejects an auto-assign rule with a bad operator', async () => {
    const res = await request(app).post('/api/security-groups/rules')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad rule', module: 'deals', securityGroupId: groupId, conditions: [{ field: 'value', operator: 'roughly', value: 5 }] });
    expect(res.status).toBe(400);
  });

  test('creates a valid auto-assign rule', async () => {
    const res = await request(app).post('/api/security-groups/rules')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Big deals', module: 'deals', securityGroupId: groupId, conditions: [{ field: 'value', operator: 'greaterThan', value: 100000 }] });
    expect(res.status).toBe(201);
  });

  test('reports coverage across modules', async () => {
    const res = await request(app).get('/api/security-groups/analytics/coverage')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.coverage)).toBe(true);
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/api/security-groups');
    expect(res.status).toBe(401);
  });
});
