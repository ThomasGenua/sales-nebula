import React, { useEffect, useState } from 'react';
import { Button, Input, Select } from './Controls';
import { useAuth, can } from './contexts';
import { panel, Problem } from './SalesWorkspace';

export function TerritoryRules() {
  const { apiFetch, user } = useAuth();
  const [territories, setTerritories] = useState([]), [id, setId] = useState(''), [rules, setRules] = useState([]), [preview, setPreview] = useState(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { apiFetch('/territories?limit=200').then(r => setTerritories(r.data)).catch(e => setError(e.message)); }, [apiFetch]);
  useEffect(() => { setPreview(null); if (id) apiFetch('/territories/' + id + '/rules').then(setRules).catch(e => setError(e.message)); }, [id, apiFetch]);
  const act = async fn => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const update = (i, key, value) => { setRules(rs => rs.map((r, j) => i === j ? { ...r, [key]: value } : r)); setPreview(null); };
  const save = () => apiFetch('/territories/' + id + '/rules', { method: 'PUT', body: { rules } });
  return <section className={panel}><h2 className="font-semibold">Account assignment rules</h2><Problem message={error} /><Select label="Territory rules" placeholder="Choose a territory" value={id} options={territories.map(t => ({ value: t.id, label: t.name }))} onChange={setId} />
    {id && <div className="space-y-3 mt-3"><p>An account must match every active condition. Manual assignments are preserved.</p>{rules.map((r, i) => <div key={i} className="grid sm:grid-cols-4 gap-2"><Input label="Account field" value={r.field} onChange={v => update(i, 'field', v)} /><Select label="Operator" value={r.operator} options={['equals', 'notEquals', 'contains', 'startsWith', 'greaterThan', 'lessThan', 'isEmpty', 'isNotEmpty']} onChange={v => update(i, 'operator', v)} /><Input label="Value" value={r.value} onChange={v => update(i, 'value', v)} /><Button variant="danger" onClick={() => { setRules(rs => rs.filter((_, j) => j !== i)); setPreview(null); }}>Remove</Button></div>)}
      {can(user, 'admin', 'full') && <><Button disabled={busy} onClick={() => setRules(rs => [...rs, { field: 'industry', operator: 'equals', value: '', active: true }])}>Add condition</Button><Button disabled={busy} onClick={() => act(async () => { await save(); setPreview(null); })}>Save rules</Button><Button disabled={busy} onClick={() => act(async () => { await save(); setPreview(await apiFetch('/territories/' + id + '/rules/preview', { method: 'POST' })); })}>Preview matches</Button><Button disabled={busy || !preview} onClick={() => act(async () => { await apiFetch('/territories/' + id + '/rules/apply', { method: 'POST' }); setPreview(null); })}>Apply saved rules</Button></>}
      {preview && <div role="status"><p>{preview.total} matching accounts</p>{preview.data.slice(0, 100).map(a => <p key={a.id}>{a.name}</p>)}</div>}
    </div>}
  </section>;
}
