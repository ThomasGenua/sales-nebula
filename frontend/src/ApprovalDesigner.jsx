import React, { useEffect, useState } from 'react';
import { Button, Input, Select } from './Controls';
import { useAuth, can } from './contexts';
import { panel, Problem } from './SalesWorkspace';

export function ApprovalDesigner() {
  const { apiFetch, user } = useAuth();
  const [rows, setRows] = useState([]), [form, setForm] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const allowed = can(user, 'workflows', 'edit');
  const load = async () => setRows((await apiFetch('/approvals/processes')).data);
  useEffect(() => { if (allowed) load().catch(e => setError(e.message)); }, [apiFetch, allowed]);
  if (!allowed) return null;
  const set = (key, value) => setForm(f => ({ ...f, [key]: value }));
  return <details className={panel + ' mb-4'}><summary className="cursor-pointer font-semibold">Design approval processes</summary><Problem message={error} />
    <div className="my-3 flex flex-wrap gap-2"><Button onClick={() => setForm({ name: '', module: 'quotes', active: true, entryConditions: [], finalApprovalAction: 'none', finalRejectionAction: 'none', steps: [{ name: 'Manager review', approverType: 'manager' }] })}>New process</Button>{rows.map(r => <Button variant="secondary" key={r.id} onClick={() => setForm(r)}>{r.name}</Button>)}</div>
    {form && <form className="space-y-3" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { setForm(await apiFetch('/approvals/processes' + (form.id ? '/' + form.id : ''), { method: form.id ? 'PUT' : 'POST', body: { ...form, steps: form.steps.map((s, i) => ({ ...s, stepOrder: i + 1 })) } })); await load(); } catch (err) { setError(err.message); } finally { setBusy(false); } }}>
      <Input label="Process name" required value={form.name} onChange={v => set('name', v)} /><Select label="Approval module" value={form.module} options={['quotes', 'deals', 'invoices', 'contracts', 'orders']} onChange={v => set('module', v)} />
      <label className="block"><input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} /> Active</label>
      <h3>Entry conditions (all must match)</h3>{(form.entryConditions || []).map((c, i) => <div key={i} className="grid sm:grid-cols-4 gap-2"><Input label="Condition field" value={c.field} onChange={v => set('entryConditions', form.entryConditions.map((r, j) => i === j ? { ...r, field: v } : r))} /><Select label="Condition operator" value={c.operator} options={['equals', 'notEquals', 'gt', 'lt', 'contains']} onChange={v => set('entryConditions', form.entryConditions.map((r, j) => i === j ? { ...r, operator: v } : r))} /><Input label="Condition value" value={c.value} onChange={v => set('entryConditions', form.entryConditions.map((r, j) => i === j ? { ...r, value: v } : r))} /><Button variant="danger" onClick={() => set('entryConditions', form.entryConditions.filter((_, j) => i !== j))}>Remove condition</Button></div>)}
      <Button variant="secondary" onClick={() => set('entryConditions', [...(form.entryConditions || []), { field: 'total', operator: 'gt', value: '0' }])}>Add condition</Button>
      <h3>Review steps, in order</h3>{form.steps.map((s, i) => <div key={i} className="grid sm:grid-cols-4 gap-2"><Input label={'Step ' + (i + 1) + ' name'} value={s.name} onChange={v => set('steps', form.steps.map((r, j) => i === j ? { ...r, name: v } : r))} /><Select label="Approver type" value={s.approverType} options={['manager', 'user', 'role', 'queue']} onChange={v => set('steps', form.steps.map((r, j) => i === j ? { ...r, approverType: v, approverId: null } : r))} />{s.approverType !== 'manager' && <Input label="Approver ID" value={s.approverId || ''} onChange={v => set('steps', form.steps.map((r, j) => i === j ? { ...r, approverId: v } : r))} />}<Button variant="danger" onClick={() => set('steps', form.steps.filter((_, j) => i !== j))}>Remove step</Button></div>)}
      <Button variant="secondary" onClick={() => set('steps', [...form.steps, { name: 'Review', approverType: 'manager' }])}>Add review step</Button>
      {['Approval', 'Rejection'].map(kind => { const action = 'final' + kind + 'Action', config = 'final' + kind + 'Config'; return <div key={kind}><Select label={'After ' + kind.toLowerCase()} value={form[action] || 'none'} options={['none', 'updateField']} onChange={v => set(action, v)} />{form[action] === 'updateField' && <div className="grid sm:grid-cols-2 gap-2"><Input label="Update field" value={form[config]?.field || ''} onChange={v => set(config, { ...form[config], field: v })} /><Input label="Update value" value={form[config]?.value ?? ''} onChange={v => set(config, { ...form[config], value: v })} /></div>}</div>; })}
      <Button type="submit" disabled={busy || !form.steps.length}>Save process</Button>
    </form>}
  </details>;
}
