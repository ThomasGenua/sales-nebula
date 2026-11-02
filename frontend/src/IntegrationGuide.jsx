import React, { useContext, useState } from 'react';
import { RouteContext, useAuth } from './contexts';
import { Button } from './Controls';

export default function IntegrationGuide({ data, refresh, selectTab }) {
  const { apiFetch, demoMode } = useAuth(), { navigate } = useContext(RouteContext);
  const [busy, setBusy] = useState(''), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [checks, setChecks] = useState({});
  const run = async (key, path, body = {}) => {
    setBusy(key); setError(''); setMessage('');
    try { const result = await apiFetch(path, { method: 'POST', body }); if (result.connected && result.checkedAt) setChecks(current => ({ ...current, [key]: result.checkedAt })); setMessage(result.message || (result.quoteChanged ? 'Status updated. The quote has changed since it was sent; review the current version.' : 'Status refreshed.')); refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  if (!data) return null;
  return <div className="space-y-5">
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}{message && <p role="status" className="text-sm">{message}</p>}
    <section className="rounded-xl border p-4" style={{ borderColor: 'var(--sn-rule)' }}><h2 className="font-semibold">Needs attention</h2><p className="text-xs mt-1 mb-4" style={{ color: 'var(--sn-slate)' }}>Pending outcomes and failures across your accessible records. Up to 50 per payment, signature or campaign category. Review uncertain sends before retrying.</p>
      {!data.failures?.items.length && <p className="text-sm">No pending outcomes or failures in the records you can access.</p>}
      <div className="space-y-3">{data.failures?.items.map(item => <article className="rounded-lg p-3" key={item.key} style={{ background: 'var(--sn-raised)' }}><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><p className="text-xs" style={{ color: 'var(--sn-slate)' }}>{item.kind}{item.at && ` · ${new Date(item.at).toLocaleString()}`}</p><h3 className="font-semibold text-sm mt-1 break-words">{item.title}</h3><p className="text-xs mt-1 break-words">{item.detail}</p></div><div className="flex flex-wrap gap-2">
        {item.action && <Button disabled={demoMode || !!busy} size="sm" onClick={() => run(item.key, item.action.path, item.action.body)}>{busy === item.key ? 'Checking…' : item.action.label}</Button>}
        <Button variant="secondary" size="sm" onClick={() => item.tab ? selectTab(item.tab) : navigate(item.module, item.recordId)}>Review</Button></div></div></article>)}</div>
    </section>
    {!!data.setup?.length && <section><h2 className="font-semibold mb-3">Connection setup</h2><div className="grid md:grid-cols-2 gap-3">{data.setup.map(provider => <details className="border rounded-xl p-4" key={provider.id} style={{ borderColor: 'var(--sn-rule)' }}><summary className="cursor-pointer text-sm font-semibold">{provider.name}<span className="block text-xs font-normal mt-1" style={{ color: 'var(--sn-slate)' }}>{checks[provider.id] ? `Connection checked ${new Date(checks[provider.id]).toLocaleTimeString()}` : provider.configured ? 'Configured · connection not yet verified here' : 'Setup needed'}</span></summary><div className="space-y-3 mt-4 text-sm">
      {!!provider.missing.length && <p className="text-xs break-words">Missing deployment settings: {provider.missing.join(', ')}</p>}
      {provider.warning && <p role="status" className="text-amber-300">{provider.warning}</p>}
      <ol className="list-decimal pl-5 space-y-2 break-words">{provider.steps.map(step => <li key={step}>{step}</li>)}</ol>
      {provider.check && <Button variant="secondary" disabled={demoMode || !!busy} onClick={() => run(provider.id, `/sales-operations/integrations/${provider.id}/check`)}>{busy === provider.id ? 'Checking…' : 'Check connection'}</Button>}
      {['google', 'microsoft'].includes(provider.id) && <Button variant="secondary" onClick={() => navigate('mailbox')}>Open mailbox setup</Button>}
    </div></details>)}</div></section>}
  </div>;
}
