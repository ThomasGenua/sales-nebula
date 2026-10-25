import React, { useState } from 'react';
import { Select, Button } from './Controls';
export function CadenceControls({
  step,
  index,
  steps,
  update,
  disabled
}) {
  return <div className="space-y-2"><Select label={`Step ${index + 1} channel`} value={step.type || 'email'} options={['email', 'call', 'linkedin', 'task']} onChange={v => update(index, 'type', v)} disabled={disabled} />
    <details><summary>Outcome branches</summary><p className="text-xs">Step numbers refer to the current order. Only forward branches are allowed.</p>{['connected', 'no_answer', 'interested', 'not_interested', 'completed', 'converted', 'replied'].map(outcome => <Select key={outcome} label={outcome.replaceAll('_', ' ')} value={step.branches?.[outcome] ?? ''} options={[{
        value: '',
        label: 'Continue normally'
      }, {
        value: 'end',
        label: 'End cadence'
      }, ...steps.map((_, i) => ({
        value: String(i),
        label: `Step ${i + 1}`
      })).filter((_, i) => i > index)]} onChange={v => {
        const branches = {
          ...step.branches
        };
        if (v === '') delete branches[outcome];else branches[outcome] = v === 'end' ? v : Number(v);
        update(index, 'branches', branches);
      }} disabled={disabled} />)}</details></div>;
}
export function CadenceOutcome({
  enrollment,
  sequenceId,
  apiFetch,
  onDone
}) {
  const [outcome, setOutcome] = useState('completed'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const step = enrollment.stepSnapshot?.[enrollment.currentStep];
  if (enrollment.status !== 'Active' || !step?.type || step.type === 'email') return null;
  return <div className="flex flex-wrap gap-2 items-end"><Select label="Task outcome" value={outcome} options={['connected', 'no_answer', 'interested', 'not_interested', 'completed', 'converted']} onChange={setOutcome} /><Button disabled={busy} onClick={async () => {
      setBusy(true);
      setError('');
      try {
        await apiFetch(`/sequences/${sequenceId}/enrollments/${enrollment.id}/outcome`, {
          method: 'POST',
          body: {
            outcome
          }
        });
        await onDone();
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    }}>Complete cadence task</Button>{error && <p role="alert">{error}</p>}</div>;
}
