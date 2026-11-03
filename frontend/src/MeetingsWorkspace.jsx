import React, { useEffect, useState } from 'react';
import { useAuth, can } from './contexts';
import { Button, Input, Select, TextArea, Modal } from './Controls';
import { RecordPicker } from './SalesWorkflows';
import { panel, Problem } from './SalesWorkspace';
export function MeetingsWorkspace() {
  const { apiFetch, user, demoMode } = useAuth();
  const [config, setConfig] = useState(null), [list, setList] = useState([]), [meeting, setMeeting] = useState(null);
  const [title, setTitle] = useState(''), [mode, setMode] = useState('transcript'), [transcript, setTranscript] = useState(''), [audio, setAudio] = useState(null), [dealId, setDealId] = useState(null), [contactId, setContactId] = useState(null), [consent, setConsent] = useState(false);
  const [tasks, setTasks] = useState([]), [nextStep, setNextStep] = useState(''), [nextStepDate, setNextStepDate] = useState(''), [applyNext, setApplyNext] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState(''), [deleting, setDeleting] = useState(false);
  const editable = !demoMode && can(user, 'activities', 'edit');
  const act = async fn => { setBusy(true); setError(''); setMessage(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const refresh = () => apiFetch('/meetings').then(r => setList(r.data));
  const load = async id => { const data = await apiFetch('/meetings/' + id); setMeeting(data); return data; };
  useEffect(() => { Promise.all([apiFetch('/meetings/config').then(setConfig), refresh()]).catch(e => setError(e.message)); }, [apiFetch]);
  useEffect(() => {
    const draft = meeting?.job.suggestions;
    setTasks((draft?.tasks || []).map(t => ({ ...t, selected: false }))); setNextStep(draft?.nextStep || ''); setNextStepDate(draft?.nextStepDate || ''); setApplyNext(false);
  }, [meeting?.recording.id, meeting?.job.status, meeting?.job.suggestions]);
  useEffect(() => {
    if (!['Queued', 'Transcribing', 'Analyzing'].includes(meeting?.job.status)) return;
    const timer = setInterval(() => load(meeting.recording.id).catch(e => setError(e.message)), 3000);
    return () => clearInterval(timer);
  }, [meeting?.recording.id, meeting?.job.status]);
  return <div className="space-y-4"><h2 className="text-xl font-bold">Turn meetings into follow-through</h2><p>Deepgram transcribes recordings. Claude drafts a summary and follow-ups. Review and edit every proposed CRM change before applying it.</p><Problem message={error} />{message && <p role="status">{message}</p>}
    {config && (!config.summaries || !config.transcription) && <p className={panel}>Provider setup: {config.summaries ? 'Claude summaries ready.' : 'Configure ANTHROPIC_API_KEY for summaries.'} {config.transcription ? 'Deepgram transcription ready.' : 'Configure DEEPGRAM_API_KEY for audio transcription; you can use a transcript once summaries are configured.'}</p>}
    <details className={panel} open={!meeting}><summary className="font-semibold cursor-pointer">Add a meeting</summary><div className="space-y-3 mt-3">
      <Input label="Meeting title" value={title} onChange={setTitle} /><Select label="Meeting source" value={mode} onChange={setMode} options={[{ value: 'transcript', label: 'Paste a transcript' }, { value: 'audio', label: 'Upload a recording' }]} />
      {mode === 'transcript' ? <TextArea label="Meeting transcript" value={transcript} onChange={setTranscript} rows={8} /> : <label className="block">Recording (MP3, WAV, M4A, Ogg, FLAC or WebM; up to 100 MB)<input className="block mt-2 max-w-full" type="file" accept="audio/*,video/webm,video/mp4" onChange={e => setAudio(e.target.files?.[0] || null)} /></label>}
      <div className="grid md:grid-cols-2 gap-3">{can(user, 'deals', 'read') && <RecordPicker module="deals" label="Linked deal (optional)" value={dealId} onChange={setDealId} />}{can(user, 'contacts', 'read') && <RecordPicker module="contacts" label="Linked contact (optional)" value={contactId} onChange={setContactId} />}</div>
      <label className="flex items-start gap-2"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I have permission to record and process this meeting with the configured providers.</label><p className="text-sm">Audio is deleted after transcription. Failed uploads expire after 24 hours. Transcripts and drafts remain until you delete the meeting.</p>
      <Button disabled={!editable || busy || !title.trim() || !consent || !config?.summaries || (mode === 'audio' ? !audio || !config.transcription : !transcript.trim())} onClick={() => act(async () => {
        if (audio && mode === 'audio' && audio.size > 100 * 1024 * 1024) throw new Error('Recordings must be no larger than 100 MB');
        const body = new FormData(); body.set('title', title); body.set('consent', 'true'); if (dealId) body.set('dealId', dealId); if (contactId) body.set('contactId', contactId); if (mode === 'audio') body.set('audio', audio); else body.set('transcript', transcript);
        const row = await apiFetch('/meetings', { method: 'POST', body }); await load(row.id); await refresh();
      })}>Create meeting draft</Button>
    </div></details>
    <Select label="Recent meetings" value={meeting?.recording.id || ''} placeholder="Choose a meeting" options={list.map(r => ({ value: r.recordingId, label: `${r.title || 'Meeting'} · ${r.status}` }))} onChange={id => act(() => load(id))} />
    {meeting && <section className={`${panel} space-y-4`}><div className="flex justify-between flex-wrap gap-2"><h3 className="font-bold">{meeting.recording.title} · <span role="status">{meeting.job.status}</span></h3><Button variant="secondary" disabled={busy} onClick={() => act(async () => { await load(meeting.recording.id); await refresh(); })}>Refresh meeting</Button></div>
      <Problem message={meeting.job.error} />{['Queued', 'Transcribing', 'Analyzing'].includes(meeting.job.status) && <p>Processing is saved in the background. You can leave this page and return later.</p>}
      {meeting.recording.summary && <div><h4 className="font-semibold">Draft summary</h4><p className="whitespace-pre-wrap mt-2">{meeting.recording.summary}</p></div>}
      {meeting.job.status === 'Ready' && <div className="space-y-3"><h4 className="font-semibold">Review proposed changes</h4><p>Only checked items will be applied. Tasks will be assigned to you.</p>
        {tasks.map((t, i) => <div key={i} className="grid sm:grid-cols-[auto_1fr_170px] gap-2 items-center"><input aria-label={`Create task ${i + 1}`} type="checkbox" checked={t.selected} onChange={e => setTasks(ts => ts.map((v, n) => n === i ? { ...v, selected: e.target.checked } : v))} /><Input label={`Task ${i + 1}`} value={t.subject} onChange={v => setTasks(ts => ts.map((t, n) => n === i ? { ...t, subject: v } : t))} /><Input label={`Task ${i + 1} due date`} type="date" value={t.dueDate || ''} onChange={v => setTasks(ts => ts.map((t, n) => n === i ? { ...t, dueDate: v } : t))} /></div>)}
        {!tasks.length && <p>No tasks were proposed.</p>}
        {meeting.recording.dealId && <div className="space-y-2 border-t border-slate-700 pt-3"><label className="flex gap-2 items-center"><input type="checkbox" checked={applyNext} disabled={!can(user, 'deals', 'edit')} onChange={e => setApplyNext(e.target.checked)} />Update the linked deal’s next step</label><TextArea label="Proposed deal next step" value={nextStep} onChange={setNextStep} /><Input label="Next step date" type="date" value={nextStepDate} onChange={setNextStepDate} /></div>}
        <Button disabled={!editable || busy || (!tasks.some(t => t.selected) && !applyNext)} onClick={() => act(async () => { const r = await apiFetch(`/meetings/${meeting.recording.id}/apply`, { method: 'POST', body: { tasks: tasks.filter(t => t.selected).map(({ subject, dueDate }) => ({ subject, dueDate: dueDate || null })), applyNextStep: applyNext, nextStep, nextStepDate: nextStepDate || null } }); await load(meeting.recording.id); await refresh(); setMessage(r.alreadyApplied ? 'This draft was already applied.' : `${r.taskIds.length} tasks created${r.nextStepUpdated ? ' and deal next step updated' : ''}.`); })}>Apply selected changes</Button>
      </div>}
      {meeting.job.status === 'Applied' && <p>Reviewed changes were applied on {new Date(meeting.job.reviewedAt).toLocaleString()}. Reopening this meeting will not create duplicate tasks.</p>}
      {meeting.recording.transcription && <details><summary className="cursor-pointer font-semibold">Read transcript</summary>{meeting.job.segments?.length ? <div className="max-h-96 overflow-auto space-y-2 mt-3">{meeting.job.segments.map((s, i) => <p key={i}><span className="text-slate-400">{Math.floor(s.start / 60)}:{String(Math.floor(s.start % 60)).padStart(2, '0')} · Speaker {s.speaker + 1}</span> {s.text}</p>)}</div> : <p className="whitespace-pre-wrap max-h-96 overflow-auto mt-2">{meeting.recording.transcription}</p>}</details>}
      <div className="flex flex-wrap gap-2">{['Failed', 'Ready'].includes(meeting.job.status) && <Button variant="secondary" disabled={!editable || busy || (!meeting.recording.transcription && !meeting.job.hasAudio)} onClick={() => act(async () => { await apiFetch(`/meetings/${meeting.recording.id}/retry`, { method: 'POST' }); await load(meeting.recording.id); })}>{meeting.recording.transcription ? 'Regenerate draft' : 'Retry transcription (provider charges may apply)'}</Button>}<Button variant="danger" disabled={!editable || busy || ['Transcribing', 'Analyzing'].includes(meeting.job.status)} onClick={() => setDeleting(true)}>Delete meeting</Button></div>
    </section>}
    <Modal open={deleting} onClose={() => !busy && setDeleting(false)} title="Delete this meeting?"><p className="mb-4">This deletes the recording, transcript and draft. Tasks and deal changes already applied remain in the CRM.</p><Problem message={error} /><Button variant="danger" disabled={busy} onClick={() => act(async () => { await apiFetch(`/meetings/${meeting.recording.id}`, { method: 'DELETE' }); setMeeting(null); setDeleting(false); await refresh(); setMessage('Meeting deleted.'); })}>Delete meeting and transcript</Button></Modal>
  </div>;
}
