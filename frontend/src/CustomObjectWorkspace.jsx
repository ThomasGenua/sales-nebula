import React, { useContext, useEffect, useState } from 'react';
import { Button, Input, Select } from './Controls';
import { useAuth, can, RouteContext } from './contexts';
import { panel, Problem } from './SalesWorkspace';

export function CustomObjectWorkspace() {
  const { apiFetch, user } = useAuth();
  const { recordId: routeId } = useContext(RouteContext);
  useEffect(() => { if (routeId?.includes('~')) setId(routeId.split('~')[0]); }, [routeId]);
  const [objects, setObjects] = useState([]), [id, setId] = useState(''), [definition, setDefinition] = useState(null);
  const [rows, setRows] = useState([]), [record, setRecord] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [field, setField] = useState({ label: '', type: 'Text', options: '', required: false, unique: false });
  const [page, setPage] = useState(1), [pages, setPages] = useState(1);
  const base = '/custom-objects/' + id;
  const act = async fn => { if (busy) return; setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const load = async () => {
    if (!id) return;
    const [obj, records] = await Promise.all([apiFetch(base), apiFetch(base + '/records?limit=25&page=' + page)]);
    setDefinition(obj); setRows(records.data); setPages(records.pages);
    if (routeId?.startsWith(id + '~')) setRecord(await apiFetch(base + '/records/' + routeId.split('~')[1]));
  };
  useEffect(() => { apiFetch('/custom-objects?limit=200').then(r => setObjects(r.data)).catch(e => setError(e.message)); }, [apiFetch]);
  useEffect(() => { setRecord(null); load().catch(e => setError(e.message)); }, [id, page]);
  const edit = user?.role?.name === 'Admin' || can(user, 'custom:' + id, 'edit');
  const admin = can(user, 'admin', 'full');
  return <section className={panel}><h2 className="text-lg font-bold mb-3">Fields and records</h2><Problem message={error} />
    <Select label="Custom object" placeholder="Choose an object" value={id} options={objects.map(o => ({ value: o.id, label: o.label }))} onChange={v => { setId(v); setPage(1); }} />
    {definition && <div className="space-y-4 mt-4">
      {admin && <details><summary className="cursor-pointer">Manage fields</summary><div className="space-y-3 mt-3">
        {definition.fields.map(f => <div key={f.id} className="flex justify-between"><span>{f.label} · {f.type}{f.required ? ' · Required' : ''}{f.unique ? ' · Unique' : ''}</span><Button variant="danger" disabled={busy} onClick={() => act(async () => { await apiFetch(base + '/fields/' + f.id, { method: 'DELETE' }); await load(); })}>Remove field</Button></div>)}
        <Input label="Field label" value={field.label} onChange={v => setField(f => ({ ...f, label: v }))} />
        <Select label="Field type" value={field.type} options={['Text', 'TextArea', 'Number', 'Currency', 'Date', 'DateTime', 'Checkbox', 'Email', 'URL', 'Phone', 'Picklist', 'Lookup']} onChange={v => setField(f => ({ ...f, type: v }))} />
        {field.type === 'Picklist' && <Input label="Options, separated by commas" value={field.options} onChange={v => setField(f => ({ ...f, options: v }))} />}
        {field.type === 'Lookup' && <Select label="Related object" value={field.lookupObject || ''} placeholder="Choose an object" options={objects.map(o => ({ value: o.id, label: o.label }))} onChange={v => setField(f => ({ ...f, lookupObject: v }))} />}
        {['required', 'unique'].map(key => <label key={key} className="mr-4"><input type="checkbox" checked={field[key]} onChange={e => setField(f => ({ ...f, [key]: e.target.checked }))} /> {key}</label>)}
        <Button disabled={busy || !field.label.trim()} onClick={() => act(async () => { await apiFetch(base + '/fields', { method: 'POST', body: { ...field, options: field.options.split(',').map(v => v.trim()).filter(Boolean) } }); setField({ label: '', type: 'Text', options: '', required: false, unique: false }); await load(); })}>Add field</Button>
      </div></details>}
      {edit && <Button onClick={() => setRecord({ data: Object.fromEntries(definition.fields.filter(f => f.defaultValue != null).map(f => [f.apiName, f.defaultValue])) })}>New record</Button>}
      {record && <form className="space-y-3" onSubmit={e => { e.preventDefault(); act(async () => { await apiFetch(base + '/records' + (record.id ? '/' + record.id : ''), { method: record.id ? 'PUT' : 'POST', body: { data: record.data } }); setRecord(null); await load(); }); }}>
        {definition.fields.map(f => {
          const value = record.data?.[f.apiName] ?? '';
          const change = v => setRecord(r => ({ ...r, data: { ...r.data, [f.apiName]: v } }));
          if (f.type === 'Lookup') return <RelationshipPicker key={f.id} field={f} value={value} onChange={change} />;
          if (f.type === 'Picklist') return <Select key={f.id} label={f.label} placeholder="Choose a value" options={f.picklistValues} value={value} onChange={change} />;
          if (f.type === 'Checkbox') return <label key={f.id} className="block"><input type="checkbox" checked={value === true || value === 'true'} onChange={e => change(e.target.checked)} /> {f.label}</label>;
          return <Input key={f.id} label={f.label + (f.type === 'Lookup' ? ' (related record ID)' : '')} required={f.required} value={value} onChange={change} type={['Number', 'Currency'].includes(f.type) ? 'number' : f.type === 'Date' ? 'date' : f.type === 'DateTime' ? 'datetime-local' : 'text'} step="any" />;
        })}<Button type="submit" disabled={busy || !edit}>Save record</Button><Button variant="ghost" onClick={() => setRecord(null)}>Cancel</Button>
      </form>}
      <div className="overflow-auto"><table className="w-full text-sm"><thead><tr><th className="text-left p-2">Record ID</th>{definition.fields.map(f => <th key={f.id} className="text-left p-2">{f.label}</th>)}<th>Actions</th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td className="p-2">{r.id}</td>{definition.fields.map(f => <td key={f.id} className="p-2">{String(r.data?.[f.apiName] ?? '')}</td>)}<td>{edit && <Button variant="ghost" onClick={() => setRecord(r)}>Edit</Button>}</td></tr>)}</tbody></table></div>
      <div className="flex gap-3"><Button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</Button><span>Page {page} of {Math.max(1, pages)}</span><Button disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</Button></div>
    </div>}
  </section>;
}

function RelationshipPicker({ field, value, onChange }) {
  const { apiFetch } = useAuth();
  const [query, setQuery] = useState(''), [options, setOptions] = useState([]), [error, setError] = useState('');
  useEffect(() => { if (!field.lookupObject || query.length < 2) return; let live = true;
    const timer = setTimeout(() => apiFetch('/custom-objects/' + field.lookupObject + '/records/search?q=' + encodeURIComponent(query)).then(r => live && setOptions(r.results)).catch(e => live && setError(e.message)), 250);
    return () => { live = false; clearTimeout(timer); };
  }, [query, field.lookupObject, apiFetch]);
  return <div><Input label={'Search ' + field.label} value={query} onChange={setQuery} /><Problem message={error} /><Select label={field.label} value={value} placeholder="Choose a related record" onChange={onChange} options={[...(value && !options.some(r => r.id === value) ? [{ value, label: 'Selected record · ' + value }] : []), ...options.map(r => ({ value: r.id, label: Object.values(r.data || {}).filter(v => typeof v === 'string').slice(0, 2).join(' · ') || r.id }))]} /></div>;
}
