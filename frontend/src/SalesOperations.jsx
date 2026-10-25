import { PaymentsWorkspace, ComputedFieldsWorkspace, CampaignExecution, DealRoomsWorkspace, SuccessWorkspace } from './RevenueWorkflows';
import { PricingRules } from './PricingRules';
import { EnterpriseSettings } from './EnterpriseSettings';
import React, { useContext, useEffect, useState } from 'react';
import { useAuth, can, RouteContext } from './contexts';
import { Button, Input, Select, TextArea } from './Controls';
import { RecordPicker } from './SalesWorkflows';
import { MyDayPage, panel, Problem, Pager, dateLabel, nameOf } from './SalesWorkspace';
import { money } from './prefs';

function useLoad(path, revision = 0) {
  const { apiFetch } = useAuth();
  const [data, setData] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  useEffect(() => {
    setData(null); setError('');
    if (!path) return;
    const c = new AbortController(); setLoading(true);
    apiFetch(path, { signal: c.signal }).then(setData).catch(e => { if (!c.signal.aborted) setError(e.message); }).finally(() => { if (!c.signal.aborted) setLoading(false); });
    return () => c.abort();
  }, [path, apiFetch, revision]);
  return { data, error, loading };
}
function LoadState({ error, loading }) { return <><Problem message={error} />{loading && <p role="status">Loading…</p>}</>; }
function Link({ module, id, children }) {
  const { navigate } = useContext(RouteContext);
  return <button className="text-[#F5A623] text-left hover:underline" onClick={() => navigate(module, id)}>{children}</button>;
}
function Daily() {
  const loaded = useLoad('/sales-operations/workspace');
  return <div className="space-y-5"><LoadState {...loaded} />
    <div className="grid lg:grid-cols-2 gap-4">
      <section className={panel}><h2 className="font-bold mb-3">Upcoming meetings · next 7 days</h2>
        {loaded.data && !loaded.data.meetings.length && !loaded.data.events.length && <p>No upcoming meetings.</p>}
        {loaded.data?.meetings.map(m => <p key={m.id}><Link module="activities" id={m.id}>{m.subject}</Link> · {new Date(m.date).toLocaleString()}</p>)}
        {loaded.data?.events.map((e, i) => <p key={`${e.id}-${i}`}><Link module="calendar">{e.title}</Link> · {new Date(e.startAt).toLocaleString()}</p>)}
      </section>
      <section className={panel}><h2 className="font-bold mb-3">Emails awaiting your reply</h2><p className="text-xs text-slate-400 mb-2">Based on the latest synced inbound threads in your personal mailbox.</p>
        {loaded.data?.unanswered.length === 0 && <p>No unanswered synced threads.</p>}
        {loaded.data?.unanswered.map(m => <p key={m.id}><Link module="mailbox">{m.subject || '(No subject)'}</Link> · {m.fromEmail} · {dateLabel(m.receivedAt)}</p>)}
      </section>
    </div><MyDayPage />
  </div>;
}
function Account360() {
  const { apiFetch, user, demoMode } = useAuth();
  const [id, setId] = useState(''), [revision, setRevision] = useState(0), [value, setValue] = useState('0'), [closeDate, setCloseDate] = useState(''), [currency, setCurrency] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const loaded = useLoad(id && `/sales-operations/accounts/${id}`, revision);
  const currencies = useLoad(can(user, 'deals', 'read') && '/deals/currencies');
  const health = useLoad(id && `/accounts/${id}/health`, revision);
  return <div className="space-y-4"><RecordPicker module="accounts" label="Account" value={id} onChange={setId} /><LoadState {...loaded} /><Problem message={health.error} />
    {loaded.data && <><h2 className="text-xl font-bold">{loaded.data.account.name}</h2>
      {health.data && <section className={panel}><strong>Health: {health.data.tier} · {health.data.score}/100</strong><p className="text-sm text-slate-400">Based on your visible contacts, deals, cases and recent activities.</p></section>}
      <section className={panel}><h3 className="font-bold mb-2">People and opportunities</h3><div className="flex flex-wrap gap-3">{loaded.data.contacts.map(c => <Link key={c.id} module="contacts" id={c.id}>{nameOf(c)}</Link>)}</div>
        {loaded.data.deals.map(d => <p key={d.id}><Link module="deals" id={d.id}>{d.name}</Link> · {d.stage} · {money(d.value, d.currency || 'USD')}</p>)}
      </section>
      {can(user, 'deals', 'edit') && <section className={panel}><h3 className="font-bold">Expansion opportunity</h3><div className="flex flex-wrap gap-3 my-3"><Input label="Expansion value" type="number" value={value} onChange={setValue} /><Input label="Expansion close date" type="date" value={closeDate} onChange={setCloseDate} /><Select label="Expansion currency" value={currency || currencies.data?.base || 'USD'} onChange={setCurrency} options={[...new Set([currencies.data?.base || 'USD', ...(currencies.data?.data || []).map(c => c.code)])]} /></div><Problem message={error} /><Button disabled={demoMode || busy || !closeDate} onClick={async () => { setBusy(true); setError(''); try { await apiFetch(`/sales-operations/accounts/${id}/expansion`, { method: 'POST', body: { value, closeDate, currency: currency || currencies.data?.base } }); setRevision(n => n + 1); } catch (e) { setError(e.message); } finally { setBusy(false); } }}>Create expansion opportunity</Button></section>}
      <section className={panel}><h3 className="font-bold">Account-wide timeline</h3><p className="text-xs text-slate-400 mb-3">{loaded.data.coverage}</p>
        {!loaded.data.timeline.length && <p>No related activity.</p>}
        {loaded.data.timeline.map(r => <article key={`${r.module}-${r.id}`} className="py-2 border-b border-[#182550]"><span className="text-xs text-slate-400">{dateLabel(r.date)} · {r.module}</span><p><Link module={r.module} id={r.module === 'calendar' ? undefined : r.id}>{r.title}</Link> · {r.status}</p></article>)}
      </section></>}
  </div>;
}
const CHECKS = { need: 'Business need confirmed', budget: 'Budget confirmed', authority: 'Decision maker identified', timeline: 'Buying timeline confirmed', decisionProcess: 'Decision process understood' };
function Coaching() {
  const { apiFetch, user, demoMode } = useAuth();
  const [id, setId] = useState(''), [revision, setRevision] = useState(0), [draft, setDraft] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [contact, setContact] = useState(''), [role, setRole] = useState('Decision Maker'), [competitors, setCompetitors] = useState('');
  const loaded = useLoad(id && `/deals/${id}`, revision), roles = useLoad(id && `/deals/${id}/contact-roles`, revision);
  const requirements = useLoad('/sales-operations/requirements');
  const editable = !demoMode && can(user, 'deals', 'edit');
  useEffect(() => { const d = loaded.data; setDraft(d ? { qualification: d.qualification || {}, nextStep: d.nextStep || '', nextStepDate: d.nextStepDate?.slice(0, 10) || '', stage: d.stage } : null); setCompetitors((Array.isArray(d?.competitors) ? d.competitors : []).map(c => typeof c === 'string' ? c : c?.name).filter(Boolean).join('\n')); }, [loaded.data]);
  const act = async fn => { setBusy(true); setError(''); try { await fn(); setRevision(n => n + 1); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  return <div className="space-y-4"><RecordPicker module="deals" label="Deal" value={id} onChange={setId} /><LoadState {...loaded} /><Problem message={error || roles.error || requirements.error} />
    {draft && <><form className={panel} onSubmit={e => { e.preventDefault(); act(() => apiFetch(`/deals/${id}`, { method: 'PUT', headers: { 'If-Match': loaded.data.updatedAt }, body: { ...draft, nextStepDate: draft.nextStepDate || null, competitors: competitors.split('\n').map(s => s.trim()).filter(Boolean).map(name => (Array.isArray(loaded.data.competitors) ? loaded.data.competitors : []).find(c => c && typeof c === 'object' && c.name === name) || { name }) } })); }}>
      <h2 className="font-bold mb-3">Qualification and next step</h2><div className="space-y-2">{Object.entries(CHECKS).map(([key, label]) => <label key={key} className="flex gap-2"><input type="checkbox" disabled={!editable || busy} checked={draft.qualification[key] === true} onChange={e => setDraft(d => ({ ...d, qualification: { ...d.qualification, [key]: e.target.checked } }))} />{label}</label>)}</div>
      <div className="grid md:grid-cols-2 gap-3 my-3"><Input label="Next step" value={draft.nextStep} onChange={nextStep => setDraft(d => ({ ...d, nextStep }))} /><Input label="Next step date" type="date" value={draft.nextStepDate} onChange={nextStepDate => setDraft(d => ({ ...d, nextStepDate }))} />
        <Select label="Stage" value={draft.stage} options={['Qualification', 'Discovery', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost']} onChange={stage => setDraft(d => ({ ...d, stage }))} /></div>
      <p className="text-sm mb-2">Required for this stage: {(requirements.data?.stages[draft.stage] || []).join(', ') || 'No configured requirements'}</p>
      <TextArea label="Competitors (one per line)" value={competitors} onChange={setCompetitors} />
      {editable && <Button type="submit" disabled={busy}>Save deal coaching</Button>}
    </form><section className={panel}><h2 className="font-bold mb-3">Buying committee</h2>
      {(Array.isArray(roles.data) ? roles.data : []).map(r => <div key={r.id} className="flex gap-3 items-center my-2"><span>{r.contact ? nameOf(r.contact) : 'Contact'} · {r.role}</span>{editable && <Button variant="secondary" disabled={busy} onClick={() => act(() => apiFetch(`/deals/${id}/contact-roles/${r.id}`, { method: 'DELETE' }))}>Remove</Button>}</div>)}
      {editable && can(user, 'contacts', 'read') && <div className="space-y-2"><RecordPicker module="contacts" label="Committee contact" value={contact} onChange={setContact} /><Select label="Role" value={role} onChange={setRole} options={['Decision Maker', 'Influencer', 'Champion', 'Budget Holder', 'Technical Evaluator', 'Executive Sponsor']} /><Button disabled={!contact || busy} onClick={() => act(() => apiFetch(`/deals/${id}/contact-roles`, { method: 'POST', body: { contactId: contact, role } }))}>Add committee member</Button></div>}
    </section></>}
    {can(user, 'admin', 'full') && <StageRequirements />}
  </div>;
}
function StageRequirements() {
  const { apiFetch, demoMode } = useAuth(), loaded = useLoad('/sales-operations/requirements');
  const [value, setValue] = useState('{}'), [error, setError] = useState(''), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => { if (loaded.data) setValue(JSON.stringify(loaded.data.stages, null, 2)); }, [loaded.data]);
  return <details className={panel}><summary>Stage requirements (administrator)</summary><p className="text-sm my-2">Map stages to required checklist keys or nextStep, nextStepDate, contactId. Example: {"{\"Proposal\":[\"need\",\"budget\",\"nextStep\"]}"}. These checks apply to every save.</p>
    <TextArea label="Stage requirements JSON" value={value} onChange={v => { setValue(v); setSaved(false); }} /><Problem message={error || loaded.error} />{saved && <p role="status">Requirements saved. Reopen coaching to refresh the stage hints.</p>}
    <Button disabled={demoMode || busy} onClick={async () => { setBusy(true); setError(''); try { await apiFetch('/sales-operations/requirements', { method: 'PUT', body: JSON.parse(value) }); setSaved(true); } catch (e) { setError(e.message); } finally { setBusy(false); } }}>Save requirements</Button>
  </details>;
}
function Renewals() {
  const { apiFetch, user, demoMode } = useAuth();
  const [days, setDays] = useState('90'), [revision, setRevision] = useState(0), [error, setError] = useState(''), [busy, setBusy] = useState(''), [reminder, setReminder] = useState(new Date().toISOString().slice(0, 10)), [currency, setCurrency] = useState('');
  const loaded = useLoad(`/sales-operations/renewals?days=${days}`, revision), currencies = useLoad('/deals/currencies');
  const act = async (id, type) => { setBusy(id); setError(''); try { await apiFetch(`/sales-operations/renewals/${id}/${type}`, { method: 'POST', body: type === 'reminder' ? { dueDate: reminder } : { currency: currency || currencies.data?.base } }); setRevision(n => n + 1); } catch (e) { setError(e.message); } finally { setBusy(''); } };
  return <div className="space-y-4"><div className="flex flex-wrap gap-3"><Select label="Renewal horizon" value={days} onChange={setDays} options={['30', '60', '90', '180', '365']} /><Input label="Reminder due date" type="date" value={reminder} onChange={setReminder} /><Select label="Opportunity currency" value={currency || currencies.data?.base || 'USD'} onChange={setCurrency} options={[...new Set([currencies.data?.base || 'USD', ...(currencies.data?.data || []).map(c => c.code)])]} /></div>
    <p className="text-sm text-slate-400">Activated and expired contracts, earliest first (up to 100). Contract values have no currency field; choose the opportunity currency explicitly.</p><LoadState {...loaded} /><Problem message={error} />
    {loaded.data?.data.length === 0 && <p>No contracts due in this window.</p>}
    {loaded.data?.data.map(c => <article key={c.id} className={panel}><h2 className="font-bold"><Link module="contracts" id={c.id}>{c.name}</Link></h2><p>Ends {dateLabel(c.endDate)} · {c.daysRemaining < 0 ? `${-c.daysRemaining} days overdue` : `${c.daysRemaining} days remaining`} · Value {c.value}</p>
      <div className="flex flex-wrap gap-3 mt-2">{c.opportunity ? <Link module="deals" id={c.opportunity.id}>{c.opportunity.name} · {c.opportunity.stage}</Link> : can(user, 'deals', 'edit') && <Button disabled={demoMode || !!busy} onClick={() => act(c.id, 'opportunity')}>Create renewal opportunity</Button>}
        {can(user, 'activities', 'edit') && <Button variant="secondary" disabled={demoMode || !!busy || !reminder} onClick={() => act(c.id, 'reminder')}>Create reminder task</Button>}</div></article>)}
    <p className="text-sm">Track expansion as a deal with type “Expansion”; link it to the customer account to include it in Account 360.</p>
  </div>;
}
function Changes() {
  const [since, setSince] = useState(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)), [page, setPage] = useState(1);
  const loaded = useLoad(`/sales-operations/pipeline-changes?since=${since}&page=${page}`);
  return <div className="space-y-3"><Input label="Changes since" type="date" value={since} onChange={v => { setSince(v); setPage(1); }} /><LoadState {...loaded} />
    <p className="text-sm text-slate-400">Field history is recorded from this release onward. Earlier changes are not reconstructed.</p>
    {loaded.data?.data.length === 0 && <p>No recorded changes in this window.</p>}
    {loaded.data?.data.map(c => <article className={panel} key={c.id}><Link module="deals" id={c.dealId}>{c.deal.name}</Link><p>{c.field}: {c.oldDisplay || 'Empty'} → {c.newDisplay || 'Empty'} {c.slipped && <strong className="text-amber-400"> · Slipped close date</strong>}</p><p className="text-xs text-slate-400">{new Date(c.changedAt).toLocaleString()}</p></article>)}
    <Pager page={page} total={loaded.data?.total || 0} size={50} onChange={setPage} />
  </div>;
}
function Quality() {
  const { apiFetch, user, demoMode } = useAuth(), modules = ['contacts', 'leads', 'accounts'].filter(m => can(user, m, 'read'));
  const [module, setModule] = useState(modules[0] || ''), [page, setPage] = useState(1), [revision, setRevision] = useState(0), [selected, setSelected] = useState([]), [field, setField] = useState(''), [value, setValue] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [preview, setPreview] = useState(null), [outcomes, setOutcomes] = useState(null);
  const loaded = useLoad(module && `/sales-operations/quality/${module}?page=${page}`, revision);
  const act = async fn => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  return <div className="space-y-3"><Select label="Review module" value={module} options={modules} onChange={m => { setModule(m); setPage(1); setSelected([]); setPreview(null); setField(''); }} /><LoadState {...loaded} /><Problem message={error} />
    <p className="text-sm text-slate-400">Review records in pages of 50. Stale means no changes in 90 days; duplicates use exact email matches (account name for accounts).</p>
    {loaded.data?.data.map(r => <article key={r.id} className={panel}><div className="flex gap-3"><input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.includes(r.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, r.id] : ids.filter(id => id !== r.id))} /><Link module={module} id={r.id}>{r.name}</Link></div>
      <p>{r.missing.length ? `Missing: ${r.missing.join(', ')}` : 'Required review fields present'}{r.stale && ' · Stale'}</p>
      {r.duplicates.map(d => <Button key={d.id} variant="secondary" disabled={busy} onClick={() => act(async () => setPreview(await apiFetch(`/sales-operations/quality/${module}/merge-preview`, { method: 'POST', body: { masterId: r.id, sourceId: d.id } })))}>Compare duplicate</Button>)}
    </article>)}
    <Pager page={page} total={loaded.data?.total || 0} size={50} onChange={p => { setPage(p); setSelected([]); setPreview(null); }} />
    {can(user, module, 'edit') && <section className={panel}><h2 className="font-bold">Bulk cleanup · {selected.length} selected</h2><Select label="Field" value={field} options={['', ...(loaded.data?.fields || [])]} onChange={setField} /><Input label="New value for all selected records" value={value} onChange={setValue} /><Button disabled={demoMode || busy || !selected.length || !field} onClick={() => act(async () => { const r = await apiFetch(`/sales-operations/quality/${module}/bulk`, { method: 'POST', body: { ids: selected, field, value } }); setOutcomes(r.outcomes); setRevision(n => n + 1); setSelected([]); })}>Apply cleanup</Button>
      {outcomes && <p role="status">{outcomes.filter(o => o.saved).length} saved. {outcomes.filter(o => !o.saved).map(o => `${o.id}: ${o.error}`).join('; ')}</p>}</section>}
    {preview && <section className={panel}><h2 className="font-bold">Merge comparison</h2><p>Survivor: {preview.masterId}. Source: {preview.sourceId}.</p><table className="w-full text-left"><thead><tr><th>Field</th><th>Survivor</th><th>Source</th></tr></thead><tbody>{preview.fields.map(f => <tr key={f.field}><td>{f.field}</td><td>{f.master || 'Empty'}</td><td>{f.source || 'Empty'}</td></tr>)}</tbody></table>
      <p className="text-sm mt-2">The existing administrator merge keeps the survivor’s values and transfers supported related records. Review both records before merging.</p>
      {can(user, 'admin', 'full') && <Button disabled={demoMode || busy} onClick={() => { if (window.confirm('Merge the source into this survivor? The source will go to the recycle bin.')) act(async () => { const result = await apiFetch(`/duplicates/merge/${module}`, { method: 'POST', body: { masterId: preview.masterId, mergeIds: [preview.sourceId] } }); if (result.mergedCount !== 1) throw new Error('Merge was not completed. Refresh and inspect both records.'); setPreview(null); setRevision(n => n + 1); }); }}>Merge into survivor</Button>}
    </section>}
  </div>;
}
function Integrations() {
  const { apiFetch, user, demoMode } = useAuth();
  const [revision, setRevision] = useState(0), [error, setError] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const loaded = useLoad('/sales-operations/integrations', revision);
  const act = async path => { setBusy(true); setError(''); setMessage(''); try { await apiFetch(path, { method: 'POST', body: {} }); setMessage(path.includes('retry') ? 'Delivery queued. Refresh to see its outcome.' : 'Sync completed.'); setRevision(n => n + 1); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  return <div className="space-y-3"><Button variant="secondary" onClick={() => setRevision(n => n + 1)}>Refresh status</Button><LoadState {...loaded} /><Problem message={error} />{message && <p role="status">{message}</p>}<p>{loaded.data?.note}</p>
    {loaded.data?.mailboxes.map(m => <section className={panel} key={m.id}><h2 className="font-bold">{m.name} · {m.status}</h2><p>Mail sync: {m.lastPolledAt ? new Date(m.lastPolledAt).toLocaleString() : 'Never'}</p><Problem message={m.lastError || m.calendarError} />
      {can(user, 'emails', 'edit') && <Button disabled={demoMode || busy} onClick={() => act(`/sales-mail/accounts/${m.id}/sync`)}>Retry mail sync</Button>}
      {m.calendarEnabled && <><p>Calendar sync: {m.calendarLastSyncedAt ? new Date(m.calendarLastSyncedAt).toLocaleString() : 'Never'}</p>{can(user, 'activities', 'edit') && can(user, 'emails', 'edit') && <Button variant="secondary" disabled={demoMode || busy} onClick={() => act(`/outlook-calendar/${m.id}/sync`)}>Retry calendar sync</Button>}</>}
    </section>)}
    {loaded.data?.indexing && <section className={panel}>Search indexing: {loaded.data.indexing.pending} pending · {loaded.data.indexing.failed} exhausted retries</section>}
    {loaded.data?.reconciliation && <section className={panel}><h2 className="font-bold">Mailbox reconciliation</h2><p>{loaded.data.reconciliation.unlinkedMessages} messages without a CRM link · {loaded.data.reconciliation.failedMessages} failed messages</p><Link module="mailbox">Review and associate messages</Link></section>}
    {loaded.data?.webhooks.map(w => <section className={panel} key={w.id}><h2 className="font-bold">{w.name} · {w.active ? 'Enabled' : 'Disabled'}</h2>{!w.logs.length && <p>No deliveries yet.</p>}{w.logs.map(l => <div className="flex flex-wrap gap-3 py-2" key={l.id}><span>{l.event} · {l.success ? 'Delivered' : 'Failed'} · HTTP {l.statusCode || 'No response'} · Attempt {l.attempts} · {new Date(l.createdAt).toLocaleString()}</span>
      {!l.success && w.active && can(user, 'settings', 'full') && <Button variant="secondary" disabled={demoMode || busy} onClick={() => act(`/sales-operations/webhooks/${w.id}/retry/${l.id}`)}>Retry delivery</Button>}</div>)}</section>)}
  </div>;
}
function Configuration() {
  const { apiFetch, demoMode } = useAuth();
  const [text, setText] = useState(''), [label, setLabel] = useState('Configuration import'), [preview, setPreview] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0), [message, setMessage] = useState('');
  const history = useLoad('/configuration-packages/history', revision);
  const act = async fn => { setBusy(true); setError(''); setMessage(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  return <div className="space-y-3"><p>Version and move workflow rules, validation rules and deal stage requirements. This replaces those configuration sets in this installation. Records, credentials and hosted environments are excluded.</p>
    <Button disabled={busy} onClick={() => act(async () => { const d = await apiFetch('/configuration-packages/export'); setText(JSON.stringify(d.bundle, null, 2)); setPreview(null); const blob = new Blob([JSON.stringify(d.bundle, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'sales-nebula-configuration.json'; a.click(); URL.revokeObjectURL(url); })}>Export current configuration</Button>
    <label className="block">Import configuration file<input className="block my-2" type="file" accept=".json,application/json" onChange={e => { const file = e.target.files?.[0]; if (file) act(async () => { if (file.size > 1000000) throw new Error('Use a file smaller than 1 MB'); setText(await file.text()); setPreview(null); }); }} /></label>
    <Input label="Revision label" value={label} onChange={setLabel} /><TextArea label="Configuration package JSON" value={text} onChange={v => { setText(v); setPreview(null); }} /><Problem message={error} />
    <Button disabled={busy || !text} onClick={() => act(async () => setPreview(await apiFetch('/configuration-packages/preview', { method: 'POST', body: { bundle: JSON.parse(text) } })))}>Validate and preview</Button>
    {preview && <section className={panel}><h2 className="font-bold">Proposed changes</h2>{!preview.changes.length && <p>No changes.</p>}{preview.changes.map((c, i) => <p key={i}>{c.action.toUpperCase()} · {c.type} · {c.name}</p>)}<Button disabled={demoMode || busy || !preview.changes.length} onClick={() => act(async () => { await apiFetch('/configuration-packages/apply', { method: 'POST', body: { bundle: JSON.parse(text), baseHash: preview.baseHash, bundleHash: preview.bundleHash, label } }); setPreview(null); setRevision(n => n + 1); setMessage('Configuration applied and previous version saved.'); })}>Apply reviewed changes</Button></section>}
    {message && <p role="status">{message}</p>}<LoadState {...history} /><h2 className="font-bold">Revision history</h2>
    {history.data?.map(r => <article className={panel} key={r.id}><p>{r.label} · {new Date(r.createdAt).toLocaleString()}</p><Button variant="secondary" disabled={busy} onClick={() => act(async () => { const d = await apiFetch(`/configuration-packages/history/${r.id}`); setText(JSON.stringify(d.bundle, null, 2)); setLabel(d.label); setPreview(null); setMessage('Previous version loaded. Validate and preview before restoring.'); })}>Load previous version</Button></article>)}
  </div>;
}
export function SalesOperationsPage() {
  const { user } = useAuth();
  const tabs = [
    ['daily', 'Daily workspace', Daily, true],
    ['accounts', 'Account 360', Account360, can(user, 'accounts', 'read')],
    ['coaching', 'Deal coaching', Coaching, can(user, 'deals', 'read')],
    ['renewals', 'Renewals', Renewals, can(user, 'contracts', 'read')],
    ['changes', 'Pipeline changes', Changes, can(user, 'deals', 'read')],
    ['quality', 'Data quality', Quality, ['contacts', 'leads', 'accounts'].some(m => can(user, m, 'read'))],
    ['integrations', 'Integration operations', Integrations, true],
    ['pricing', 'Pricing rules', PricingRules, can(user, 'products', 'full')],
    ['enterprise', 'Enterprise configuration', EnterpriseSettings, can(user, 'admin', 'full')],
    ['payments', 'Payments', PaymentsWorkspace, can(user,'invoices','read')],
    ['computed', 'Computed fields', ComputedFieldsWorkspace, can(user,'settings','read')],
    ['campaignDelivery', 'Campaign delivery', CampaignExecution, can(user,'campaigns','read')],
    ['dealRooms', 'Deal rooms', DealRoomsWorkspace, can(user,'deals','read')],
    ['success', 'Account success', SuccessWorkspace, can(user,'accounts','read')],
    ['configuration', 'Configuration versions', Configuration, can(user, 'admin', 'full')],
  ].filter(t => t[3]);
  const [tab, setTab] = useState('daily'), Component = tabs.find(t => t[0] === tab)?.[2] || Daily;
  return <div className="space-y-5"><h1 className="text-2xl font-bold">Sales Operations</h1><nav aria-label="Sales operations" className="flex flex-wrap gap-2">{tabs.map(([id, title]) => <Button key={id} variant={id === tab ? 'primary' : 'secondary'} onClick={() => setTab(id)}>{title}</Button>)}</nav><Component /></div>;
}
