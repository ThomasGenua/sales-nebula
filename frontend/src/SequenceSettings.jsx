import React from 'react';
import { Input, Select } from './Controls';
const clock = minutes => String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
export function SequenceSettings({ form, setForm, disabled }) {
  const window = form.sendingWindow;
  const change = (key, value) => setForm(f => ({ ...f, sendingWindow: { ...f.sendingWindow, [key]: value } }));
  return <fieldset className="border border-[#182550] rounded-lg p-3 space-y-3"><legend>Sending controls</legend>
    <p className="text-xs">Use {'{{firstName}}'}, {'{{lastName}}'}, {'{{fullName}}'}, {'{{company}}'}, or {'{{email}}'} in an email. Missing values are left blank. Every email includes an unsubscribe link.</p>
    <label className="block"><input disabled={disabled} type="checkbox" checked={form.stopOnReply !== false} onChange={e => setForm(f => ({ ...f, stopOnReply: e.target.checked }))} /> Stop when a new message from the recipient is synced after sending</label>
    <label className="block"><input disabled={disabled} type="checkbox" checked={!!window} onChange={e => setForm(f => ({ ...f, sendingWindow: e.target.checked ? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', days: [1, 2, 3, 4, 5], start: 540, end: 1020 } : null }))} /> Send only during selected hours</label>
    {window && <><Input disabled={disabled} label="Sending time zone" value={window.timezone} onChange={v => change('timezone', v)} placeholder="America/Toronto" /><div className="flex flex-wrap gap-3">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => <label key={day}><input disabled={disabled} type="checkbox" checked={window.days.includes(i)} onChange={e => change('days', e.target.checked ? [...window.days, i] : window.days.filter(d => d !== i))} /> {day}</label>)}</div><div className="grid grid-cols-2 gap-3">{[['start', 'Start time'], ['end', 'End time']].map(([key, label]) => <Input disabled={disabled} key={key} label={label} type="time" value={clock(window[key])} onChange={v => { const [h, m] = v.split(':').map(Number); change(key, h * 60 + m); }} />)}</div></>}
  </fieldset>;
}
