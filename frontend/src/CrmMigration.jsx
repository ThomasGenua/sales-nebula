import React, { useEffect, useState } from 'react';
import { useAuth } from './contexts';
import { Button, Input, Select, Modal, TextArea } from './Controls';
import { panel, Problem } from './SalesWorkspace';
import { parseCsv } from './csv';

const label = s => s.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
export function CrmMigration() {
  const { apiFetch, demoMode } = useAuth();
  const [meta, setMeta] = useState(null), [history, setHistory] = useState([]), [job, setJob] = useState(null);
  const [source, setSource] = useState('salesforce'), [sourceInstance, setSourceInstance] = useState(''), [name, setName] = useState('CRM migration'), [duplicatePolicy, setPolicy] = useState('skip');
  const [files, setFiles] = useState({}), [owners, setOwners] = useState(''), [stageMap, setStageMap] = useState({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [ack, setAck] = useState(false), [editing, setEditing] = useState(null), [undo, setUndo] = useState(null), [page, setPage] = useState(1), [errorsOnly, setErrorsOnly] = useState(false);
  const act = async fn => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const refreshHistory = () => apiFetch('/crm-migrations').then(r => setHistory(r.data));
  const load = (id, p = page, onlyErrors = errorsOnly) => apiFetch(`/crm-migrations/${id}?page=${p}&errors=${onlyErrors}`).then(setJob);
  useEffect(() => { Promise.all([apiFetch('/crm-migrations/metadata').then(setMeta), refreshHistory()]).catch(e => setError(e.message)); }, [apiFetch]);
  useEffect(() => {
    if (job?.batch.status !== 'Running') return;
    const timer = setInterval(() => load(job.batch.id).catch(e => setError(e.message)), 3000);
    return () => clearInterval(timer);
  }, [job?.batch.id, job?.batch.status, page, errorsOnly]);
  const choose = (module, file) => act(async () => {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) throw new Error('Choose a CSV smaller than 12 MB. Split larger exports into separate migrations.');
    const parsed = parseCsv(await file.text());
    if (!parsed.rows.length) throw new Error('The CSV needs at least one record.');
    const mapping = await apiFetch('/crm-migrations/mapping', { method: 'POST', body: { module, headers: parsed.header } });
    setFiles(v => ({ ...v, [module]: { module, filename: file.name, headers: parsed.header, records: parsed.rows, mapping } }));
  });
  const stageValues = [...new Set((files.deals?.records || []).map(r => r[files.deals.mapping.stage]).filter(Boolean))];
  const start = () => act(async () => { await apiFetch(`/crm-migrations/${job.batch.id}/start`, { method: 'POST', body: { acknowledgeAutomation: ack } }); await load(job.batch.id); });
  return <div className="space-y-4"><h2 className="text-xl font-bold">Move your CRM into Sales Nebula</h2>
    <p>Import Salesforce or HubSpot CSV exports for accounts, contacts, leads and deals. Source IDs keep relationships intact across files and later imports.</p>
    <Problem message={error} />
    <details className={panel} open={!job}><summary className="cursor-pointer font-semibold">Prepare a migration</summary>
      <div className="grid md:grid-cols-2 gap-3 mt-4"><Select label="Source CRM" value={source} onChange={setSource} options={[{ value: 'salesforce', label: 'Salesforce' }, { value: 'hubspot', label: 'HubSpot' }]} /><Input label="Source organization" value={sourceInstance} onChange={setSourceInstance} placeholder="Use the same name for every export from this organization" /><Input label="Migration name" value={name} onChange={setName} /><Select label="Existing matches" value={duplicatePolicy} onChange={setPolicy} options={[{ value: 'skip', label: 'Keep existing records' }, { value: 'update', label: 'Update mapped fields on existing records' }]} /></div>
      <p className="text-sm mt-3">Records match by saved source ID first, then email for people or name for accounts and deals. Ambiguous matches require correction. Blank mapped values replace existing values when updating.</p>
      {meta?.modules.map(module => <section className="border-t border-slate-700 pt-3 mt-3" key={module}>
        <label className="block font-semibold">{label(module)} CSV<input type="file" accept=".csv,text/csv" className="block mt-2 text-sm max-w-full" disabled={busy} onChange={e => choose(module, e.target.files?.[0])} /></label>
        {files[module] && <><p className="my-2 text-sm">{files[module].filename} · {files[module].records.length.toLocaleString()} rows</p><div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">{Object.entries(files[module].mapping).map(([key, value]) => <Select key={key} label={`${label(module)}: ${label(key)}${key === 'sourceId' || meta.required[module].includes(key) ? ' (required)' : ''}`} value={value} onChange={v => setFiles(f => ({ ...f, [module]: { ...f[module], mapping: { ...f[module].mapping, [key]: v } } }))} placeholder="Do not import" options={files[module].headers} />)}</div><Button variant="ghost" onClick={() => setFiles(f => { const n = { ...f }; delete n[module]; return n; })}>Remove {module} file</Button></>}
      </section>)}
      <div className="my-4"><TextArea label="Owner mapping CSV (source owner ID,email)" value={owners} onChange={setOwners} placeholder={'sourceId,email\n005123,teammate@example.com'} /><p className="text-sm">Map exported owner IDs to active teammates, or map an Owner email column above. Rows without any owner use your account.</p></div>
      {stageValues.length > 0 && <details className="my-3"><summary>Map source deal stages</summary><div className="grid sm:grid-cols-2 gap-2 mt-2">{stageValues.map(s => <Select key={s} label={s} value={stageMap[s] || ''} onChange={v => setStageMap(m => ({ ...m, [s]: v }))} placeholder="Use automatic stage mapping" options={meta?.stages} />)}</div></details>}
      <Button disabled={busy || demoMode || !sourceInstance || !Object.keys(files).length} onClick={() => act(async () => {
        const ownerRows = owners.trim() ? parseCsv(owners).rows : [];
        if (ownerRows.some(r => !r.sourceId || !r.email)) throw new Error('Owner mapping needs sourceId and email headings with a value on every row.');
        const body = { source, sourceInstance, name, duplicatePolicy, ownerMap: Object.fromEntries(ownerRows.map(r => [r.sourceId, r.email])), stageMap, files: Object.values(files).map(({ module, records, mapping }) => ({ module, records, mapping })) };
        if (new Blob([JSON.stringify(body)]).size > 19 * 1024 * 1024) throw new Error('Combined files exceed 19 MB. Split the export into separate migrations.');
        const batch = await apiFetch('/crm-migrations', { method: 'POST', body }); setPage(1); setErrorsOnly(false); setAck(false); await load(batch.id, 1, false); await refreshHistory();
      })}>Create import preview</Button>
    </details>
    <Select label="Saved migrations" value={job?.batch.id || ''} placeholder="Choose a migration" options={history.map(b => ({ value: b.id, label: `${b.name} · ${b.sourceInstance}` }))} onChange={id => act(async () => { setPage(1); setErrorsOnly(false); setAck(false); setUndo(null); await load(id, 1, false); })} />
    {job && <section className={`${panel} space-y-3`}><div className="flex flex-wrap justify-between gap-2"><h3 className="font-bold">{job.batch.name} · {job.batch.status}</h3><Button variant="secondary" disabled={busy} onClick={() => act(() => load(job.batch.id))}>Refresh migration</Button></div>
      <Problem message={job.batch.error} /><div className="flex flex-wrap gap-3" role="status">{Object.entries(job.counts).map(([status, n]) => <span key={status}>{status}: {n}</span>)}</div>
      <label className="flex items-center gap-2"><input type="checkbox" checked={errorsOnly} onChange={e => { const v = e.target.checked; setErrorsOnly(v); setPage(1); act(() => load(job.batch.id, 1, v)); }} />Show errors only</label>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Record</th><th>Source ID</th><th>Status</th><th>Details</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{job.rows.map(r => <tr key={r.id} className="border-t border-slate-700"><td className="p-2">{label(r.module)}<br />{r.data.name || `${r.data.firstName || ''} ${r.data.lastName || ''}`}</td><td>{r.sourceId}</td><td>{r.status}</td><td className="max-w-sm p-2">{r.error || (r.operation ? `${r.operation} record` : 'Ready for validation during import')}</td><td>{['Pending', 'Invalid', 'Failed'].includes(r.status) && job.batch.status !== 'Running' && <Button variant="secondary" onClick={() => setEditing({ ...r, data: { ...r.data } })}>Edit row</Button>}</td></tr>)}</tbody></table></div>
      {!job.rows.length && <p>No rows in this view.</p>}<div className="flex items-center gap-3"><Button variant="secondary" disabled={busy || page <= 1} onClick={() => { setPage(p => p - 1); act(() => load(job.batch.id, page - 1)); }}>Previous</Button><span>Page {page} of {Math.max(1, Math.ceil(job.total / 50))}</span><Button variant="secondary" disabled={busy || page * 50 >= job.total} onClick={() => { setPage(p => p + 1); act(() => load(job.batch.id, page + 1)); }}>Next</Button></div>
      {job.batch.status === 'Running' ? <Button variant="secondary" disabled={busy} onClick={() => act(async () => { await apiFetch(`/crm-migrations/${job.batch.id}/pause`, { method: 'POST' }); await load(job.batch.id); })}>Pause after current record</Button> : job.batch.status !== 'Undone' && <><label className="flex items-start gap-2"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />I reviewed the preview and active automation. Imports run record validation and workflows, which may send messages. Undo restores eligible records; it cannot recall messages.</label><div className="flex gap-2 flex-wrap"><Button disabled={busy || demoMode || !ack || !!job.counts.Invalid || !(job.counts.Pending || job.counts.Failed)} onClick={start}>Start or resume import</Button><Button variant="secondary" disabled={busy || !job.counts.Applied} onClick={() => act(async () => setUndo(await apiFetch(`/crm-migrations/${job.batch.id}/undo`)))}>Preview undo</Button></div></>}
    </section>}
    <Modal open={!!editing} onClose={() => !busy && setEditing(null)} title="Correct import row" wide>{editing && <div className="space-y-3"><p>{editing.module} · {editing.sourceId}</p>{[...meta.fields[editing.module], 'ownerEmail', ...(editing.module !== 'accounts' ? ['accountExternalId'] : []), ...(editing.module === 'deals' ? ['contactExternalId'] : [])].map(key => key === 'stage' ? <Select key={key} label={label(key)} value={editing.data[key] || ''} options={meta.stages} placeholder="Choose stage" onChange={v => setEditing(r => ({ ...r, data: { ...r.data, [key]: v } }))} /> : <Input key={key} label={label(key)} value={editing.data[key] || ''} onChange={v => setEditing(r => ({ ...r, data: { ...r.data, [key]: v } }))} />)}<Problem message={error} /><Button disabled={busy} onClick={() => act(async () => { await apiFetch(`/crm-migrations/${job.batch.id}/rows/${editing.id}`, { method: 'PATCH', body: { data: editing.data } }); setEditing(null); await load(job.batch.id); })}>Save corrected row</Button></div>}</Modal>
    <Modal open={!!undo} onClose={() => !busy && setUndo(null)} title="Review migration undo"><div className="space-y-3"><p>{undo?.rows.length} records will be restored or removed. Later edits and new dependent records prevent undo.</p>{undo?.rows.filter(r => r.conflict).map(r => <p key={r.id} className="text-red-400">{r.module} {r.sourceId}: {r.conflict}</p>)}<Problem message={error} /><Button variant="danger" disabled={busy || demoMode || !undo?.rows.length || undo.rows.some(r => r.conflict)} onClick={() => act(async () => { await apiFetch(`/crm-migrations/${job.batch.id}/undo`, { method: 'POST', body: { hash: undo.hash } }); setUndo(null); await load(job.batch.id); })}>Undo reviewed migration</Button></div></Modal>
  </div>;
}
