import React, { useEffect, useState } from 'react';
import { useAuth } from './contexts';
import { Button } from './Controls';

export function MailboxPush({ account, editable }) {
  const { apiFetch } = useAuth();
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const path = `/sales-mail/accounts/${account.id}/push`;
  const load = () => apiFetch(path).then(setData);
  useEffect(() => { load().catch(e => setError(e.message)); }, [apiFetch, account.id, account.connected]);
  return <div className="text-xs space-y-2 mt-2"><p>{data?.enabled ? 'Live updates enabled · polling also checks for missed mail.' : 'Live updates are off. Scheduled polling still runs.'}</p>{data?.lastNotifiedAt && <p>Last notification: {new Date(data.lastNotifiedAt).toLocaleString()}</p>}{(error || data?.lastError) && <p role="alert">{error || data.lastError}</p>}{editable && account.connected && <Button size="sm" variant="secondary" disabled={busy || !data || !data.enabled && !data.configured} onClick={async () => { setBusy(true); setError(''); try { await apiFetch(path, { method: 'POST', body: { enabled: !data.enabled } }); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); } }}>{busy ? 'Updating…' : data?.enabled ? 'Disable live updates' : 'Enable live updates'}</Button>}{data && !data.configured && <p>An administrator must configure provider notifications before enabling live updates.</p>}</div>;
}

export function MessageAttachments({ message }) {
  const { apiFetch, demoMode } = useAuth();
  const [files, setFiles] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const path = `/sales-mail/messages/${message.id}/attachments`;
  if (demoMode || !message.externalId) return null;
  const run = async fn => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  return <div className="mt-3 space-y-2"><Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => setFiles((await apiFetch(path)).data))}>View attachments</Button>{error && <p role="alert" className="text-xs">{error}</p>}{files?.length === 0 && <p className="text-xs">No downloadable file attachments.</p>}{files?.map(file => <div key={file.id} className="flex flex-wrap gap-2 text-sm items-center"><span className="break-all">{file.name} · {Math.ceil(file.size / 1024)} KB</span><Button variant="secondary" size="sm" disabled={busy || !file.downloadable} onClick={() => run(async () => { const blob = await apiFetch(`${path}/${encodeURIComponent(file.id)}`, { responseType: 'blob' }); const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); })}>{file.downloadable ? 'Download' : 'Open in your email provider (over 20 MB)'}</Button></div>)}</div>;
}
