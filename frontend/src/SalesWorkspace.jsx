import React, { useCallback, useContext, useEffect, useState } from 'react';
import { Button, Input, Select, TextArea, Modal } from './Controls';
import { useAuth, can, RouteContext } from './contexts';
import { money, fmt } from './prefs';
import { RecordPicker } from './SalesWorkflows';

export const panel = 'bg-[#0B1228] border border-[#182550] rounded-xl p-4';
export const rowsOf = value => value?.data || (Array.isArray(value) ? value : []);
export const nameOf = row => row?.name || row?.subject || [row?.firstName, row?.lastName].filter(Boolean).join(' ') || 'Untitled';
export const dateLabel = (date, calendar = false) => {
  if (!date) return 'No date';
  const [locale, options] = fmt();
  return new Date(date).toLocaleDateString(locale, calendar ? { ...options, timeZone: 'UTC' } : options);
};
export function Problem({ message }) { return message ? <p role="alert" className="text-sm text-[#F87171] my-3">{message}</p> : null; }
export function Pager({ page, total, size = 25, onChange }) {
  return <div className="flex items-center gap-3 text-sm mt-4"><Button variant="secondary" disabled={page <= 1} onClick={() => onChange(page - 1)}>Previous</Button><span>Page {page} of {Math.max(1, Math.ceil(total / size))} · {total} records</span><Button variant="secondary" disabled={page * size >= total} onClick={() => onChange(page + 1)}>Next</Button></div>;
}

/** Saved definitions are stored on the server, so views follow a user across devices. */
export function SavedViews({ module, value, onApply }) {
  const { apiFetch, user, demoMode } = useAuth();
  const [views, setViews] = useState([]), [selected, setSelected] = useState('');
  const [open, setOpen] = useState(false), [name, setName] = useState(''), [shared, setShared] = useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = useCallback(() => apiFetch(`/views/${module}`).then(d => setViews(rowsOf(d))).catch(e => setError(e.message)), [apiFetch, module]);
  useEffect(() => { load(); }, [load]);
  const current = views.find(v => v.id === selected);
  const save = async e => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const v = await apiFetch('/views', { method: 'POST', body: { module, name, filters: value, isShared: shared } });
      setSelected(v.id); setOpen(false); setName(''); await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return <section aria-label="Saved views" className="my-3">
    <div className="flex flex-wrap items-end gap-2">
      <Select label="Saved view" value={selected} options={views.map(v => ({ value: v.id, label: `${v.name}${v.isShared ? ' (shared)' : ''}` }))} placeholder="Choose a saved view" onChange={id => { setSelected(id); const v = views.find(v => v.id === id); if (v && v.filters && !Array.isArray(v.filters)) onApply(v.filters); }} />
      {!demoMode && <Button variant="secondary" onClick={() => { setError(''); setOpen(true); }}>Save current view</Button>}
      {current?.userId === user?.id && !demoMode && <Button variant="secondary" onClick={async () => { try { await apiFetch(`/views/${current.id}`, { method: 'DELETE' }); setSelected(''); await load(); } catch (e) { setError(e.message); } }}>Delete view</Button>}
    </div>
    <Problem message={error} />
    <Modal open={open} onClose={() => !busy && setOpen(false)} title="Save current view"><form className="space-y-4" onSubmit={save}>
      <Input label="View name" value={name} onChange={setName} required />
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} />Share this view with everyone (record permissions still apply)</label>
      <Problem message={error} /><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save view'}</Button>
    </form></Modal>
  </section>;
}

/** One activity form used by the work queue, pipeline, and record pages. */
export function QuickActivity({ target, onClose, onSaved }) {
  const { apiFetch, user } = useAuth();
  const [form, setForm] = useState(() => ({ subject: target.subject || `Follow up: ${nameOf(target.record)}`, type: target.call ? 'Call' : 'Task', dueDate: new Date().toLocaleDateString('en-CA'), description: '', result: '', contactId: target.record?.contactId || (target.module === 'contacts' ? target.record.id : null), dealId: target.module === 'deals' ? target.record.id : target.record?.dealId, leadId: target.module === 'leads' ? target.record.id : target.record?.leadId, accountId: target.module === 'accounts' ? target.record.id : target.record?.accountId }));
  const [followUp, setFollowUp] = useState(false), [followDate, setFollowDate] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const complete = target.complete;
  const put = key => v => setForm(f => ({ ...f, [key]: v }));
  const save = async e => {
    e.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {
      if (complete) await apiFetch(`/activities/${target.record.id}/complete`, { method: 'POST', body: { result: form.result || 'Completed', ...(followUp && { followUp: { date: followDate, subject: form.subject, type: form.type } }) } });
      else await apiFetch(target.call ? '/activities/log-call' : '/activities', { method: 'POST', body: { ...form, ...(target.call ? {} : { dueDate: `${form.dueDate}T00:00:00.000Z`, date: new Date(`${form.dueDate}T12:00:00`).toISOString(), status: 'Scheduled' }) } });
      onSaved(); onClose();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return <Modal open onClose={() => !busy && onClose()} title={complete ? 'Complete activity' : target.call ? 'Log a call' : 'Schedule next action'}><form onSubmit={save} className="space-y-3">
    {complete && <><p className="text-sm">{target.record.subject}</p><TextArea label="Outcome" value={form.result} onChange={put('result')} /><label className="flex gap-2 text-sm"><input type="checkbox" checked={followUp} onChange={e => setFollowUp(e.target.checked)} />Schedule a follow-up</label></>}
    {(!complete || followUp) && <><Input label="Subject" value={form.subject} onChange={put('subject')} required />
      {!target.call && <Select label="Activity type" value={form.type} options={['Task', 'Call', 'Meeting', 'Follow-up']} onChange={put('type')} />}
      {!target.call && <Input label="Due date" type="date" value={complete ? followDate : form.dueDate} onChange={complete ? setFollowDate : put('dueDate')} required />}</>}
    {!complete && <><TextArea label="Notes" value={form.description} onChange={put('description')} />
      {!target.record && can(user, 'deals', 'read') && <RecordPicker module="deals" label="Deal" value={form.dealId} onChange={put('dealId')} />}
    </>}
    <Problem message={error} /><Button type="submit" disabled={busy}>{busy ? 'Saving…' : complete ? 'Complete activity' : 'Save activity'}</Button>
  </form></Modal>;
}

export function MyDayPage() {
  const { apiFetch, user, demoMode } = useAuth();
  const { navigate } = useContext(RouteContext);
  const sections = [{ id: 'overdue', label: 'Overdue', module: 'activities' }, { id: 'today', label: 'Today', module: 'activities' }, { id: 'leads', label: 'New leads', module: 'leads' }, { id: 'deals', label: 'Deals needing attention', module: 'deals' }].filter(s => can(user, s.module, 'read'));
  const [section, setSection] = useState(sections[0]?.id || ''), [page, setPage] = useState(1), [revision, setRevision] = useState(0);
  const [data, setData] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [target, setTarget] = useState(null);
  useEffect(() => {
    if (!section) { setLoading(false); return; }
    const c = new AbortController(); setLoading(true); setError('');
    const start = new Date(); start.setHours(0, 0, 0, 0); const end = new Date(start); end.setDate(end.getDate() + 1);
    const q = new URLSearchParams({ section, page, day: start.toLocaleDateString('en-CA'), start: start.toISOString(), end: end.toISOString() });
    apiFetch(`/sales-workspace/my-day?${q}`, { signal: c.signal }).then(setData).catch(e => { if (!c.signal.aborted) setError(e.message); }).finally(() => { if (!c.signal.aborted) setLoading(false); });
    return () => c.abort();
  }, [apiFetch, section, page, revision]);
  const mayAct = !demoMode && can(user, 'activities', 'edit');
  return <div className="space-y-4"><div className="flex flex-wrap justify-between gap-3"><div><h1 className="text-xl font-bold">My Day</h1><p className="text-sm text-[#7E8598]">Your follow-ups, new leads, and deals that need a next step.</p></div>{mayAct && <Button onClick={() => setTarget({})}>New task</Button>}</div>
    <div className="flex flex-wrap gap-2">{sections.map(s => <Button key={s.id} variant={section === s.id ? 'primary' : 'secondary'} onClick={() => { setSection(s.id); setPage(1); }}>{s.label}</Button>)}</div>
    <Problem message={error} />
    {loading ? <p role="status">Loading your work…</p> : !section ? <p>No sales modules are available for your role.</p> : !error && <>
      {section === 'deals' && <p className="text-sm text-[#7E8598]">Your open deals with no visible pending activity, or no deal update in 14 days.</p>}
      {section === 'leads' && <p className="text-sm text-[#7E8598]">Your unconverted leads still marked New, oldest first.</p>}
      {data?.data?.length === 0 && <div className={panel}>Nothing waiting here.</div>}
      <div className="space-y-3">{data?.data?.map(row => <article key={row.id} className={panel}><div className="flex flex-wrap justify-between gap-3"><div><button className="text-left font-semibold text-[#F5A623]" onClick={() => navigate(data.module, row.id)}>{nameOf(row)}</button><p className="text-sm text-[#7E8598]">{data.module === 'activities' ? `${row.type} · Due ${dateLabel(row.dueDate || row.date, !!row.dueDate)}` : data.module === 'leads' ? `${row.company} · New since ${dateLabel(row.createdAt)}` : `${row.stage} · ${row.nextAction ? `Next: ${row.nextAction.subject}` : row.nextActionAvailable ? 'No next action' : 'Activity access unavailable'}`}</p></div>
        {mayAct && <div className="flex flex-wrap gap-2">{data.module === 'activities' ? <Button onClick={() => setTarget({ record: row, complete: true, subject: `Follow-up: ${row.subject}` })}>Complete</Button> : <><Button variant="secondary" onClick={() => setTarget({ record: row, module: data.module, call: true })}>Log call</Button><Button onClick={() => setTarget({ record: row, module: data.module })}>Next action</Button></>}</div>}
      </div></article>)}</div><Pager page={page} total={data?.total || 0} onChange={setPage} />
    </>}
    {target && <QuickActivity target={target} onClose={() => setTarget(null)} onSaved={() => setRevision(n => n + 1)} />}
  </div>;
}

export function PipelinePage() {
  const { apiFetch, user, demoMode } = useAuth(); const { navigate } = useContext(RouteContext);
  const [filters, setFilters] = useState({ mine: true, search: '', closeFrom: '', closeTo: '' });
  const [columns, setColumns] = useState([]), [stages, setStages] = useState([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState(''), [revision, setRevision] = useState(0), [target, setTarget] = useState(null);
  const mayEdit = !demoMode && can(user, 'deals', 'edit');
  const query = new URLSearchParams(filters).toString();
  useEffect(() => { const c = new AbortController(); setLoading(true); setError('');
    const timer = setTimeout(() => apiFetch(`/sales-workspace/pipeline?${query}`, { signal: c.signal }).then(d => { setColumns(d.columns); setStages(d.stages); }).catch(e => { if (!c.signal.aborted) setError(e.message); }).finally(() => { if (!c.signal.aborted) setLoading(false); }), 200);
    return () => { clearTimeout(timer); c.abort(); };
  }, [apiFetch, query, revision]);
  const move = async (row, stage) => {
    if (!mayEdit || busy || row.stage === stage) return; setBusy(row.id); setError('');
    try { await apiFetch(`/deals/${row.id}`, { method: 'PUT', headers: { 'If-Match': row.updatedAt }, body: { stage } }); setRevision(n => n + 1); }
    catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const more = async col => { setBusy(col.stage); try { const d = await apiFetch(`/sales-workspace/pipeline?${query}&stage=${encodeURIComponent(col.stage)}&page=${col.page + 1}`); setColumns(all => all.map(c => c.stage === col.stage ? { ...d.columns[0], rows: [...c.rows, ...d.columns[0].rows] } : c)); } catch (e) { setError(e.message); } finally { setBusy(''); } };
  const put = key => v => setFilters(f => ({ ...f, [key]: v }));
  return <div className="space-y-4"><div className="flex justify-between gap-3"><div><h1 className="text-xl font-bold">Pipeline</h1><p className="text-sm text-[#7E8598]">Move a deal by dragging it, or use its stage selector.</p></div><Button variant="secondary" onClick={() => navigate('deals')}>Deal list</Button></div>
    <div className="flex flex-wrap items-end gap-3"><Input label="Search deals" value={filters.search} onChange={put('search')} /><Input label="Closing from" type="date" value={filters.closeFrom} onChange={put('closeFrom')} /><Input label="Closing through" type="date" value={filters.closeTo} onChange={put('closeTo')} /><label className="text-sm flex gap-2 pb-2"><input type="checkbox" checked={filters.mine} onChange={e => put('mine')(e.target.checked)} />My deals only</label></div>
    <SavedViews module="pipeline" value={filters} onApply={v => setFilters({ mine: v.mine === true, search: v.search || '', closeFrom: v.closeFrom || '', closeTo: v.closeTo || '' })} />
    <Problem message={error} />{loading ? <p role="status">Loading pipeline…</p> : <div className="flex gap-3 overflow-x-auto pb-4" aria-label="Deal board">{columns.map(col => <section key={col.stage} aria-label={col.stage} className="w-72 min-w-[18rem] bg-[#0E1630] rounded-xl p-3" onDragOver={e => mayEdit && e.preventDefault()} onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); const row = columns.flatMap(c => c.rows).find(r => r.id === id); if (row) move(row, col.stage); }}>
      <h2 className="font-semibold">{col.stage} <span className="text-[#7E8598]">{col.total}</span></h2><p className="text-xs text-[#7E8598] mb-3">{col.amounts.map(a => money(a.value, a.currency || 'USD')).join(' + ') || 'No deals'}</p>
      <div className="space-y-3">{col.rows.map(row => <article key={row.id} draggable={mayEdit && !busy} onDragStart={e => e.dataTransfer.setData('text/plain', row.id)} className={panel}>
        <button className="font-semibold text-left text-[#F5A623]" onClick={() => navigate('deals', row.id)}>{row.name}</button><p className="text-sm my-1">{money(row.value, row.currency || 'USD')}</p><p className="text-xs text-[#7E8598]">{Math.max(0, Math.floor((Date.now() - new Date(row.stageSince)) / 86400000))} days in stage · Close {dateLabel(row.closeDate, true)}</p><p className="text-xs mt-2">{row.nextAction ? `${row.nextAction.subject} · ${dateLabel(row.nextAction.dueDate || row.nextAction.date, !!row.nextAction.dueDate)}` : row.nextActionAvailable ? 'No next action' : 'Activity access unavailable'}</p>
        {mayEdit && <Select label={`Stage for ${row.name}`} value={row.stage} options={stages} onChange={stage => move(row, stage)} disabled={!!busy} />}
        {!demoMode && can(user, 'activities', 'edit') && <Button variant="secondary" className="mt-2" onClick={() => setTarget({ module: 'deals', record: row })}>Next action</Button>}
      </article>)}</div>{col.rows.length < col.total && <Button variant="secondary" disabled={!!busy} className="mt-3" onClick={() => more(col)}>Load more {col.stage}</Button>}
    </section>)}</div>}
    {target && <QuickActivity target={target} onClose={() => setTarget(null)} onSaved={() => setRevision(n => n + 1)} />}
  </div>;
}
