/**
 * Business hours arithmetic for SLA tracking.
 *
 * Wall-clock elapsed time overstates SLA breach on anything raised on a
 * Friday afternoon. These helpers count only open hours, skipping
 * closed days and holidays, so a "4 business hour" target means four
 * hours the team was actually available.
 *
 * A schedule is an array of seven entries:
 *   [{ dayOfWeek: 0..6, openMinute, closeMinute, closed }]
 * Minutes are measured from local midnight. Holidays are ISO dates.
 */

const MS_PER_MINUTE = 60000;

const DEFAULT_SCHEDULE = [
  { dayOfWeek: 0, openMinute: 0, closeMinute: 0, closed: true },
  { dayOfWeek: 1, openMinute: 540, closeMinute: 1020, closed: false },
  { dayOfWeek: 2, openMinute: 540, closeMinute: 1020, closed: false },
  { dayOfWeek: 3, openMinute: 540, closeMinute: 1020, closed: false },
  { dayOfWeek: 4, openMinute: 540, closeMinute: 1020, closed: false },
  { dayOfWeek: 5, openMinute: 540, closeMinute: 1020, closed: false },
  { dayOfWeek: 6, openMinute: 0, closeMinute: 0, closed: true },
];

function isoDate(d) {
  const x = new Date(d);
  const p = n => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * Local midnight of the next day. Adding 24 hours landed back on the same
 * date across the autumn clock change (a 25-hour day), so a Friday deadline
 * came out as Sunday midnight and that Monday went uncounted.
 */
function nextDay(d) {
  const x = startOfDay(d);
  x.setDate(x.getDate() + 1);
  return x;
}

function minutesIntoDay(d) {
  const x = new Date(d);
  return x.getHours() * 60 + x.getMinutes() + x.getSeconds() / 60;
}

function normalizeSchedule(schedule) {
  if (!Array.isArray(schedule) || !schedule.length) return DEFAULT_SCHEDULE;
  const byDay = new Map();
  for (const entry of schedule) {
    if (entry.dayOfWeek === undefined && entry.day === undefined) continue;
    const dow = entry.dayOfWeek ?? entry.day;
    byDay.set(dow, {
      dayOfWeek: dow,
      openMinute: entry.openMinute ?? entry.startMinute ?? 540,
      closeMinute: entry.closeMinute ?? entry.endMinute ?? 1020,
      closed: entry.closed ?? (entry.isWorkingDay === false),
    });
  }
  return [0, 1, 2, 3, 4, 5, 6].map(d => byDay.get(d) || { dayOfWeek: d, openMinute: 0, closeMinute: 0, closed: true });
}

function normalizeHolidays(holidays) {
  const set = new Set();
  for (const h of holidays || []) {
    if (typeof h === 'string') set.add(h.slice(0, 10));
    else if (h?.date) set.add(String(h.date).slice(0, 10));
  }
  return set;
}

/** The open window for a given date, or null when closed. */
function windowForDate(date, schedule, holidays) {
  if (holidays.has(isoDate(date))) return null;
  const day = schedule[new Date(date).getDay()];
  if (!day || day.closed || day.closeMinute <= day.openMinute) return null;
  // Wall-clock minutes, so 9:00 stays 9:00 on a clock-change day.
  const open = startOfDay(date);
  open.setMinutes(day.openMinute);
  const close = startOfDay(date);
  close.setMinutes(day.closeMinute);
  return { open, close, minutes: day.closeMinute - day.openMinute };
}

/** True when a timestamp falls inside open hours. */
function isWithinBusinessHours(date, config = {}) {
  const schedule = normalizeSchedule(config.schedule);
  const holidays = normalizeHolidays(config.holidays);
  const win = windowForDate(date, schedule, holidays);
  if (!win) return false;
  const t = new Date(date);
  return t >= win.open && t < win.close;
}

/**
 * Business minutes between two timestamps.
 * Time outside the open window contributes nothing.
 */
function businessMinutesBetween(start, end, config = {}) {
  const from = new Date(start);
  const to = new Date(end);
  if (isNaN(from) || isNaN(to) || to <= from) return 0;

  const schedule = normalizeSchedule(config.schedule);
  const holidays = normalizeHolidays(config.holidays);

  let total = 0;
  let cursor = startOfDay(from);
  const limit = startOfDay(to);
  let guard = 0;

  while (cursor <= limit && guard++ < 3650) {
    const win = windowForDate(cursor, schedule, holidays);
    if (win) {
      const segStart = from > win.open ? from : win.open;
      const segEnd = to < win.close ? to : win.close;
      if (segEnd > segStart) total += (segEnd - segStart) / MS_PER_MINUTE;
    }
    cursor = nextDay(cursor);
  }

  return +total.toFixed(2);
}

function businessHoursBetween(start, end, config = {}) {
  return +(businessMinutesBetween(start, end, config) / 60).toFixed(2);
}

/**
 * Add business minutes to a timestamp, returning the resulting
 * wall-clock deadline. A ticket raised at 4pm Friday with a 4 hour
 * target lands Monday morning, not Friday evening.
 */
function addBusinessMinutes(start, minutesToAdd, config = {}) {
  const schedule = normalizeSchedule(config.schedule);
  const holidays = normalizeHolidays(config.holidays);
  let remaining = Number(minutesToAdd) || 0;
  if (remaining <= 0) return new Date(start);

  let cursor = new Date(start);
  let guard = 0;

  while (remaining > 0 && guard++ < 3650) {
    const win = windowForDate(cursor, schedule, holidays);
    if (!win) {
      cursor = nextDay(cursor);
      continue;
    }
    // Before opening: jump to the open bell
    if (cursor < win.open) cursor = new Date(win.open);
    // After closing: move to the next day
    if (cursor >= win.close) {
      cursor = nextDay(cursor);
      continue;
    }
    const availableMinutes = (win.close - cursor) / MS_PER_MINUTE;
    if (availableMinutes >= remaining) return new Date(cursor.getTime() + remaining * MS_PER_MINUTE);
    remaining -= availableMinutes;
    cursor = nextDay(cursor);
  }
  return cursor;
}

function addBusinessHours(start, hours, config = {}) {
  return addBusinessMinutes(start, (Number(hours) || 0) * 60, config);
}

/** The next moment the desk is open, or the input when already open. */
function nextBusinessOpen(from, config = {}) {
  const schedule = normalizeSchedule(config.schedule);
  const holidays = normalizeHolidays(config.holidays);
  let cursor = new Date(from);
  let guard = 0;

  while (guard++ < 400) {
    const win = windowForDate(cursor, schedule, holidays);
    if (win) {
      if (cursor < win.open) return new Date(win.open);
      if (cursor < win.close) return new Date(cursor);
    }
    cursor = nextDay(cursor);
  }
  return new Date(from);
}

/** Open minutes available in a single day. */
function businessMinutesInDay(date, config = {}) {
  const schedule = normalizeSchedule(config.schedule);
  const holidays = normalizeHolidays(config.holidays);
  const win = windowForDate(date, schedule, holidays);
  return win ? win.minutes : 0;
}

/**
 * Full SLA evaluation for a record.
 *
 * Pass targetMinutes plus the open timestamp. Any paused windows
 * (waiting on customer, on hold) are subtracted from elapsed time.
 */
function calculateSla({
  startedAt, targetMinutes, config = {}, now = new Date(),
  completedAt = null, pauses = [], warnThresholdPercent = 80,
}) {
  const start = new Date(startedAt);
  if (isNaN(start) || !targetMinutes) {
    return { applicable: false, reason: 'Missing start time or SLA target' };
  }

  const endpoint = completedAt ? new Date(completedAt) : new Date(now);
  const grossMinutes = businessMinutesBetween(start, endpoint, config);

  // Subtract paused windows, counted in business minutes too
  let pausedMinutes = 0;
  for (const p of pauses || []) {
    const ps = new Date(p.start ?? p.pausedAt);
    const pe = new Date(p.end ?? p.resumedAt ?? endpoint);
    if (isNaN(ps) || isNaN(pe) || pe <= ps) continue;
    pausedMinutes += businessMinutesBetween(ps < start ? start : ps, pe > endpoint ? endpoint : pe, config);
  }

  const elapsedMinutes = Math.max(0, +(grossMinutes - pausedMinutes).toFixed(2));
  const dueAt = addBusinessMinutes(start, targetMinutes + pausedMinutes, config);
  const remainingMinutes = +(targetMinutes - elapsedMinutes).toFixed(2);
  const percentUsed = targetMinutes > 0 ? +((elapsedMinutes / targetMinutes) * 100).toFixed(1) : 0;

  const breached = elapsedMinutes > targetMinutes;
  let status;
  if (completedAt) status = breached ? 'Breached' : 'Met';
  else if (breached) status = 'Breached';
  else if (percentUsed >= warnThresholdPercent) status = 'AtRisk';
  else status = 'OnTrack';

  return {
    applicable: true,
    status, breached,
    startedAt: start, dueAt,
    completedAt: completedAt ? new Date(completedAt) : null,
    targetMinutes,
    targetHours: +(targetMinutes / 60).toFixed(2),
    elapsedMinutes,
    elapsedHours: +(elapsedMinutes / 60).toFixed(2),
    pausedMinutes: +pausedMinutes.toFixed(2),
    remainingMinutes,
    remainingHours: +(remainingMinutes / 60).toFixed(2),
    percentUsed,
    overdueByMinutes: breached ? +(elapsedMinutes - targetMinutes).toFixed(2) : 0,
    currentlyOpen: isWithinBusinessHours(now, config),
  };
}

/** Default first-response and resolution targets by priority, in minutes. */
const DEFAULT_SLA_TARGETS = {
  Critical: { firstResponse: 30, resolution: 240 },
  Urgent:   { firstResponse: 60, resolution: 480 },
  High:     { firstResponse: 120, resolution: 960 },
  Medium:   { firstResponse: 240, resolution: 1920 },
  Low:      { firstResponse: 480, resolution: 3840 },
};

function targetsForPriority(priority, overrides = {}) {
  const key = priority || 'Medium';
  return { ...(DEFAULT_SLA_TARGETS[key] || DEFAULT_SLA_TARGETS.Medium), ...(overrides[key] || {}) };
}

/** Format a minute count as "2d 3h 15m". */
function formatDuration(minutes) {
  const m = Math.abs(Math.round(Number(minutes) || 0));
  if (m < 60) return `${m}m`;
  const hours = Math.floor(m / 60);
  const mins = m % 60;
  if (hours < 24) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

/** Common statutory holidays, for seeding a new business-hours profile. */
function commonHolidays(year, country = 'CA') {
  const p = n => String(n).padStart(2, '0');
  const nth = (month, weekday, n) => {
    const days = [];
    const dim = new Date(year, month, 0).getDate();
    for (let d = 1; d <= dim; d++) if (new Date(year, month - 1, d).getDay() === weekday) days.push(d);
    const idx = n > 0 ? n - 1 : days.length + n;
    return days[idx];
  };
  const base = [
    { date: `${year}-01-01`, name: "New Year's Day" },
    { date: `${year}-12-25`, name: 'Christmas Day' },
  ];
  if (country === 'CA') {
    base.push(
      { date: `${year}-07-01`, name: 'Canada Day' },
      { date: `${year}-09-${p(nth(9, 1, 1))}`, name: 'Labour Day' },
      { date: `${year}-10-${p(nth(10, 1, 2))}`, name: 'Thanksgiving' },
      { date: `${year}-12-26`, name: 'Boxing Day' },
    );
  } else if (country === 'US') {
    base.push(
      { date: `${year}-07-04`, name: 'Independence Day' },
      { date: `${year}-09-${p(nth(9, 1, 1))}`, name: 'Labor Day' },
      { date: `${year}-11-${p(nth(11, 4, 4))}`, name: 'Thanksgiving' },
    );
  }
  return base.sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = {
  DEFAULT_SCHEDULE, DEFAULT_SLA_TARGETS,
  normalizeSchedule, normalizeHolidays, windowForDate,
  isWithinBusinessHours, businessMinutesBetween, businessHoursBetween,
  addBusinessMinutes, addBusinessHours, nextBusinessOpen, businessMinutesInDay,
  calculateSla, targetsForPriority, formatDuration, commonHolidays,
};
