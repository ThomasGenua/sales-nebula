import React, { useEffect, useState } from 'react';
import { Button, Input } from './Controls';
import { useAuth, can } from './contexts';
export function QuoteSharing({ record }) {
  const { apiFetch, user, demoMode } = useAuth();
  const [shares, setShares] = useState([]), [url, setUrl] = useState(''), [days, setDays] = useState(14), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const load = () => apiFetch('/quotes/' + record.id + '/shares').then(setShares);
  useEffect(() => { load().catch(e => setMessage(e.message)); }, [apiFetch, record.id]);
  const run = async fn => { setBusy(true); setMessage(''); try { await fn(); } catch (e) { setMessage(e.message); } finally { setBusy(false); } };
  const editable = !demoMode && can(user, 'quotes', 'edit');
  return <section className="mt-4 border border-[#182550] rounded-lg p-4 space-y-3" aria-label="Customer quote sharing"><h2 className="font-semibold">Customer quote</h2><Button variant="secondary" disabled={busy} onClick={() => run(async () => { const file = await apiFetch('/quotes/' + record.id + '/pdf?format=download'); const link = URL.createObjectURL(new Blob([Uint8Array.from(atob(file.data), c => c.charCodeAt(0))], { type: 'application/pdf' })); const a = document.createElement('a'); a.href = link; a.download = file.filename; a.click(); setTimeout(() => URL.revokeObjectURL(link), 1000); })}>Download quote PDF</Button>
    {editable && !['Accepted', 'Rejected'].includes(record.status) && <><p className="text-sm">Anyone with the link can view and accept this version of the quote. Editing the quote invalidates links that have not been accepted.</p><Input label="Link expires after (days)" type="number" min="1" max="90" value={days} onChange={v => setDays(Number(v))} /><Button disabled={busy} onClick={() => run(async () => { const share = await apiFetch('/quotes/' + record.id + '/shares', { method: 'POST', body: { days } }); setUrl(share.url); await load(); })}>Create customer link</Button></>}
    {url && <div><Input label="Customer link — copy and share" value={url} readOnly /><Button variant="secondary" onClick={() => run(async () => { await navigator.clipboard.writeText(url); setMessage('Link copied.'); })}>Copy link</Button></div>}
    {shares.map(s => <div key={s.id} className="border-t border-[#182550] pt-2 text-sm"><p>{s.revokedAt ? 'Revoked' : s.acceptedAt ? 'Accepted by ' + s.acceptedName + ' (' + s.acceptedEmail + ') on ' + new Date(s.acceptedAt).toLocaleString() : 'Expires ' + new Date(s.expiresAt).toLocaleString()}</p>{editable && !s.revokedAt && <Button variant="secondary" disabled={busy} onClick={() => run(async () => { await apiFetch('/quotes/' + record.id + '/shares/' + s.id, { method: 'DELETE' }); setUrl(''); await load(); })}>Revoke link</Button>}</div>)}
    {message && <p role="status">{message}</p>}
  </section>;
}
