const KEY = 'sn_public_visit';
const OPT_OUT = 'sn_measurement_opt_out';
const pages = new Set(['/', '/tour', '/hosting', '/demo']);
let vitalsStarted = false;
let sent = new Set();
let visitRequest = Promise.resolve();
const code = value => /^[a-z0-9][a-z0-9_.-]{0,79}$/i.test(value || '') ? value : undefined;

export function measurementAllowed() {
  try { return typeof window !== 'undefined' && navigator.doNotTrack !== '1' && !navigator.globalPrivacyControl && localStorage.getItem(OPT_OUT) !== 'true'; }
  catch { return false; }
}

function visit() {
  if (!measurementAllowed()) return null;
  try {
    const existing = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (existing?.visitId && Date.now() - existing.started < 30 * 60 * 1000) return existing;
    const params = new URLSearchParams(location.search);
    const value = { visitId: crypto.randomUUID(), page: pages.has(location.pathname) ? location.pathname : '/', device: innerWidth < 768 ? 'mobile' : 'desktop',
      utmSource: code(params.get('utm_source')), utmMedium: code(params.get('utm_medium')), utmCampaign: code(params.get('utm_campaign')), started: Date.now() };
    sessionStorage.setItem(KEY, JSON.stringify(value));
    return value;
  } catch { return null; }
}

export function track(event, details = {}) {
  const value = visit();
  if (!value) return;
  const dedup = `${value.visitId}:${event}`;
  if (event !== 'vital' && sent.has(dedup)) return visitRequest;
  sent.add(dedup);
  const { started, ...payload } = value;
  const request = fetch('/api/marketing/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, event, ...details }), keepalive: true }).then(response => { if (!response.ok) sent.delete(dedup); }).catch(() => { sent.delete(dedup); });
  if (event === 'visit') visitRequest = request;
  return request;
}

// Allow an in-flight visit to reach the server before signup links it. A slow
// or blocked measurement endpoint must never hold up an access request.
export async function flushVisit() { await Promise.race([track('visit'), new Promise(resolve => setTimeout(resolve, 700))]); }

export function attribution() {
  const value = visit();
  return value ? { marketingVisitId: value.visitId, utmSource: value.utmSource, utmMedium: value.utmMedium, utmCampaign: value.utmCampaign } : {};
}

export function startMeasurement(path) {
  if (!pages.has(path) || !measurementAllowed()) return;
  track('visit');
  if (vitalsStarted) return;
  vitalsStarted = true;
  import('web-vitals').then(({ onLCP, onINP, onCLS }) => {
    const firstVisit = visit();
    const report = ({ name, value }) => {
      if (location.pathname !== path || !measurementAllowed() || !firstVisit || visit()?.visitId !== firstVisit.visitId || firstVisit.page !== path) return;
      track('vital', { name, value });
    };
    onLCP(report); onINP(report); onCLS(report);
  }).catch(() => {});
}

export function setMeasurement(enabled) {
  try {
    localStorage.setItem(OPT_OUT, enabled ? 'false' : 'true');
    if (!enabled) { sessionStorage.removeItem(KEY); sent = new Set(); }
    else startMeasurement(location.pathname);
  } catch { /* Storage restrictions also disable measurement. */ }
}
