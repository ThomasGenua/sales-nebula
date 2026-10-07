import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Button, Input, Select, TextArea } from './Controls';
import { useAuth, can, RouteContext } from './contexts';
import { RecordPicker } from './SalesWorkflows';
import { panel, Problem, Pager, dateLabel, QuickActivity } from './SalesWorkspace';

export function RecordMailbox({ module, record }) {
  const { apiFetch, user } = useAuth(); const { navigate } = useContext(RouteContext);
  const [data, setData] = useState(null), [error, setError] = useState('');
  useEffect(() => { if (!can(user, 'emails', 'read')) return; const c = new AbortController(); apiFetch(`/sales-mail/messages?${module === 'deals' ? 'dealId' : 'contactId'}=${encodeURIComponent(record.id)}`, { signal: c.signal }).then(setData).catch(e => { if (!c.signal.aborted) setError(e.message); }); return () => c.abort(); }, [apiFetch, module, record.id, user]);
  if (!can(user, 'emails', 'read')) return null;
  return <section className={`${panel} mt-4`} aria-label="My mailbox conversations"><h2 className="font-semibold">My mailbox conversations</h2><p className="text-xs text-[#7E8598]">Email from your connected Outlook mailbox linked to this record.</p><Problem message={error} />{data?.data?.map(m => <button key={m.id} className="block text-left text-sm text-[#F5A623] py-2" onClick={() => navigate('mailbox', m.id)}>{m.subject || '(No subject)'} · {dateLabel(m.receivedAt)}</button>)}{data && !data.data.length && <p className="text-sm mt-2">No linked messages.</p>}{data?.total > data?.data.length && <p className="text-xs">Showing the latest {data.data.length} of {data.total}. Use Mailbox to search older messages.</p>}</section>;
}

export function MailboxPage() {
  const { apiFetch, user, demoMode } = useAuth(); const { recordId, navigate } = useContext(RouteContext);
  const [accounts, setAccounts] = useState(null), [data, setData] = useState(null), [thread, setThread] = useState(null);
  const [accountId, setAccountId] = useState(''), [search, setSearch] = useState(''), [unanswered, setUnanswered] = useState(false), [page, setPage] = useState(1), [revision, setRevision] = useState(0);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [reply, setReply] = useState(''), [links, setLinks] = useState({}), [target, setTarget] = useState(null);
  const connectedOnce = useRef(false); const editable = !demoMode && can(user, 'emails', 'edit');
  const loadAccounts = useCallback(() => apiFetch('/sales-mail/accounts').then(setAccounts), [apiFetch]);
  useEffect(() => { loadAccounts().catch(e => setError(e.message)); }, [loadAccounts]);
  const perform = async fn => { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  useEffect(() => {
    const q = new URLSearchParams(window.location.search), code = q.get('code'), state = q.get('state');
    if ((!code && !q.has('error')) || connectedOnce.current) return;
    connectedOnce.current = true;
    window.history.replaceState({}, '', window.location.pathname);
    if (q.has('error')) { setError(q.get('error_description') || 'Microsoft connection was cancelled.'); return; }
    setBusy(true);
    apiFetch('/sales-mail/connect', { method: 'POST', body: { code, state } }).then(() => { setNotice('Outlook connected. Sync your mailbox to import the last 30 days.'); return loadAccounts(); }).catch(e => setError(e.message)).finally(() => setBusy(false));
  }, [apiFetch, loadAccounts]);
  useEffect(() => {
    const c = new AbortController(); const q = new URLSearchParams({ page, search, unanswered, ...(accountId && { accountId }) });
    const timer = setTimeout(() => apiFetch(`/sales-mail/messages?${q}`, { signal: c.signal }).then(setData).catch(e => { if (!c.signal.aborted) setError(e.message); }), 200);
    return () => { c.abort(); clearTimeout(timer); };
  }, [apiFetch, page, search, accountId, unanswered, revision]);
  useEffect(() => {
    const c = new AbortController(); setReply(''); setThread(null);
    if (recordId) apiFetch(`/sales-mail/messages/${recordId}`, { signal: c.signal }).then(t => { setThread(t); setLinks({ contactId: t.message.contactId, dealId: t.message.dealId }); }).catch(e => { if (!c.signal.aborted) setError(e.message); });
    return () => c.abort();
  }, [apiFetch, recordId, revision]);
  const message = thread?.message;
  const replyTo = thread?.thread?.filter(m => m.direction === 'inbound' && m.externalId).at(-1);
  return <div className="space-y-4"><div><h1 className="text-xl font-bold">Mailbox</h1><p className="text-sm text-[#7E8598]">Your Outlook conversations, linked to the contacts and deals you work on. Imported messages are private to you.</p></div>
    <section className={`${panel} space-y-3`} aria-label="Outlook connections"><h2 className="font-semibold">Outlook connections</h2>{accounts && !accounts.configured && <p className="text-sm">An administrator needs to configure Microsoft client credentials and register <code className="break-all">{accounts.redirectUri}</code> as the web redirect address. Then connect your mailbox here.</p>}
      {accounts?.data?.map(a => <div key={a.id} className="flex flex-wrap justify-between gap-3 border-t border-[#182550] pt-3"><div><p>{a.mailboxAddress || a.name}</p><p className="text-xs text-[#7E8598]">{a.connected ? a.status : 'Disconnected'} · Last sync {dateLabel(a.lastPolledAt)}</p>{a.lastError && <Problem message={a.lastError} />}</div>{editable && <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={busy || !accounts.configured} onClick={() => perform(async () => { const d = await apiFetch(`/sales-mail/accounts/${a.id}/authorize`, { method: 'POST', body: {} }); window.location.assign(d.url); })}>{a.connected ? 'Reconnect' : 'Connect Outlook'}</Button>{a.connected && <><Button disabled={busy} onClick={() => perform(async () => { const d = await apiFetch(`/sales-mail/accounts/${a.id}/sync`, { method: 'POST', body: {} }); setNotice(d.skipped || `${d.imported} messages imported.${d.moreMayBeAvailable ? ' More may be available; sync again to continue.' : ''}`); setRevision(n => n + 1); await loadAccounts(); })}>Sync now</Button><Button variant="secondary" disabled={busy} onClick={() => perform(async () => { await apiFetch(`/sales-mail/accounts/${a.id}/disconnect`, { method: 'POST', body: {} }); await loadAccounts(); setNotice('Disconnected. Imported messages remain available.'); })}>Disconnect</Button></>}</div>}</div>)}
      {editable && <Button variant="secondary" disabled={busy || !accounts?.configured} onClick={() => perform(async () => { await apiFetch('/sales-mail/accounts', { method: 'POST', body: {} }); await loadAccounts(); })}>Add Outlook mailbox</Button>}
    </section><Problem message={error} />{notice && <p role="status">{notice}</p>}
    <div className="flex flex-wrap gap-3 items-end"><Input label="Search mail" value={search} onChange={v => { setSearch(v); setPage(1); }} /><Select label="Mailbox" value={accountId} options={(accounts?.data || []).map(a => ({ value: a.id, label: a.mailboxAddress || a.name }))} placeholder="All my mailboxes" onChange={v => { setAccountId(v); setPage(1); }} /><label className="flex gap-2 text-sm pb-2"><input type="checkbox" checked={unanswered} onChange={e => { setUnanswered(e.target.checked); setPage(1); }} />Needs a reply</label></div>
    <div className="grid lg:grid-cols-[22rem_1fr] gap-4"><section className={panel} aria-label="Messages">{data?.data?.map(m => <button key={m.id} className={`block w-full text-left border-b border-[#182550] py-3 ${m.id === recordId ? 'text-[#F5A623]' : ''}`} onClick={() => navigate('mailbox', m.id)}><span className="block font-semibold">{m.subject || '(No subject)'}</span><span className="block text-xs">{m.direction === 'outbound' ? `To ${m.toEmails}` : m.fromEmail} · {dateLabel(m.receivedAt)}</span><span className="block text-xs text-[#7E8598]">{m.direction === 'inbound' && !m.repliedAt ? 'Needs a reply' : m.status}{m.deal ? ` · ${m.deal.name}` : ''}</span></button>)}{data?.total === 0 && <p>No messages match. Sync a connected mailbox to get started.</p>}<Pager page={page} total={data?.total || 0} onChange={setPage} /></section>
      {thread ? <section className={`${panel} space-y-4`} aria-label="Conversation"><h2 className="font-semibold">{message.subject}</h2>{thread.total > thread.thread.length && <p className="text-xs">Showing the latest {thread.thread.length} of {thread.total} messages in this conversation.</p>}{thread.thread.map(m => <article key={m.id} className="border-b border-[#182550] pb-3"><p className="text-xs text-[#7E8598]">{m.direction === 'outbound' ? 'You' : m.fromName || m.fromEmail} · {dateLabel(m.receivedAt)}</p><p className="whitespace-pre-wrap text-sm mt-2 break-words">{m.textBody || m.snippet || 'No plain-text preview available.'}</p></article>)}
        {editable && replyTo && <form className="space-y-3" onSubmit={e => { e.preventDefault(); perform(async () => { await apiFetch(`/sales-mail/messages/${replyTo.id}/reply`, { method: 'POST', body: { body: reply } }); setReply(''); setNotice('Reply sent through Outlook.'); setRevision(n => n + 1); }); }}><TextArea label="Reply" value={reply} onChange={setReply} rows={5} /><Button type="submit" disabled={busy || !reply.trim()}>Send reply</Button></form>}
        {editable && <div className="space-y-3"><h3 className="font-semibold text-sm">Link this conversation</h3>{can(user, 'contacts', 'read') && <RecordPicker module="contacts" label="Contact" value={links.contactId} selected={message.contact} onChange={contactId => setLinks(l => ({ ...l, contactId }))} />}{can(user, 'deals', 'read') && <RecordPicker module="deals" label="Deal" value={links.dealId} selected={message.deal} onChange={dealId => setLinks(l => ({ ...l, dealId }))} />}<Button variant="secondary" disabled={busy} onClick={() => perform(async () => { await apiFetch(`/sales-mail/messages/${message.id}/links`, { method: 'PUT', body: links }); setRevision(n => n + 1); setNotice('Conversation links saved.'); })}>Save links</Button></div>}
        {can(user, 'activities', 'edit') && !demoMode && <Button variant="secondary" onClick={() => setTarget({ subject: `Follow up: ${message.subject}`, record: { contactId: message.contactId, dealId: message.dealId } })}>Schedule follow-up</Button>}
      </section> : <div className={panel}>Choose a message to read its conversation.</div>}
    </div>{target && <QuickActivity target={target} onClose={() => setTarget(null)} onSaved={() => setNotice('Follow-up scheduled in My Day.')} />}
  </div>;
}
