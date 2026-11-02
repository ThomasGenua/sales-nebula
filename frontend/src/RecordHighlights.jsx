import React from 'react';
import { fmt, money } from './prefs';
import { Button } from './Controls';
export function calendarDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  // CRM date-only deadlines must not shift to yesterday in a western timezone.
  const [locale] = fmt();
  return new Date(String(value).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
export function fieldValue(field, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (field.type === 'date' || /^(closeDate|validUntil|expirationDate|nextStepDate)$/.test(field.key)) return calendarDate(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return typeof value === 'object' ? JSON.stringify(value) : value;
}
export default function RecordHighlights({ module, record, currency, onEdit }) {
  if (!['leads', 'deals', 'quotes'].includes(module)) return null;
  const status = record.stage || record.status;
  const totalKey = module === 'quotes' ? 'total' : module === 'deals' ? 'value' : 'score';
  const label = module === 'quotes' ? 'Quote total' : module === 'deals' ? 'Deal value' : 'Lead score';
  const deadline = module === 'quotes' ? record.validUntil : module === 'deals' ? record.closeDate : null;
  const advice = module === 'leads' ? (status === 'Qualified' ? 'Confirm the buyer and use Convert lead below to open the opportunity.' : 'Confirm the customer’s needs, then update qualification.') : module === 'quotes' ? (status === 'Accepted' ? 'Review delivery and payment next steps.' : status === 'Pending Approval' ? 'Review the approval decision before sharing this quote.' : 'Review line items and expiry, then use the quote actions below to share.') : (record.nextStep || (status?.startsWith('Closed') ? 'Review the customer handoff and final outcome.' : 'Add the next customer action and a due date.'));
  return <section aria-label="Record overview" className="grid sm:grid-cols-3 gap-3 mb-5">
    <div className="rounded-xl border p-4" style={{ borderColor: 'var(--sn-rule)', background: 'var(--sn-panel)' }}><p className="text-xs" style={{ color: 'var(--sn-slate)' }}>{label}</p><p className="text-2xl font-semibold mt-1 break-words">{record[totalKey] === undefined ? '—' : module === 'leads' ? record[totalKey] : currency ? money(record[totalKey], record.currency || currency, { maximumFractionDigits: 2 }) : Number(record[totalKey]).toLocaleString(...fmt())}</p>{status && <p className="text-sm mt-2">{status}</p>}</div>
    <div className="rounded-xl border p-4" style={{ borderColor: 'var(--sn-rule)', background: 'var(--sn-panel)' }}><p className="text-xs" style={{ color: 'var(--sn-slate)' }}>{module === 'quotes' ? 'Valid until' : module === 'deals' ? 'Expected close' : 'Company'}</p><p className="font-semibold mt-1 break-words">{module === 'leads' ? record.company || '—' : calendarDate(deadline)}</p>{record.nextStepDate && <p className="text-xs mt-2">Next action due {calendarDate(record.nextStepDate)}</p>}</div>
    <div className="rounded-xl border p-4" style={{ borderColor: 'var(--sn-rule)', background: 'var(--sn-raised)' }}><p className="text-xs" style={{ color: 'var(--sn-slate)' }}>Next action</p><p className="text-sm mt-1 break-words">{advice}</p>{onEdit && <Button variant="secondary" size="sm" className="mt-3" onClick={() => onEdit(record)}>Update record</Button>}</div>
  </section>;
}
