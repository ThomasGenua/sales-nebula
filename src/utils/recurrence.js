/**
 * RFC 5545 recurrence engine and iCalendar serializer.
 * Implemented from the RFC spec, no third-party dependency.
 *
 * Supported RRULE parts:
 *   FREQ (DAILY|WEEKLY|MONTHLY|YEARLY), INTERVAL, COUNT, UNTIL,
 *   BYDAY (with ordinal prefixes, e.g. 2FR, -1MO), BYMONTHDAY,
 *   BYMONTH, BYSETPOS, WKST
 */

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_OCCURRENCES = 1000;

/** Parse an RRULE string into a normalized object. */
function parseRRule(rrule) {
  if (!rrule || typeof rrule !== 'string') return null;
  const cleaned = rrule.replace(/^RRULE:/i, '').trim();
  const parts = {};
  for (const chunk of cleaned.split(';')) {
    const [rawKey, rawVal] = chunk.split('=');
    if (!rawKey || rawVal === undefined) continue;
    parts[rawKey.trim().toUpperCase()] = rawVal.trim();
  }

  const freq = (parts.FREQ || '').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;

  const rule = {
    freq,
    interval: parts.INTERVAL ? Math.max(1, parseInt(parts.INTERVAL, 10)) : 1,
    count: parts.COUNT ? parseInt(parts.COUNT, 10) : null,
    until: parts.UNTIL ? parseICalDate(parts.UNTIL) : null,
    byDay: parts.BYDAY ? parts.BYDAY.split(',').map(parseByDayToken).filter(Boolean) : [],
    byMonthDay: parts.BYMONTHDAY ? parts.BYMONTHDAY.split(',').map(n => parseInt(n, 10)).filter(n => !isNaN(n)) : [],
    byMonth: parts.BYMONTH ? parts.BYMONTH.split(',').map(n => parseInt(n, 10)).filter(n => !isNaN(n)) : [],
    bySetPos: parts.BYSETPOS ? parts.BYSETPOS.split(',').map(n => parseInt(n, 10)).filter(n => !isNaN(n)) : [],
    wkst: parts.WKST ? DAY_CODES.indexOf(parts.WKST.toUpperCase()) : 1,
  };
  if (rule.wkst < 0) rule.wkst = 1;
  return rule;
}

/** "2FR" -> {ordinal: 2, day: 5}; "MO" -> {ordinal: 0, day: 1} */
function parseByDayToken(token) {
  const m = String(token).trim().toUpperCase().match(/^([+-]?\d+)?([A-Z]{2})$/);
  if (!m) return null;
  const day = DAY_CODES.indexOf(m[2]);
  if (day < 0) return null;
  return { ordinal: m[1] ? parseInt(m[1], 10) : 0, day };
}

/** Parse an iCal date/date-time value (20260812T140000Z or 20260812). */
function parseICalDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) { const d = new Date(s); return isNaN(d) ? null : d; }
  const [, y, mo, d, h, mi, sec, z] = m;
  if (h === undefined) return new Date(Date.UTC(+y, +mo - 1, +d));
  return z
    ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec))
    : new Date(+y, +mo - 1, +d, +h, +mi, +sec);
}

/** Serialize a Date to an iCal UTC date-time. */
function toICalDate(date, allDay = false) {
  const d = new Date(date);
  const p = n => String(n).padStart(2, '0');
  if (allDay) return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * Expand a recurrence rule into concrete start dates.
 * Returns dates within [rangeStart, rangeEnd], honouring COUNT/UNTIL.
 */
function expandRecurrence(dtstart, rrule, rangeStart, rangeEnd, opts = {}) {
  const rule = typeof rrule === 'string' ? parseRRule(rrule) : rrule;
  if (!rule) return [new Date(dtstart)];

  const start = new Date(dtstart);
  const winStart = rangeStart ? new Date(rangeStart) : start;
  const hardEnd = rule.until ? new Date(rule.until) : null;
  let winEnd = rangeEnd ? new Date(rangeEnd) : new Date(start.getTime() + 365 * 86400000);
  if (hardEnd && hardEnd < winEnd) winEnd = hardEnd;

  const limit = Math.min(rule.count || MAX_OCCURRENCES, opts.max || MAX_OCCURRENCES);
  const excluded = new Set((opts.exdates || []).map(d => new Date(d).getTime()));
  const results = [];
  let emitted = 0;
  let cursor = new Date(start);
  let guard = 0;

  while (guard++ < MAX_OCCURRENCES * 4) {
    if (emitted >= limit) break;
    if (cursor > winEnd && !(rule.count && emitted < rule.count)) break;
    if (cursor > new Date(winEnd.getTime() + 366 * 86400000)) break;

    const candidates = candidatesForPeriod(cursor, rule, start);

    for (const c of candidates) {
      if (c < start) continue;
      if (hardEnd && c > hardEnd) { emitted = limit; break; }
      if (emitted >= limit) break;
      emitted++;
      if (excluded.has(c.getTime())) continue;
      if (c >= winStart && c <= winEnd) results.push(new Date(c));
    }

    cursor = advancePeriod(cursor, rule);
  }

  results.sort((a, b) => a - b);
  return results;
}

/** All candidate dates inside the current period of the rule. */
function candidatesForPeriod(periodStart, rule, dtstart) {
  const hh = dtstart.getHours(), mm = dtstart.getMinutes(), ss = dtstart.getSeconds();
  const at = (y, m, d) => new Date(y, m, d, hh, mm, ss, 0);
  let out = [];

  if (rule.freq === 'DAILY') {
    out = [new Date(periodStart)];
  } else if (rule.freq === 'WEEKLY') {
    const weekStart = startOfWeek(periodStart, rule.wkst);
    const days = rule.byDay.length ? rule.byDay.map(b => b.day) : [dtstart.getDay()];
    out = days.map(dow => {
      const offset = (dow - rule.wkst + 7) % 7;
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + offset);
      return at(d.getFullYear(), d.getMonth(), d.getDate());
    });
  } else if (rule.freq === 'MONTHLY') {
    const y = periodStart.getFullYear(), m = periodStart.getMonth();
    if (rule.byMonthDay.length) {
      const dim = new Date(y, m + 1, 0).getDate();
      out = rule.byMonthDay
        .map(md => (md > 0 ? md : dim + md + 1))
        .filter(md => md >= 1 && md <= dim)
        .map(md => at(y, m, md));
    } else if (rule.byDay.length) {
      out = rule.byDay.flatMap(b => nthWeekdaysOfMonth(y, m, b.day, b.ordinal).map(d => at(y, m, d)));
    } else {
      const dim = new Date(y, m + 1, 0).getDate();
      const md = Math.min(dtstart.getDate(), dim);
      out = [at(y, m, md)];
    }
  } else if (rule.freq === 'YEARLY') {
    const y = periodStart.getFullYear();
    const months = rule.byMonth.length ? rule.byMonth.map(n => n - 1) : [dtstart.getMonth()];
    for (const m of months) {
      if (rule.byDay.length) {
        out.push(...rule.byDay.flatMap(b => nthWeekdaysOfMonth(y, m, b.day, b.ordinal).map(d => at(y, m, d))));
      } else if (rule.byMonthDay.length) {
        const dim = new Date(y, m + 1, 0).getDate();
        out.push(...rule.byMonthDay
          .map(md => (md > 0 ? md : dim + md + 1))
          .filter(md => md >= 1 && md <= dim)
          .map(md => at(y, m, md)));
      } else {
        out.push(at(y, m, dtstart.getDate()));
      }
    }
  }

  if (rule.byMonth.length && rule.freq !== 'YEARLY') {
    out = out.filter(d => rule.byMonth.includes(d.getMonth() + 1));
  }
  out.sort((a, b) => a - b);

  if (rule.bySetPos.length) {
    const picked = [];
    for (const pos of rule.bySetPos) {
      const idx = pos > 0 ? pos - 1 : out.length + pos;
      if (idx >= 0 && idx < out.length) picked.push(out[idx]);
    }
    picked.sort((a, b) => a - b);
    return picked;
  }
  return out;
}

function nthWeekdaysOfMonth(year, month, weekday, ordinal) {
  const dim = new Date(year, month + 1, 0).getDate();
  const all = [];
  for (let d = 1; d <= dim; d++) {
    if (new Date(year, month, d).getDay() === weekday) all.push(d);
  }
  if (!ordinal) return all;
  const idx = ordinal > 0 ? ordinal - 1 : all.length + ordinal;
  return idx >= 0 && idx < all.length ? [all[idx]] : [];
}

function startOfWeek(date, wkst = 1) {
  const d = new Date(date);
  const diff = (d.getDay() - wkst + 7) % 7;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function advancePeriod(cursor, rule) {
  const d = new Date(cursor);
  if (rule.freq === 'DAILY') d.setDate(d.getDate() + rule.interval);
  else if (rule.freq === 'WEEKLY') d.setDate(d.getDate() + 7 * rule.interval);
  else if (rule.freq === 'MONTHLY') d.setMonth(d.getMonth() + rule.interval, 1);
  else if (rule.freq === 'YEARLY') d.setFullYear(d.getFullYear() + rule.interval, 0, 1);
  return d;
}

/** Human-readable summary of an RRULE, for UI display. */
function describeRRule(rrule) {
  const r = typeof rrule === 'string' ? parseRRule(rrule) : rrule;
  if (!r) return 'Does not repeat';
  const names = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };
  const unit = names[r.freq];
  let s = r.interval === 1 ? `Every ${unit}` : `Every ${r.interval} ${unit}s`;
  if (r.byDay.length) {
    const full = { SU: 'Sunday', MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday' };
    s += ` on ${r.byDay.map(b => (b.ordinal ? `the ${ordinalWord(b.ordinal)} ` : '') + full[DAY_CODES[b.day]]).join(', ')}`;
  }
  if (r.byMonthDay.length) s += ` on day ${r.byMonthDay.join(', ')}`;
  if (r.count) s += `, ${r.count} times`;
  if (r.until) s += `, until ${new Date(r.until).toLocaleDateString()}`;
  return s;
}

function ordinalWord(n) {
  const map = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', '-1': 'last', '-2': 'second to last' };
  return map[String(n)] || `${n}th`;
}

/** Escape a text value per RFC 5545 section 3.3.11. */
function escapeICalText(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Fold long lines at 75 octets per RFC 5545 section 3.1. */
function foldLine(line) {
  if (line.length <= 75) return line;
  const out = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) { out.push(' ' + rest.slice(0, 74)); rest = rest.slice(74); }
  if (rest.length) out.push(' ' + rest);
  return out.join('\r\n');
}

/** Build a VCALENDAR document from event records. */
function buildICalendar(events, opts = {}) {
  const name = opts.name || 'Sales Nebula Calendar';
  const domain = opts.domain || 'salesnebula.local';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sales Nebula//CRM Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeICalText(name)}`,
    `X-WR-TIMEZONE:${opts.timezone || 'UTC'}`,
  ];

  for (const ev of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${ev.externalUid || ev.id}@${domain}`);
    lines.push(`DTSTAMP:${toICalDate(ev.updatedAt || ev.createdAt || new Date())}`);
    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${toICalDate(ev.startAt, true)}`);
      lines.push(`DTEND;VALUE=DATE:${toICalDate(ev.endAt, true)}`);
    } else {
      lines.push(`DTSTART:${toICalDate(ev.startAt)}`);
      lines.push(`DTEND:${toICalDate(ev.endAt)}`);
    }
    lines.push(`SUMMARY:${escapeICalText(ev.title)}`);
    if (ev.description) lines.push(`DESCRIPTION:${escapeICalText(ev.description)}`);
    if (ev.location) lines.push(`LOCATION:${escapeICalText(ev.location)}`);
    if (ev.meetingUrl) lines.push(`URL:${escapeICalText(ev.meetingUrl)}`);
    if (ev.rrule) lines.push(`RRULE:${ev.rrule.replace(/^RRULE:/i, '')}`);
    if (ev.isCancelled) lines.push('STATUS:CANCELLED');
    else if (ev.status === 'Held') lines.push('STATUS:CONFIRMED');
    else lines.push('STATUS:TENTATIVE');
    if (ev.visibility === 'Private' || ev.visibility === 'Confidential') lines.push('CLASS:PRIVATE');
    for (const inv of ev.invitees || []) {
      const partstat = { NeedsAction: 'NEEDS-ACTION', Accepted: 'ACCEPTED', Declined: 'DECLINED', Tentative: 'TENTATIVE', Delegated: 'DELEGATED' }[inv.responseStatus] || 'NEEDS-ACTION';
      const addr = inv.email || `${inv.userId || inv.contactId || 'unknown'}@${domain}`;
      if (inv.isOrganizer) {
        lines.push(`ORGANIZER;CN=${escapeICalText(inv.name || addr)}:mailto:${addr}`);
      } else {
        lines.push(`ATTENDEE;CN=${escapeICalText(inv.name || addr)};ROLE=${inv.role === 'Optional' ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT'};PARTSTAT=${partstat}:mailto:${addr}`);
      }
    }
    for (const rem of ev.reminders || []) {
      lines.push('BEGIN:VALARM');
      lines.push(`TRIGGER:-PT${rem.minutesBefore || 15}M`);
      lines.push(rem.method === 'Email' ? 'ACTION:EMAIL' : 'ACTION:DISPLAY');
      lines.push(`DESCRIPTION:${escapeICalText(rem.message || ev.title)}`);
      lines.push('END:VALARM');
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** Parse a VCALENDAR document into plain event objects. */
function parseICalendar(text) {
  if (!text) return [];
  const unfolded = String(text).replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let current = null;
  let inAlarm = false;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { current = { invitees: [], reminders: [] }; inAlarm = false; continue; }
    if (line === 'END:VEVENT') { if (current) events.push(current); current = null; continue; }
    if (!current) continue;

    // VALARM carries its own DESCRIPTION and must not overwrite the event's
    if (line === 'BEGIN:VALARM') { inAlarm = true; current.reminders.push({}); continue; }
    if (line === 'END:VALARM') { inAlarm = false; continue; }
    if (inAlarm) {
      const alarm = current.reminders[current.reminders.length - 1];
      const trigger = line.match(/^TRIGGER:-PT(\d+)([MHD])/i);
      if (trigger) {
        const n = parseInt(trigger[1], 10);
        const unit = trigger[2].toUpperCase();
        alarm.minutesBefore = unit === 'H' ? n * 60 : unit === 'D' ? n * 1440 : n;
      } else if (/^ACTION:/i.test(line)) {
        alarm.method = /EMAIL/i.test(line) ? 'Email' : 'Popup';
      }
      continue;
    }

    const sep = line.indexOf(':');
    if (sep < 0) continue;
    const rawName = line.slice(0, sep);
    const value = line.slice(sep + 1);
    const name = rawName.split(';')[0].toUpperCase();
    const unescape = v => v.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

    if (name === 'UID') current.externalUid = value;
    else if (name === 'SUMMARY') current.title = unescape(value);
    else if (name === 'DESCRIPTION') current.description = unescape(value);
    else if (name === 'LOCATION') current.location = unescape(value);
    else if (name === 'URL') current.meetingUrl = value;
    else if (name === 'DTSTART') { current.startAt = parseICalDate(value); current.allDay = rawName.includes('VALUE=DATE'); }
    else if (name === 'DTEND') current.endAt = parseICalDate(value);
    else if (name === 'RRULE') { current.rrule = value; current.isRecurring = true; }
    else if (name === 'STATUS') current.status = value === 'CANCELLED' ? 'Cancelled' : value === 'CONFIRMED' ? 'Planned' : 'Planned';
    else if (name === 'CLASS') current.visibility = value === 'PRIVATE' ? 'Private' : 'Default';
    else if (name === 'ATTENDEE') {
      const email = value.replace(/^mailto:/i, '');
      const cn = rawName.match(/CN=([^;:]+)/);
      current.invitees.push({ email, name: cn ? cn[1] : email, role: rawName.includes('OPT-PARTICIPANT') ? 'Optional' : 'Required' });
    } else if (name === 'ORGANIZER') {
      const email = value.replace(/^mailto:/i, '');
      const cn = rawName.match(/CN=([^;:]+)/);
      current.invitees.push({ email, name: cn ? cn[1] : email, isOrganizer: true, role: 'Chair' });
    }
  }

  return events.filter(e => e.title && e.startAt);
}

/** True when two [start,end) intervals overlap. */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}

/**
 * Given busy intervals and working hours, return open slots of at least
 * durationMinutes inside [rangeStart, rangeEnd].
 */
function findFreeSlots(busy, rangeStart, rangeEnd, durationMinutes, workingHours = []) {
  const durMs = durationMinutes * 60000;
  const merged = mergeIntervals(busy);
  const slots = [];

  let dayCursor = new Date(rangeStart);
  dayCursor.setHours(0, 0, 0, 0);
  const finalDay = new Date(rangeEnd);

  while (dayCursor <= finalDay) {
    const dow = dayCursor.getDay();
    const wh = workingHours.find(w => w.dayOfWeek === dow);
    const isWorking = wh ? wh.isWorkingDay !== false : true;
    if (isWorking) {
      const openMin = wh ? wh.startMinute : 540;
      const closeMin = wh ? wh.endMinute : 1020;
      let winStart = new Date(dayCursor); winStart.setMinutes(openMin);
      let winEnd = new Date(dayCursor); winEnd.setMinutes(closeMin);
      if (winStart < new Date(rangeStart)) winStart = new Date(rangeStart);
      if (winEnd > new Date(rangeEnd)) winEnd = new Date(rangeEnd);

      let cursor = new Date(winStart);
      for (const b of merged) {
        const bs = new Date(b.start), be = new Date(b.end);
        if (be <= cursor) continue;
        if (bs >= winEnd) break;
        if (bs - cursor >= durMs) slots.push({ start: new Date(cursor), end: new Date(bs) });
        if (be > cursor) cursor = new Date(be);
      }
      if (winEnd - cursor >= durMs) slots.push({ start: new Date(cursor), end: new Date(winEnd) });
    }
    dayCursor.setDate(dayCursor.getDate() + 1);
  }

  return slots;
}

function mergeIntervals(intervals) {
  const sorted = (intervals || [])
    .map(i => ({ start: new Date(i.start || i.startAt), end: new Date(i.end || i.endAt) }))
    .filter(i => !isNaN(i.start) && !isNaN(i.end))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const cur of sorted) {
    const last = merged[merged.length - 1];
    if (last && cur.start <= last.end) { if (cur.end > last.end) last.end = cur.end; }
    else merged.push({ ...cur });
  }
  return merged;
}

module.exports = {
  parseRRule, expandRecurrence, describeRRule,
  buildICalendar, parseICalendar, toICalDate, parseICalDate,
  overlaps, findFreeSlots, mergeIntervals,
};
