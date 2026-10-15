import React, { useEffect, useState } from 'react';
import { Button, Select } from './Controls';
import { useAuth, can } from './contexts';
import { panel, Problem } from './SalesWorkspace';
import { money } from './prefs';

export function ForecastHistory({ period }) {
  const { apiFetch, user } = useAuth();
  const [forecasts, setForecasts] = useState([]), [id, setId] = useState(''), [history, setHistory] = useState([]), [rollup, setRollup] = useState(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = async () => {
    const [list, summary] = await Promise.all([apiFetch('/forecasts'), apiFetch('/forecasts/stats/rollup' + (period ? '?period=' + encodeURIComponent(period) : ''))]);
    setForecasts(list.data); setRollup(summary);
    if (id) setHistory((await apiFetch('/forecasts/' + id + '/history')).data);
  };
  useEffect(() => { load().catch(e => setError(e.message)); }, [id, apiFetch, period]);
  return <section className={panel + ' mt-4'}><h2 className="font-semibold">Forecast history and team attainment</h2><Problem message={error} />
    {rollup && <div className="overflow-auto my-3"><table className="w-full text-sm"><thead><tr><th>Owner</th><th>Quota</th><th>Commit</th><th>Closed</th><th>Attainment</th></tr></thead><tbody>{rollup.byRep.map((r, i) => <tr key={i}><td>{r.user?.firstName} {r.user?.lastName}</td><td>{r.quota}</td><td>{r.commit}</td><td>{r.closed}</td><td>{r.attainment}%</td></tr>)}</tbody></table></div>}
    <Select label="Forecast history" placeholder="Choose a forecast" value={id} options={forecasts.map(f => ({ value: f.id, label: f.name + ' · ' + f.period }))} onChange={setId} />
    {id && can(user, 'deals', 'edit') && <Button disabled={busy || forecasts.find(f => f.id === id)?.status !== 'Open'} onClick={async () => { setBusy(true); setError(''); try { await apiFetch('/forecasts/' + id + '/refresh', { method: 'POST' }); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); } }}>Refresh open forecast</Button>}
    <div className="overflow-auto mt-3"><table className="w-full text-sm"><thead><tr><th>Snapshot</th><th>Commit</th><th>Pipeline</th><th>Actual closed</th></tr></thead><tbody>{history.map(h => <tr key={h.id}><td>{new Date(h.createdAt).toLocaleString()}</td><td>{money(h.commit, h.currency)}</td><td>{money(h.pipeline, h.currency)}</td><td>{money(h.closed, h.currency)}</td></tr>)}</tbody></table></div>
    {id && !history.length && <p>No snapshots yet. Refresh this open forecast to save its first snapshot.</p>}
  </section>;
}
