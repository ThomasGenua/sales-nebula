import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Mail, RefreshCw } from 'lucide-react';

const KEY = 'sn_access_status';
export function rememberStatus(token) {
  try { sessionStorage.setItem(KEY, token); } catch { /* The emailed link remains usable. */ }
}

export function ResendVerification({ email = '' }) {
  const [address, setAddress] = useState(email);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [until, setUntil] = useState(0);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!until) return;
    const update = () => setSeconds(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    update(); const timer = setInterval(update, 1000); return () => clearInterval(timer);
  }, [until]);
  async function submit(e) {
    e.preventDefault(); if (busy || seconds) return;
    setBusy(true); setMessage('');
    try {
      const res = await fetch('/api/signup/resend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: address.trim() }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Please try again later.');
      setMessage(data.message); setUntil(Date.now() + 60000);
    } catch (error) { setMessage(error.message || 'Could not reach the server.'); }
    finally { setBusy(false); }
  }
  return <form className="sn-follow-form" onSubmit={submit} aria-label="Resend verification">
    <label>Email for verification<input type="email" required autoComplete="email" maxLength={254} value={address} onChange={e => setAddress(e.target.value)} /></label>
    <button type="submit" className="sn-site-button sn-site-button-outline" disabled={busy || seconds > 0}>{busy ? 'Sending…' : seconds ? `Resend in ${seconds}s` : 'Resend verification email'}</button>
    <p role="status">{message}</p>
  </form>;
}

const states = {
  Pending: ['Confirm your email.', 'Your request is saved. Follow the verification link in your inbox before an administrator can review it.'],
  Verified: ['Your request is in review.', 'Your email is confirmed. An administrator will review your request and email an invitation if it is approved.'],
  Approved: ['Your invitation is ready.', 'Open the invitation email to choose your password and enter your workspace.'],
  Rejected: ['This request was not approved.', 'This request is closed. You can submit a new request if your needs have changed.'],
  Converted: ['Your account is ready.', 'You have accepted your invitation. Sign in to continue in your workspace.'],
};

export default function AccessStatusPage({ go }) {
  const [token, setToken] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState('');
  const activeRequest = useRef(0);
  useEffect(() => {
    const readLink = () => {
      const fromLink = new URLSearchParams(location.hash.slice(1)).get('token');
      if (fromLink) { rememberStatus(fromLink); history.replaceState({}, '', location.pathname); }
      let saved = ''; try { saved = sessionStorage.getItem(KEY) || ''; } catch { /* No saved proof. */ }
      const value = fromLink || saved;
      setToken(value); setData(null);
      if (value) refresh(value);
    };
    readLink(); window.addEventListener('hashchange', readLink);
    return () => { window.removeEventListener('hashchange', readLink); activeRequest.current++; };
  }, []);
  async function refresh(value = token) {
    if (!value) return;
    const current = ++activeRequest.current;
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/signup/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: value }) });
      const result = await res.json();
      if (current !== activeRequest.current) return;
      if (!res.ok) { if (res.status === 401) { setToken(''); setData(null); try { sessionStorage.removeItem(KEY); } catch {} } throw new Error(result.error || 'Could not refresh your status.'); }
      setData(result);
    } catch (e) { if (current === activeRequest.current) setError(e.message); }
    finally { if (current === activeRequest.current) setBusy(false); }
  }
  async function sendLink(e) {
    e.preventDefault(); if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const res = await fetch('/api/signup/status/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.trim() }) });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Please try again later.');
      setNotice(result.message);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  const [title, copy] = states[data?.status] || ['Your access request.', 'Use the private link from your email to check your request.'];
  return <main className="sn-site sn-status-page"><div className="sn-site-container"><a href="/" onClick={e => { e.preventDefault(); go('/'); }} className="sn-text-link">← Back to Sales Nebula</a><div className="sn-status-card"><Mail size={28} aria-hidden="true" /><h1>{token && busy && !data ? 'Checking your request…' : title}</h1><p>{copy}</p>
    {error && <p role="alert" className="sn-form-error">{error}</p>}
    {data && token ? <>
      <ol className="sn-status-steps">{['Request received', 'Email verified', 'Approved', 'Account ready'].map((label, i) => {
        const complete = i === 0 || i === 1 && data.verified || i === 2 && ['Approved', 'Converted'].includes(data.status) || i === 3 && data.status === 'Converted';
        return <li key={label}><CheckCircle2 size={18} aria-hidden="true" style={{ opacity: complete ? 1 : .3 }} />{label}<span className="sn-visually-hidden">: {complete ? 'complete' : 'not completed'}</span></li>;
      })}</ol>
      {data.status === 'Approved' && (!data.invite || data.invite.expired || data.invite.status !== 'Pending') && <p>Your invitation is no longer pending or has expired. Contact the administrator who sent it for a new invitation.</p>}
      <button type="button" className="sn-site-button sn-site-button-outline" disabled={busy} onClick={() => refresh()}><RefreshCw size={16} aria-hidden="true" />{busy ? 'Checking…' : 'Refresh status'}</button>
      {data.status === 'Converted' && <a href="/login" className="sn-site-button">Sign in</a>}
      {data.status === 'Rejected' && <a href="/#access" className="sn-text-link">Submit a new request</a>}
      {data.status === 'Pending' && <ResendVerification />}
    </> : <form onSubmit={sendLink} className="sn-follow-form" aria-label="Email a status link"><label>Request email<input type="email" required autoComplete="email" maxLength={254} value={email} onChange={e => setEmail(e.target.value)} /></label><button type="submit" className="sn-site-button" disabled={busy}>{busy ? 'Sending…' : 'Email my status link'}</button><p role="status">{notice}</p></form>}
    <a href="/demo" className="sn-text-link">Explore the demo while you wait →</a>
  </div></div></main>;
}
