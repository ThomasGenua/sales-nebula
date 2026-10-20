import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Input, Select } from './Controls';
import { useAuth, can } from './contexts';
import { panel, Problem } from './SalesWorkspace';

const OPERATOR_LABELS = {
  equals: 'equals', notEquals: 'does not equal', contains: 'contains', startsWith: 'starts with', endsWith: 'ends with',
  greaterThan: 'is greater than', lessThan: 'is less than', isEmpty: 'is empty', isNotEmpty: 'is not empty',
};
// The seed spells these two in snake case; the scoring takes either.
const CANONICAL = { is_empty: 'isEmpty', is_not_empty: 'isNotEmpty' };
const takesNoValue = operator => ['isEmpty', 'isNotEmpty'].includes(CANONICAL[operator] || operator);
const fieldLabel = field => field.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
const NEW_RULE = { name: '', field: 'company', operator: 'contains', value: '', points: 10, active: true };

function describe(rule) {
  const operator = CANONICAL[rule.operator] || rule.operator;
  const condition = `${fieldLabel(rule.field)} ${OPERATOR_LABELS[operator] || operator}${takesNoValue(operator) ? '' : ` "${rule.value}"`}`;
  return `If ${condition}: ${rule.points > 0 ? '+' : ''}${rule.points} points`;
}

/**
 * The lead scoring rules (services/leadScoring), which were managed through
 * the API alone. A lead starts at 50, gains or loses the points of each
 * active rule it matches, and stays between 0 and 100; it is scored whenever
 * it is saved. settings: read sees the rules, settings: full changes them.
 */
export function LeadScoringPage() {
  const { apiFetch, user } = useAuth();
  const canEdit = can(user, 'settings', 'full');
  const [rules, setRules] = useState(null);
  const [choices, setChoices] = useState({ fields: [], operators: [] });
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);

  const load = useCallback(() => apiFetch('/admin/scoring-rules')
    .then(r => { setRules(r.data || []); setChoices({ fields: r.fields || [], operators: r.operators || [] }); })
    .catch(e => setError(e.message)), [apiFetch]);
  useEffect(() => { load(); }, [load]);

  // Runs a change; true when it went through. A refusal is shown and the form kept.
  const act = async (fn, done) => {
    setBusy(true); setError(''); setNotice('');
    try { const result = await fn(); setNotice(typeof done === 'function' ? done(result) : done); await load(); return true; }
    catch (e) { setError(e.message); return false; }
    finally { setBusy(false); }
  };
  const update = (key, value) => setDraft(d => ({ ...d, [key]: value }));
  const save = async () => {
    const body = { name: draft.name.trim(), field: draft.field, operator: draft.operator, value: takesNoValue(draft.operator) ? '' : draft.value, points: Number(draft.points), active: draft.active };
    if (!body.name) return setError('Give the rule a name.');
    if (!Number.isInteger(body.points)) return setError('Points must be a whole number; a negative number takes points away.');
    const saved = await act(() => apiFetch(draft.id ? `/admin/scoring-rules/${draft.id}` : '/admin/scoring-rules', { method: draft.id ? 'PUT' : 'POST', body }), `Saved "${body.name}". Leads are scored by it when they are next saved; rescore the open leads to apply it now.`);
    if (saved) setDraft(null);
  };
  const remove = rule => window.confirm(`Delete the rule "${rule.name}"?`) && act(() => apiFetch(`/admin/scoring-rules/${rule.id}`, { method: 'DELETE' }), `Deleted "${rule.name}".`);
  const toggle = rule => act(() => apiFetch(`/admin/scoring-rules/${rule.id}`, { method: 'PUT', body: { active: !rule.active } }), `${rule.active ? 'Switched off' : 'Switched on'} "${rule.name}".`);
  const rescore = () => act(() => apiFetch('/admin/score-all-leads', { method: 'POST' }), r => `Rescored ${r.totalLeads} open lead${r.totalLeads === 1 ? '' : 's'}; ${r.updated} changed.`);

  const operatorOptions = choices.operators.map(op => ({ value: op, label: OPERATOR_LABELS[op] || op }));
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-lg sm:text-xl font-bold text-[#F0EDE5]">Lead Scoring</h1>
      {canEdit && <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => { setError(''); setDraft({ ...NEW_RULE }); }}>Add rule</Button><Button variant="secondary" disabled={busy} onClick={rescore}>Rescore open leads</Button></div>}
    </div>
    <p className="text-sm text-[#7E8598]">A lead starts at 50 and gains the points of each active rule it matches (negative points take them away), between 0 and 100. A lead is scored whenever it is saved; text is compared regardless of case.</p>
    <Problem message={error} />
    {notice && <p role="status" className="text-sm text-[#34D399]">{notice}</p>}
    {draft && <section className={panel} aria-label={draft.id ? 'Edit rule' : 'New rule'}>
      <h2 className="font-semibold mb-3">{draft.id ? 'Edit rule' : 'New rule'}</h2>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <Input label="Name" value={draft.name} onChange={v => update('name', v)} placeholder="Enterprise company" />
        <Select label="Field" value={draft.field} options={choices.fields.map(f => ({ value: f, label: fieldLabel(f) }))} onChange={v => update('field', v)} />
        <Select label="Condition" value={draft.operator} options={operatorOptions} onChange={v => update('operator', v)} />
        {!takesNoValue(draft.operator) && <Input label="Value" value={draft.value} onChange={v => update('value', v)} />}
        <Input label="Points" type="number" value={draft.points} onChange={v => update('points', v)} />
        <label className="flex items-center gap-2 text-sm text-[#C8C2B4] self-end min-h-[44px]"><input type="checkbox" checked={draft.active} onChange={e => update('active', e.target.checked)} /> Active</label>
      </div>
      <div className="flex gap-2 mt-3"><Button disabled={busy} onClick={save}>Save rule</Button><Button variant="ghost" disabled={busy} onClick={() => { setDraft(null); setError(''); }}>Cancel</Button></div>
    </section>}
    <section className={panel} aria-label="Scoring rules">
      {rules === null ? <p className="text-sm text-[#7E8598]">Loading…</p>
        : rules.length === 0 ? <p className="text-sm text-[#7E8598]">No rules yet. Without an active rule, leads keep the score they are given.</p>
        : <ul className="divide-y divide-[#182550]">{rules.map(rule => <li key={rule.id} className="py-3 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0"><div className="text-sm text-[#F0EDE5] flex items-center gap-2">{rule.name} {!rule.active && <Badge color="neutral">Off</Badge>}</div><div className="text-xs text-[#7E8598]">{describe(rule)}</div></div>
          {canEdit && <div className="flex gap-1">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setError(''); setDraft({ ...rule, operator: CANONICAL[rule.operator] || rule.operator }); }}>Edit</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => toggle(rule)}>{rule.active ? 'Switch off' : 'Switch on'}</Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => remove(rule)}>Delete</Button>
          </div>}
        </li>)}</ul>}
    </section>
  </div>;
}
