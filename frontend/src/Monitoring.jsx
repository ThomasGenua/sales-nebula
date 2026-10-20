import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Input, Select } from './Controls';
import { useAuth } from './contexts';
import { panel, Problem, Pager } from './SalesWorkspace';
import { fmt } from './prefs';

const PAGE_SIZE = 25;
const when = date => (date ? new Date(date).toLocaleString(...fmt()) : '');
const person = user => (user ? [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email : '');
const statusColor = code => (code >= 500 ? 'danger' : code >= 400 ? 'warning' : 'success');

function Figure({ label, value, hint }) {
  return <div className="bg-[#0B1228] border border-[#182550] rounded-xl p-3">
    <div className="text-lg font-bold font-mono text-[#F0EDE5]">{value ?? '—'}</div>
    <div className="text-xs text-[#7E8598]">{label}</div>
    {hint && <div className="text-[11px] text-[#4A5168] mt-0.5">{hint}</div>}
  </div>;
}

function ApiEvents() {
  const { apiFetch } = useAuth();
  const [filters, setFilters] = useState({ module: '', status: '' });
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    const query = new URLSearchParams({ eventType: 'API', limit: PAGE_SIZE, page });
    if (filters.module.trim()) query.set('module', filters.module.trim());
    if (filters.status) query.set('status', filters.status);
    apiFetch(`/monitoring/event-logs?${query}`).then(r => { setResult(r); setError(''); }).catch(e => setError(e.message));
  }, [apiFetch, filters, page]);
  const filter = (key, value) => { setFilters(f => ({ ...f, [key]: value })); setPage(1); };
  return <section className={panel} aria-label="API events">
    <div className="grid sm:grid-cols-3 gap-3 mb-3">
      <Input label="Module" value={filters.module} onChange={v => filter('module', v)} placeholder="leads" />
      <Select label="Outcome" value={filters.status} onChange={v => filter('status', v)} options={[{ value: '', label: 'All requests' }, { value: 'server', label: 'Server errors (5xx)' }, { value: 'client', label: 'Refused (4xx)' }, { value: 'ok', label: 'Succeeded' }]} />
    </div>
    <Problem message={error} />
    {!result ? <p className="text-sm text-[#7E8598]">Loading…</p> : result.data.length === 0 ? <p className="text-sm text-[#7E8598]">No API events match.</p> : <>
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-[#7E8598]"><th className="py-2 pr-3 font-medium">Time</th><th className="py-2 pr-3 font-medium">Request</th><th className="py-2 pr-3 font-medium">Status</th><th className="py-2 pr-3 font-medium">Took</th><th className="py-2 font-medium">User</th></tr></thead>
        <tbody>{result.data.map(e => <tr key={e.id} className="border-t border-[#182550]">
          <td className="py-2 pr-3 whitespace-nowrap text-[#C8C2B4]">{when(e.timestamp)}</td>
          <td className="py-2 pr-3 font-mono text-xs text-[#F0EDE5] break-all">{e.method} {e.uri}</td>
          <td className="py-2 pr-3"><Badge color={statusColor(e.statusCode)}>{e.statusCode}</Badge></td>
          <td className="py-2 pr-3 whitespace-nowrap font-mono text-xs text-[#C8C2B4]">{e.responseTime != null ? `${e.responseTime} ms` : ''}</td>
          <td className="py-2 text-[#C8C2B4]">{person(e.user) || <span className="text-[#4A5168]">Not signed in</span>}</td>
        </tr>)}</tbody>
      </table></div>
      <Pager page={page} total={result.total} size={PAGE_SIZE} onChange={setPage} />
    </>}
  </section>;
}

function SignIns() {
  const { apiFetch } = useAuth();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    const query = new URLSearchParams({ limit: PAGE_SIZE, page });
    if (status) query.set('status', status);
    apiFetch(`/monitoring/login-history?${query}`).then(r => { setResult(r); setError(''); }).catch(e => setError(e.message));
  }, [apiFetch, status, page]);
  return <section className={panel} aria-label="Sign-ins">
    <Select label="Result" className="sm:w-64 mb-3" value={status} onChange={v => { setStatus(v); setPage(1); }} options={[{ value: '', label: 'All sign-ins' }, { value: 'Success', label: 'Succeeded' }, { value: 'Failed', label: 'Failed' }]} />
    <Problem message={error} />
    {!result ? <p className="text-sm text-[#7E8598]">Loading…</p> : result.data.length === 0 ? <p className="text-sm text-[#7E8598]">No sign-ins match.</p> : <>
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-[#7E8598]"><th className="py-2 pr-3 font-medium">Time</th><th className="py-2 pr-3 font-medium">User</th><th className="py-2 pr-3 font-medium">Result</th><th className="py-2 font-medium">Address</th></tr></thead>
        <tbody>{result.data.map(s => <tr key={s.id} className="border-t border-[#182550]">
          <td className="py-2 pr-3 whitespace-nowrap text-[#C8C2B4]">{when(s.loginTime)}</td>
          <td className="py-2 pr-3 text-[#F0EDE5]">{person(s.user)}</td>
          <td className="py-2 pr-3"><Badge color={s.status === 'Success' ? 'success' : 'danger'}>{s.status === 'Success' ? 'Succeeded' : s.status}</Badge></td>
          <td className="py-2 font-mono text-xs text-[#C8C2B4]">{s.sourceIp || ''}</td>
        </tr>)}</tbody>
      </table></div>
      <Pager page={page} total={result.total} size={PAGE_SIZE} onChange={setPage} />
    </>}
  </section>;
}

/**
 * /api/monitoring, which had no screen: sign-in and API figures, alerts, the
 * API event log and sign-in history. It shows every user's activity, so it
 * takes admin read and users read, as the admin dashboard does.
 */
export function MonitoringPage() {
  const { apiFetch } = useAuth();
  const [metrics, setMetrics] = useState(null), [performance, setPerformance] = useState(null), [alerts, setAlerts] = useState([]);
  const [tab, setTab] = useState('events'), [error, setError] = useState(''), [stamp, setStamp] = useState(0);
  const load = useCallback(() => {
    setError('');
    Promise.all([apiFetch('/monitoring/metrics'), apiFetch('/monitoring/metrics/performance?hours=24'), apiFetch('/monitoring/alerts')])
      .then(([m, p, a]) => { setMetrics(m); setPerformance(p); setAlerts(a.alerts || []); })
      .catch(e => setError(e.message));
  }, [apiFetch]);
  useEffect(() => { load(); }, [load, stamp]);
  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-2">
      <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5]">Monitoring</h1>
      <Button variant="secondary" onClick={() => setStamp(s => s + 1)}>Refresh</Button>
    </div>
    <Problem message={error} />
    {alerts.length > 0 && <section className={panel} aria-label="Alerts"><ul className="space-y-1">{alerts.map((a, i) => <li key={i} className="text-sm text-[#F0EDE5] flex items-center gap-2"><Badge color={a.severity === 'high' ? 'danger' : 'warning'}>{a.severity}</Badge>{a.message}</li>)}</ul></section>}
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
      <Figure label="API calls, last hour" value={metrics?.api.callsLastHour} />
      <Figure label="Server errors, last hour" value={metrics?.api.errorsLastHour} />
      <Figure label="Average response, 24 h" value={performance ? `${performance.avgResponseMs} ms` : null} hint={performance ? `${performance.apiCalls} calls, ${performance.errorRate} errors` : null} />
      <Figure label="Sign-ins today" value={metrics?.auth.loginsToday} hint={metrics ? `${metrics.users.activeToday} people` : null} />
      <Figure label="Failed sign-ins today" value={metrics?.auth.failedLogins} hint={metrics ? `${metrics.auth.failureRate}% of attempts` : null} />
      <Figure label="Active accounts" value={metrics?.users.total} />
    </div>
    <p className="text-xs text-[#4A5168]">API events are kept 30 days and written a few seconds after each request. A request is shown by its route, such as /api/leads/:id, never with the tokens or search terms it carried.</p>
    <div className="flex gap-1 bg-[#0B1228] rounded-lg p-1 border border-[#182550] w-fit" role="tablist">
      {[['events', 'API events'], ['signins', 'Sign-ins']].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`px-4 py-2 rounded-md text-sm font-medium touch-manipulation ${tab === id ? 'bg-[rgba(245,166,35,0.08)] text-[#F5A623]' : 'text-[#7E8598]'}`}>{label}</button>)}
    </div>
    {tab === 'events' ? <ApiEvents key={stamp} /> : <SignIns key={stamp} />}
  </div>;
}
