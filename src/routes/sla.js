const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const {
  DEFAULT_SCHEDULE, DEFAULT_SLA_TARGETS,
  isWithinBusinessHours, businessMinutesBetween, businessHoursBetween,
  addBusinessMinutes, nextBusinessOpen, calculateSla, targetsForPriority,
  formatDuration, commonHolidays, normalizeSchedule,
} = require('../utils/businessHours');

const router = Router();

/** Load the business hours profile that applies, falling back to default. */
async function loadProfile(prisma, businessHoursId) {
  let profile = null;
  if (businessHoursId) {
    profile = await prisma.businessHours.findFirst({ where: { id: businessHoursId, deletedAt: null, active: true } });
  }
  if (!profile) {
    profile = await prisma.businessHours.findFirst({ where: { isDefault: true, deletedAt: null, active: true } });
  }
  if (!profile) return { schedule: DEFAULT_SCHEDULE, holidays: [], name: 'Default (Mon-Fri 9-5)', timezone: 'UTC' };
  return {
    id: profile.id, name: profile.name, timezone: profile.timezone,
    schedule: Array.isArray(profile.schedule) ? profile.schedule : DEFAULT_SCHEDULE,
    holidays: Array.isArray(profile.holidays) ? profile.holidays : [],
  };
}

/** Derive the paused windows for a case from its status history. */
async function pausesForCase(prisma, caseId) {
  const PAUSED_STATUSES = ['Pending Customer', 'Waiting on Customer', 'On Hold', 'Awaiting Info'];
  try {
    const history = await prisma.caseStatusHistory.findMany({ where: { caseId }, orderBy: { createdAt: 'asc' } });
    const pauses = [];
    let openPause = null;
    for (const h of history) {
      const isPaused = PAUSED_STATUSES.includes(h.toStatus || h.status);
      if (isPaused && !openPause) openPause = { start: h.createdAt };
      else if (!isPaused && openPause) { openPause.end = h.createdAt; pauses.push(openPause); openPause = null; }
    }
    if (openPause) pauses.push(openPause);
    return pauses;
  } catch {
    return []; // history table is optional
  }
}

// ── BUSINESS HOURS PROFILES ───────────────────────────────────────────

router.get('/profiles', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const profiles = await prisma.businessHours.findMany({
      where: { deletedAt: null }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    if (!profiles.length) {
      return res.json([{ id: null, name: 'Default (Mon-Fri 9-5)', isDefault: true, active: true, timezone: 'UTC', schedule: DEFAULT_SCHEDULE, holidays: [], isFallback: true }]);
    }
    res.json(profiles);
  } catch (err) { next(err); }
});

router.get('/profiles/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const profile = await prisma.businessHours.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!profile) return res.status(404).json({ error: 'Business hours profile not found' });

    const schedule = normalizeSchedule(profile.schedule);
    const weeklyMinutes = schedule.filter(d => !d.closed).reduce((s, d) => s + (d.closeMinute - d.openMinute), 0);
    res.json({
      ...profile, schedule,
      weeklyHours: +(weeklyMinutes / 60).toFixed(1),
      openDays: schedule.filter(d => !d.closed).length,
      currentlyOpen: isWithinBusinessHours(new Date(), { schedule, holidays: profile.holidays }),
      nextOpen: nextBusinessOpen(new Date(), { schedule, holidays: profile.holidays }),
    });
  } catch (err) { next(err); }
});

router.post('/profiles', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, timezone, schedule, holidays, isDefault, seedHolidays, country } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const normalized = normalizeSchedule(schedule);
    for (const day of normalized) {
      if (day.closed) continue;
      if (day.openMinute < 0 || day.closeMinute > 1440) return res.status(400).json({ error: 'Minutes must fall between 0 and 1440' });
      if (day.closeMinute <= day.openMinute) return res.status(400).json({ error: `Closing time must be after opening time on day ${day.dayOfWeek}` });
    }

    let holidayList = holidays || [];
    if (seedHolidays) {
      const year = new Date().getFullYear();
      holidayList = [...commonHolidays(year, country || 'CA'), ...commonHolidays(year + 1, country || 'CA')];
    }

    if (isDefault) await prisma.businessHours.updateMany({ where: { isDefault: true }, data: { isDefault: false } });

    const profile = await prisma.businessHours.create({
      data: { name, timezone: timezone || 'UTC', schedule: normalized, holidays: holidayList, isDefault: !!isDefault },
    });
    await req.audit({ action: 'create', module: 'sla', recordId: profile.id, details: `Business hours profile created: ${name}` });
    res.status(201).json(profile);
  } catch (err) { next(err); }
});

router.put('/profiles/:id', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { id, createdAt, ...data } = req.body;
    if (data.schedule) {
      data.schedule = normalizeSchedule(data.schedule);
      for (const day of data.schedule) {
        if (!day.closed && day.closeMinute <= day.openMinute) {
          return res.status(400).json({ error: `Closing time must be after opening time on day ${day.dayOfWeek}` });
        }
      }
    }
    if (data.isDefault) await prisma.businessHours.updateMany({ where: { isDefault: true, id: { not: req.params.id } }, data: { isDefault: false } });
    const profile = await prisma.businessHours.update({ where: { id: req.params.id }, data });
    res.json(profile);
  } catch (err) { next(err); }
});

router.delete('/profiles/:id', authenticate, requirePermission('admin', 'full'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const profile = await prisma.businessHours.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    if (profile.isDefault) return res.status(400).json({ error: 'Cannot delete the default profile. Make another profile default first.' });
    await prisma.businessHours.update({ where: { id: profile.id }, data: { deletedAt: new Date(), active: false } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ── HOLIDAYS ──────────────────────────────────────────────────────────

router.get('/profiles/:id/holidays', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const profile = await prisma.businessHours.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    const list = Array.isArray(profile.holidays) ? profile.holidays : [];
    const today = new Date().toISOString().slice(0, 10);
    res.json({
      total: list.length,
      upcoming: list.filter(h => (h.date || h) >= today).sort((a, b) => (a.date || a).localeCompare(b.date || b)).slice(0, 20),
      all: list,
    });
  } catch (err) { next(err); }
});

router.post('/profiles/:id/holidays', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { date, name, dates } = req.body;
    const profile = await prisma.businessHours.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const existing = Array.isArray(profile.holidays) ? profile.holidays : [];
    const incoming = dates?.length ? dates : (date ? [{ date, name: name || 'Holiday' }] : []);
    if (!incoming.length) return res.status(400).json({ error: 'date or dates required' });

    const seen = new Set(existing.map(h => (h.date || h).slice(0, 10)));
    const added = [];
    for (const h of incoming) {
      const iso = String(h.date || h).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return res.status(400).json({ error: `Invalid date: ${iso}. Use YYYY-MM-DD.` });
      if (seen.has(iso)) continue;
      seen.add(iso);
      added.push({ date: iso, name: h.name || 'Holiday' });
    }

    const merged = [...existing, ...added].sort((a, b) => (a.date || a).localeCompare(b.date || b));
    await prisma.businessHours.update({ where: { id: profile.id }, data: { holidays: merged } });
    res.status(201).json({ added: added.length, total: merged.length, holidays: merged });
  } catch (err) { next(err); }
});

router.delete('/profiles/:id/holidays/:date', authenticate, requirePermission('admin', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const profile = await prisma.businessHours.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    const existing = Array.isArray(profile.holidays) ? profile.holidays : [];
    const remaining = existing.filter(h => (h.date || h).slice(0, 10) !== req.params.date);
    await prisma.businessHours.update({ where: { id: profile.id }, data: { holidays: remaining } });
    res.json({ removed: existing.length - remaining.length, total: remaining.length });
  } catch (err) { next(err); }
});

router.get('/holidays/suggest/:country', authenticate, async (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  res.json({ year, country: req.params.country.toUpperCase(), holidays: commonHolidays(year, req.params.country.toUpperCase()) });
});

// ── CALCULATION HELPERS ───────────────────────────────────────────────

router.post('/calculate', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { start, end, targetMinutes, businessHoursId, pauses, completedAt } = req.body;
    if (!start) return res.status(400).json({ error: 'start required' });

    const config = await loadProfile(prisma, businessHoursId);

    if (targetMinutes) {
      const sla = calculateSla({ startedAt: start, targetMinutes: +targetMinutes, config, completedAt, pauses: pauses || [], now: end ? new Date(end) : new Date() });
      return res.json({ profile: config.name, ...sla, elapsedFormatted: formatDuration(sla.elapsedMinutes), remainingFormatted: formatDuration(sla.remainingMinutes) });
    }

    if (!end) return res.status(400).json({ error: 'Provide end, or targetMinutes for an SLA calculation' });
    const minutes = businessMinutesBetween(start, end, config);
    res.json({
      profile: config.name, start, end,
      businessMinutes: minutes,
      businessHours: +(minutes / 60).toFixed(2),
      wallClockHours: +((new Date(end) - new Date(start)) / 3600000).toFixed(2),
      formatted: formatDuration(minutes),
    });
  } catch (err) { next(err); }
});

router.post('/deadline', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { start, minutes, hours, businessHoursId } = req.body;
    const add = minutes != null ? +minutes : (hours != null ? +hours * 60 : null);
    if (add === null || isNaN(add)) return res.status(400).json({ error: 'minutes or hours required' });

    const config = await loadProfile(prisma, businessHoursId);
    const from = start ? new Date(start) : new Date();
    const dueAt = addBusinessMinutes(from, add, config);

    res.json({
      profile: config.name, start: from, addedMinutes: add,
      dueAt,
      wallClockHoursAway: +((dueAt - from) / 3600000).toFixed(2),
      currentlyOpen: isWithinBusinessHours(from, config),
      nextOpen: nextBusinessOpen(from, config),
    });
  } catch (err) { next(err); }
});

router.get('/status', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const config = await loadProfile(prisma, req.query.businessHoursId);
    const now = new Date();
    const open = isWithinBusinessHours(now, config);
    res.json({
      profile: config.name, timezone: config.timezone,
      currentlyOpen: open,
      nextOpen: open ? null : nextBusinessOpen(now, config),
      schedule: normalizeSchedule(config.schedule),
      upcomingHolidays: (config.holidays || []).filter(h => (h.date || h) >= now.toISOString().slice(0, 10)).slice(0, 5),
    });
  } catch (err) { next(err); }
});

// ── CASE SLA ──────────────────────────────────────────────────────────

router.get('/cases/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const c = await prisma.case.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!c) return res.status(404).json({ error: 'Case not found' });

    const config = await loadProfile(prisma, req.query.businessHoursId);
    const targets = targetsForPriority(c.priority);
    const pauses = await pausesForCase(prisma, c.id);
    const closed = ['Closed', 'Resolved', 'Rejected'].includes(c.status);

    const firstResponse = calculateSla({
      startedAt: c.createdAt, targetMinutes: targets.firstResponse, config,
      completedAt: c.firstRespondedAt || null, pauses,
    });
    const resolution = calculateSla({
      startedAt: c.createdAt, targetMinutes: targets.resolution, config,
      completedAt: closed ? (c.closedAt || c.updatedAt) : null, pauses,
    });

    res.json({
      caseId: c.id, caseNumber: c.caseNumber, subject: c.subject,
      priority: c.priority, status: c.status, profile: config.name,
      firstResponse: { ...firstResponse, targetFormatted: formatDuration(targets.firstResponse), elapsedFormatted: formatDuration(firstResponse.elapsedMinutes) },
      resolution: { ...resolution, targetFormatted: formatDuration(targets.resolution), elapsedFormatted: formatDuration(resolution.elapsedMinutes) },
      pausedWindows: pauses.length,
    });
  } catch (err) { next(err); }
});

// SLA board across open cases
router.get('/cases', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { status, priority, ownerId, slaStatus, limit = 100 } = req.query;

    const where = { deletedAt: null };
    if (status) where.status = status;
    else where.status = { notIn: ['Closed', 'Rejected'] };
    if (priority) where.priority = priority;
    if (ownerId) where.ownerId = ownerId;

    const cases = await prisma.case.findMany({ where, take: Math.min(+limit, 500), orderBy: { createdAt: 'asc' } });
    const config = await loadProfile(prisma, req.query.businessHoursId);

    const rows = [];
    for (const c of cases) {
      const targets = targetsForPriority(c.priority);
      const resolution = calculateSla({ startedAt: c.createdAt, targetMinutes: targets.resolution, config });
      const firstResponse = calculateSla({ startedAt: c.createdAt, targetMinutes: targets.firstResponse, config, completedAt: c.firstRespondedAt || null });
      rows.push({
        id: c.id, caseNumber: c.caseNumber, subject: c.subject,
        priority: c.priority, status: c.status, ownerId: c.ownerId, createdAt: c.createdAt,
        firstResponseStatus: firstResponse.status,
        resolutionStatus: resolution.status,
        dueAt: resolution.dueAt,
        percentUsed: resolution.percentUsed,
        remainingFormatted: formatDuration(resolution.remainingMinutes),
        overdue: resolution.breached,
      });
    }

    const filtered = slaStatus ? rows.filter(r => r.resolutionStatus === slaStatus) : rows;
    filtered.sort((a, b) => b.percentUsed - a.percentUsed);

    res.json({
      profile: config.name,
      total: filtered.length,
      breached: rows.filter(r => r.resolutionStatus === 'Breached').length,
      atRisk: rows.filter(r => r.resolutionStatus === 'AtRisk').length,
      onTrack: rows.filter(r => r.resolutionStatus === 'OnTrack').length,
      cases: filtered,
    });
  } catch (err) { next(err); }
});

// Recompute and persist SLA due dates onto cases
router.post('/cases/recompute', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const config = await loadProfile(prisma, req.body.businessHoursId);
    const cases = await prisma.case.findMany({ where: { deletedAt: null, status: { notIn: ['Closed', 'Rejected'] } }, take: 2000 });

    let updated = 0, breached = 0;
    for (const c of cases) {
      const targets = targetsForPriority(c.priority);
      const sla = calculateSla({ startedAt: c.createdAt, targetMinutes: targets.resolution, config });
      if (sla.breached) breached++;
      try {
        await prisma.case.update({ where: { id: c.id }, data: { slaDueAt: sla.dueAt, slaBreached: sla.breached, slaStatus: sla.status } });
        updated++;
      } catch { /* case model may not carry SLA columns */ }
    }

    await req.audit({ action: 'update', module: 'sla', recordId: 'recompute', details: `SLA recomputed for ${updated} cases, ${breached} breached` });
    res.json({ evaluated: cases.length, updated, breached, profile: config.name });
  } catch (err) { next(err); }
});

// ── TARGETS AND REPORTING ─────────────────────────────────────────────

router.get('/targets', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    let overrides = {};
    try {
      const setting = await prisma.setting.findFirst({ where: { key: 'sla.targets' } });
      if (setting?.value) overrides = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
    } catch { /* settings table is optional */ }

    res.json(Object.keys(DEFAULT_SLA_TARGETS).map(priority => {
      const t = targetsForPriority(priority, overrides);
      return {
        priority,
        firstResponseMinutes: t.firstResponse, firstResponseFormatted: formatDuration(t.firstResponse),
        resolutionMinutes: t.resolution, resolutionFormatted: formatDuration(t.resolution),
        customized: !!overrides[priority],
      };
    }));
  } catch (err) { next(err); }
});

router.put('/targets', authenticate, requirePermission('admin', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { targets } = req.body;
    if (!targets || typeof targets !== 'object') return res.status(400).json({ error: 'targets object required' });

    for (const [priority, t] of Object.entries(targets)) {
      if (!DEFAULT_SLA_TARGETS[priority]) return res.status(400).json({ error: `Unknown priority: ${priority}` });
      if (t.firstResponse != null && (+t.firstResponse <= 0)) return res.status(400).json({ error: 'firstResponse must be positive' });
      if (t.resolution != null && (+t.resolution <= 0)) return res.status(400).json({ error: 'resolution must be positive' });
      if (t.firstResponse && t.resolution && +t.firstResponse > +t.resolution) {
        return res.status(400).json({ error: `${priority}: first response target cannot exceed the resolution target` });
      }
    }

    try {
      const existing = await prisma.setting.findFirst({ where: { key: 'sla.targets' } });
      if (existing) await prisma.setting.update({ where: { id: existing.id }, data: { value: JSON.stringify(targets) } });
      else await prisma.setting.create({ data: { key: 'sla.targets', value: JSON.stringify(targets) } });
    } catch (e) {
      return res.status(500).json({ error: 'Could not persist SLA targets; the settings store is unavailable' });
    }

    await req.audit({ action: 'update', module: 'sla', recordId: 'targets', details: 'SLA targets updated' });
    res.json({ saved: true, targets });
  } catch (err) { next(err); }
});

router.get('/report', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const days = parseInt(req.query.days, 10) || 30;
    const since = new Date(Date.now() - days * 86400000);
    const config = await loadProfile(prisma, req.query.businessHoursId);

    const cases = await prisma.case.findMany({ where: { deletedAt: null, createdAt: { gte: since } }, take: 5000 });

    const byPriority = {};
    let met = 0, missed = 0, open = 0;

    for (const c of cases) {
      const targets = targetsForPriority(c.priority);
      const closed = ['Closed', 'Resolved'].includes(c.status);
      const sla = calculateSla({ startedAt: c.createdAt, targetMinutes: targets.resolution, config, completedAt: closed ? (c.closedAt || c.updatedAt) : null });

      const key = c.priority || 'Medium';
      if (!byPriority[key]) byPriority[key] = { priority: key, total: 0, met: 0, breached: 0, avgResolutionHours: 0, _sum: 0, _closed: 0 };
      byPriority[key].total++;

      if (!closed) { open++; if (sla.breached) { byPriority[key].breached++; missed++; } continue; }
      byPriority[key]._closed++;
      byPriority[key]._sum += sla.elapsedHours;
      if (sla.breached) { byPriority[key].breached++; missed++; } else { byPriority[key].met++; met++; }
    }

    const rows = Object.values(byPriority).map(r => {
      const closedCount = r._closed;
      const { _sum, _closed, ...rest } = r;
      return {
        ...rest,
        avgResolutionHours: closedCount ? +(_sum / closedCount).toFixed(2) : 0,
        compliancePercent: r.total ? +((r.met / r.total) * 100).toFixed(1) : 0,
      };
    });

    res.json({
      periodDays: days, profile: config.name,
      totalCases: cases.length, openCases: open,
      slaMet: met, slaBreached: missed,
      compliancePercent: (met + missed) ? +((met / (met + missed)) * 100).toFixed(1) : 100,
      byPriority: rows.sort((a, b) => b.total - a.total),
    });
  } catch (err) { next(err); }
});

module.exports = router;
