const DAYS = 30;
const PAGES = new Set(['/', '/hosting', '/tour', '/demo']);
const EVENTS = { demo_start: 'demoStartedAt', tour_complete: 'tourCompletedAt', form_start: 'formStartedAt' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cleanupAt = new WeakMap();

// Campaign codes only: never store full referring URLs, email addresses,
// query strings, IPs or user agents in acquisition measurement.
function campaign(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_.-]{0,79}$/i.test(value) ? value : null;
}

async function cleanup(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - DAYS * 86400000);
  for (;;) {
    const expired = await db.marketingVisit.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take: 5000 });
    if (!expired.length) return;
    const ids = expired.map(row => row.id);
    await db.$transaction([
      db.signupRequest.updateMany({ where: { marketingVisitId: { in: ids } }, data: { marketingVisitId: null } }),
      db.marketingVisit.deleteMany({ where: { id: { in: ids } } }),
    ]);
  }
}

async function maintain(db) {
  if ((cleanupAt.get(db) || 0) > Date.now()) return;
  cleanupAt.set(db, Date.now() + 3600000);
  try { await cleanup(db); } catch (error) { cleanupAt.delete(db); throw error; }
}

async function record(db, body) {
  if (!UUID.test(body.visitId || '') || !PAGES.has(body.page) || !['mobile', 'desktop'].includes(body.device)) {
    const error = new Error('Invalid measurement'); error.status = 400; throw error;
  }
  const event = body.event;
  if (typeof event !== 'string' || event !== 'visit' && event !== 'vital' && !Object.hasOwn(EVENTS, event)) {
    const error = new Error('Unknown measurement event'); error.status = 400; throw error;
  }
  const now = new Date();
  let update = {};
  if (Object.hasOwn(EVENTS, event)) update[EVENTS[event]] = now;
  if (event === 'vital') {
    const metrics = { LCP: ['lcpMs', 120000], INP: ['inpMs', 60000], CLS: ['cls', 100] };
    const metric = typeof body.name === 'string' && Object.hasOwn(metrics, body.name) ? metrics[body.name] : null;
    if (!metric || typeof body.value !== 'number' || !Number.isFinite(body.value) || body.value < 0 || body.value > metric[1]) {
      const error = new Error('Invalid performance metric'); error.status = 400; throw error;
    }
    // A late beacon may arrive before the visit request. Upsert tolerates that;
    // the attribution and landing page are otherwise immutable for the session.
    update[metric[0]] = body.value;
  }
  await db.marketingVisit.upsert({
    where: { id: body.visitId },
    create: { id: body.visitId, page: body.page, device: body.device, utmSource: campaign(body.utmSource), utmMedium: campaign(body.utmMedium), utmCampaign: campaign(body.utmCampaign), ...update },
    update,
  });
  await maintain(db);
}

async function attribution(db, body) {
  const marketingVisitId = UUID.test(body.marketingVisitId || '') ? body.marketingVisitId : null;
  const visit = marketingVisitId ? await db.marketingVisit.findUnique({ where: { id: marketingVisitId } }) : null;
  return {
    marketingVisitId: visit?.id || null,
    utmSource: campaign(visit?.utmSource || body.utmSource),
    utmMedium: campaign(visit?.utmMedium || body.utmMedium),
    utmCampaign: campaign(visit?.utmCampaign || body.utmCampaign),
  };
}

function percentile(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * .75) - 1];
}

async function summary(db, days = 30) {
  await maintain(db);
  const since = new Date(Date.now() - days * 86400000);
  const visits = await db.marketingVisit.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 10000 });
  const requests = await db.signupRequest.findMany({ where: { marketingVisitId: { in: visits.map(v => v.id) } }, select: { marketingVisitId: true, verifiedAt: true, convertedAt: true } });
  const requested = new Set(requests.map(r => r.marketingVisitId));
  const verified = new Set(requests.filter(r => r.verifiedAt).map(r => r.marketingVisitId));
  const activated = new Set(requests.filter(r => r.convertedAt).map(r => r.marketingVisitId));
  const groups = new Map();
  const performance = new Map();
  for (const visit of visits) {
    const key = JSON.stringify([visit.utmSource || 'direct', visit.utmMedium || '', visit.utmCampaign || '']);
    if (!groups.has(key)) groups.set(key, { source: visit.utmSource || 'direct', medium: visit.utmMedium || '', campaign: visit.utmCampaign || '', visits: 0, demos: 0, requests: 0, activated: 0 });
    const group = groups.get(key); group.visits++; group.demos += !!visit.demoStartedAt; group.requests += requested.has(visit.id); group.activated += activated.has(visit.id);
    const perfKey = `${visit.page}:${visit.device}`;
    if (!performance.has(perfKey)) performance.set(perfKey, { page: visit.page, device: visit.device, lcpMs: [], inpMs: [], cls: [] });
    for (const metric of ['lcpMs', 'inpMs', 'cls']) if (visit[metric] !== null) performance.get(perfKey)[metric].push(visit[metric]);
  }
  return {
    days, sampled: visits.length === 10000, retentionDays: DAYS,
    funnel: { visits: visits.length, demos: visits.filter(v => v.demoStartedAt).length, tours: visits.filter(v => v.tourCompletedAt).length, forms: visits.filter(v => v.formStartedAt).length, requested: requested.size, verified: verified.size, activated: activated.size },
    sources: [...groups.values()].sort((a, b) => b.visits - a.visits).slice(0, 30),
    performance: [...performance.values()].map(group => ({ page: group.page, device: group.device, metrics: Object.fromEntries(['lcpMs', 'inpMs', 'cls'].map(name => [name, { p75: percentile(group[name]), samples: group[name].length }])) })),
  };
}

module.exports = { record, attribution, summary, cleanup, campaign, percentile };
