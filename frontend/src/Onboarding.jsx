import React, { useEffect, useState } from 'react';
import { CheckCircle2, Circle, ChevronRight } from 'lucide-react';
import { useAuth, can } from './contexts';
import { Button, Modal, Select } from './Controls';
import { measurementAllowed } from './marketing';

export default function Onboarding({ navigate, page }) {
  const { apiFetch, user } = useAuth();
  const [data, setData] = useState(null), [pipeline, setPipeline] = useState(null), [template, setTemplate] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = () => apiFetch('/onboarding').then(setData);
  useEffect(() => {
    let live = true;
    apiFetch('/onboarding/visit', { method: 'POST', body: { measurement: measurementAllowed() } }).then(() => apiFetch('/onboarding')).then(d => live && setData(d)).catch(e => live && setError(e.message));
    return () => { live = false; };
  }, [apiFetch, page]);
  const act = async fn => { setBusy(true); setError(''); try { await fn(); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  if (!Array.isArray(data?.steps)) return error ? <p role="alert" className="text-sm mb-3">Setup checklist: {error}</p> : null;
  const steps = data.steps.filter(s => s.available), done = steps.filter(s => s.done).length;
  if (!steps.length) return null;
  return <section className="mb-5 rounded-xl border p-4" style={{ borderColor: 'var(--sn-rule)', background: 'var(--sn-panel)' }} aria-label="Workspace setup">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="font-semibold">{data.complete ? 'You’re ready to sell' : 'Make Sales Nebula yours'}</h2><p className="text-xs mt-1" style={{ color: 'var(--sn-slate)' }}>{done} of {steps.length} setup steps complete · saved to your account</p></div>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => act(() => apiFetch('/onboarding/preferences', { method: 'POST', body: { dismissed: !data.dismissed } }))}>{data.dismissed ? 'Show setup' : 'Hide setup'}</Button>
    </div>
    {error && <p role="alert" className="mt-3 text-sm">{error}</p>}
    {!data.dismissed && <>
      <progress aria-label="Setup progress" max={steps.length} value={done} className="w-full h-1.5 mt-4 accent-amber-400" />
      <ol className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3 mt-4">{steps.map(step => <li key={step.id} className="rounded-lg p-3" style={{ background: 'var(--sn-raised)' }}>
        <div className="flex gap-2 items-start">{step.done ? <CheckCircle2 size={18} className="text-emerald-400 shrink-0" aria-label="Completed" /> : <Circle size={18} className="shrink-0" />}<div><h3 className="text-sm font-semibold">{step.label}</h3><p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--sn-slate)' }}>{step.detail}</p></div></div>
        <button type="button" disabled={busy} className="text-sm mt-2 min-h-11 inline-flex items-center gap-1 font-medium" style={{ color: 'var(--sn-amber-ink)' }} onClick={() => step.id === 'pipeline' ? act(async () => { setTemplate(''); setPipeline(await apiFetch('/onboarding/pipeline')); }) : navigate(step.module, null, step.id === 'deal' ? { stage: 'Qualification' } : undefined)}>{step.done ? 'Review' : 'Continue'}<ChevronRight size={15} /></button>
        {step.id === 'import' && <a className="block underline text-xs min-h-8" href="/templates/contacts.csv" download>Download contact CSV template</a>}
      </li>)}</ol>
      <label className="flex gap-2 text-xs mt-4 items-start" style={{ color: 'var(--sn-slate)' }}><input type="checkbox" checked={!data.analyticsOptOut} disabled={busy} onChange={e => act(() => apiFetch('/onboarding/preferences', { method: 'POST', body: { analyticsOptOut: !e.target.checked } }))} />Include my setup milestones and daily app use in team activation reporting. Daily usage expires after 30 days; browser privacy preferences take precedence.</label>
    </>}
    <Modal open={!!pipeline} title="Review your sales pipeline" onClose={() => setPipeline(null)}>
      {pipeline && <div className="space-y-4 text-sm">
        <p>{pipeline.stages.join(' → ')}</p>
        <p>Stage requirements apply to the whole team. Review the current requirements before choosing a template.</p>
        <Requirements value={pipeline.current} />
        {can(user, 'admin', 'full') && <><Select label="Pipeline template" value={template} placeholder="Keep current requirements" options={pipeline.templates.map(t => ({ value: t.id, label: t.name }))} onChange={setTemplate} />{template && <><p>{pipeline.templates.find(t => t.id === template)?.description}</p><Requirements value={pipeline.templates.find(t => t.id === template)?.requirements || {}} /><p className="text-xs">Applying this template replaces the stage requirements shown above.</p></>}</>}
        {error && <p role="alert">{error}</p>}
        <Button disabled={busy} onClick={() => act(async () => { await apiFetch('/onboarding/pipeline', { method: 'POST', body: template ? { template, baseHash: pipeline.baseHash } : {} }); setPipeline(null); })}>{template ? 'Apply template and finish setup' : 'Use current pipeline'}</Button>
      </div>}
    </Modal>
  </section>;
}
function Requirements({ value }) {
  const labels = { need: 'Customer need confirmed', budget: 'Budget qualified', authority: 'Decision-maker identified', timeline: 'Timeline confirmed', decisionProcess: 'Decision process confirmed', nextStep: 'Next action', nextStepDate: 'Next action due date', contactId: 'Primary contact' };
  return Object.keys(value).length ? <ul className="space-y-2">{Object.entries(value).map(([stage, fields]) => <li key={stage}><strong>{stage}:</strong> {fields.map(f => labels[f] || f).join(', ') || 'No required fields'}</li>)}</ul> : <p className="text-xs">No additional stage requirements.</p>;
}
