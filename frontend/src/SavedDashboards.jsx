import React, { useEffect, useState } from 'react';
import { Button, Input, Select } from './Controls';
import { useAuth, can } from './contexts';
import { panel, Problem } from './SalesWorkspace';

export function SavedDashboards() {
  const { apiFetch, user } = useAuth();
  const [dashboards, setDashboards] = useState([]), [reports, setReports] = useState([]), [id, setId] = useState(''), [name, setName] = useState(''), [selected, setSelected] = useState([]);
  const [field, setField] = useState(''), [value, setValue] = useState(''), [widgets, setWidgets] = useState([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = async () => { const [d, r] = await Promise.all([apiFetch('/analytics/dashboards'), apiFetch('/reports')]); setDashboards(d.data); setReports(r); };
  useEffect(() => { load().catch(e => setError(e.message)); }, [apiFetch]);
  const act = async fn => { setBusy(true); setError(''); try { await fn(); } catch(e) { setError(e.message); } finally { setBusy(false); } };
  return <details className={panel + ' mb-4'}><summary className="font-semibold cursor-pointer">Saved dashboards</summary><Problem message={error} />
    <Select label="Dashboard" placeholder="Choose dashboard" value={id} options={dashboards.map(d => ({ value: d.id, label: d.name }))} onChange={v => { setId(v); setWidgets([]); const d = dashboards.find(d => d.id === v); setName(d?.name || ''); setSelected((d?.layout || []).map(w => w.config?.reportId).filter(Boolean)); }} />
    <div className="grid sm:grid-cols-2 gap-2 my-2"><Input label="Shared filter field" placeholder="e.g. status" value={field} onChange={setField} /><Input label="Equals" value={value} onChange={setValue} /></div>
    <Button disabled={!id || busy} onClick={() => act(async () => setWidgets((await apiFetch('/analytics/dashboards/' + id + '/run', { method: 'POST', body: { filters: field ? [{ field, operator: 'equals', value }] : [] } })).widgets))}>Run dashboard</Button>
    {can(user, 'reports', 'edit') && <details className="my-3"><summary>Edit dashboard</summary><Input label="Dashboard name" value={name} onChange={setName} />{reports.map(r => <label className="block" key={r.id}><input type="checkbox" checked={selected.includes(r.id)} onChange={e => setSelected(s => e.target.checked ? [...s, r.id] : s.filter(id => id !== r.id))} /> {r.name}</label>)}<Button disabled={busy || !name || !selected.length} onClick={() => act(async () => { const d = await apiFetch('/analytics/dashboards' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body: { name, layout: selected.map(reportId => ({ config: { reportId } })), filters: field ? [{ field, operator: 'equals', value }] : [] } }); setId(d.id); await load(); })}>Save dashboard</Button><Button variant="ghost" onClick={() => { setId(''); setName(''); setSelected([]); }}>New dashboard</Button></details>}
    <div className="grid lg:grid-cols-2 gap-3 mt-3">{widgets.map(w => <article key={w.reportId} className={panel}><h3 className="font-semibold">{w.name}</h3><Problem message={w.error} />{w.result && <><p>{w.result.totalCount} matching records</p><details><summary>Drill into records</summary><div className="overflow-auto"><table className="text-xs"><thead><tr>{Object.keys(w.result.rows?.[0] || {}).map(k => <th className="p-2" key={k}>{k}</th>)}</tr></thead><tbody>{(w.result.rows || []).slice(0, 50).map((r, i) => <tr key={r.id || i}>{Object.entries(r).map(([k,v]) => <td className="p-2" key={k}>{v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>)}</tr>)}</tbody></table></div></details>{w.result.summary && <Summary summary={w.result.summary}/>}</>}</article>)}</div>
  </details>;
}

function Summary({ summary }) {
  const rows = Array.isArray(summary.data) ? summary.data : [summary.data || {}];
  const flat = rows.map(r => Object.fromEntries(Object.entries(r).flatMap(([k,v]) => k.startsWith('_') && v && typeof v === 'object' ? Object.entries(v).map(([f,n]) => [k.slice(1) + ' ' + f,n]) : [[k,v]])));
  const columns = [...new Set(flat.flatMap(Object.keys))];
  return <div className="overflow-auto"><table className="w-full text-sm"><thead><tr>{columns.map(k=><th className="p-2 text-left" key={k}>{k}</th>)}</tr></thead><tbody>{flat.map((r,i)=><tr key={i}>{columns.map(k=><td className="p-2" key={k}>{String(r[k]??'—')}</td>)}</tr>)}</tbody></table></div>;
}
