import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Button, Input, Select, TextArea, Modal } from './Controls';
import { useAuth, can, RouteContext } from './contexts';
import { money } from './prefs';

const panel = 'mt-4 p-4 rounded-xl bg-[#0B1228] border border-[#182550]';
const rowsOf = value => value?.data || (Array.isArray(value) ? value : []);
const nameOf = record => record?.name || record?.number || [record?.firstName, record?.lastName].filter(Boolean).join(' ') || record?.id;
const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
const lineTotal = item => round(Number(item.quantity || 0) * Number(item.unitPrice || 0) - Number(item.discount || 0));
function Problem({ message }) { return message ? <p role="alert" className="text-sm text-[#F87171] my-3">{message}</p> : null; }

/** Search the actual record list, rather than limiting a picker to its first page. */
export function RecordPicker({ module, label, value, selected, onChange }) {
  const { apiFetch } = useAuth();
  const [search, setSearch] = useState('');
  const [records, setRecords] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true); setError(null);
      apiFetch(`/${module}?limit=50&search=${encodeURIComponent(search)}`, { signal: controller.signal })
        .then(data => setRecords(rowsOf(data)))
        .catch(err => { if (err.name !== 'AbortError') setError(err.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [module, search, apiFetch]);
  const options = records.map(record => ({ value: record.id, label: nameOf(record) }));
  if (value && !options.some(option => option.value === value)) options.unshift({ value, label: nameOf(selected) || value });
  return <div className="space-y-2">
    <Input label={`Search ${label.toLowerCase()}`} value={search} onChange={setSearch} placeholder="Type to search" />
    <Select label={label} value={value} options={options} placeholder={loading ? 'Loading…' : `Select ${label.toLowerCase()}`} onChange={id => onChange(id || null, records.find(r => r.id === id))} />
    <Problem message={error} />
  </div>;
}

export function LeadActions({ record, onChanged }) {
  const { apiFetch, user, demoMode } = useAuth();
  const { navigate } = useContext(RouteContext);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [form, setForm] = useState({ createAccount: false, createDeal: false, dealName: `${record.company} - New Deal`, dealValue: record.value || 0, dealCloseDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) });
  const close = useCallback(() => { if (!busy) setOpen(false); }, [busy]);
  const allowed = !demoMode && can(user, 'leads', 'edit') && can(user, 'contacts', 'edit');
  const convert = async e => {
    e.preventDefault(); if (busy) return;
    setBusy(true); setError(null);
    try { const data = await apiFetch(`/leads/${record.id}/convert`, { method: 'POST', body: form }); setResult(data); setOpen(false); onChanged(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return <section className={panel} aria-label="Lead conversion">
    {result ? <><p role="status" className="text-sm mb-3">Lead converted. Open the records below to continue.</p><div className="flex flex-wrap gap-2">
      {['contact', 'account', 'deal'].map(key => result[key] && <Button key={key} variant="secondary" onClick={() => navigate(`${key}s`, result[key].id)}>Open {key}</Button>)}
    </div></> : record.convertedAt ? <p className="text-sm">This lead has already been converted.</p>
      : allowed ? <Button onClick={() => { setError(null); setOpen(true); }}>Convert lead</Button> : <p className="text-sm text-[#7E8598]">Lead and contact edit permission is required to convert a lead.</p>}
    <Modal open={open} onClose={close} title="Convert lead">
      <form onSubmit={convert} className="space-y-4">
        <p className="text-sm">Create a contact for {record.firstName} {record.lastName}. You can also create an account and a deal.</p>
        {can(user, 'accounts', 'edit') && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.createAccount} onChange={e => setForm(p => ({ ...p, createAccount: e.target.checked }))} />Create account from company</label>}
        {can(user, 'deals', 'edit') && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.createDeal} onChange={e => setForm(p => ({ ...p, createDeal: e.target.checked }))} />Create deal</label>}
        {form.createDeal && <div className="space-y-3">
          <Input label="Deal name" value={form.dealName} onChange={dealName => setForm(p => ({ ...p, dealName }))} required />
          <Input label="Deal value" type="number" min="0" step="0.01" value={form.dealValue} onChange={dealValue => setForm(p => ({ ...p, dealValue }))} required />
          <Input label="Deal close date" type="date" value={form.dealCloseDate} onChange={dealCloseDate => setForm(p => ({ ...p, dealCloseDate }))} required />
        </div>}
        <Problem message={error} />
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? 'Converting…' : 'Convert'}</Button></div>
      </form>
    </Modal>
  </section>;
}

export function EmailActions({ record, module, onChanged }) {
  const { apiFetch, user, demoMode } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [delivery, setDelivery] = useState(null);
  const [form, setForm] = useState({ to: '', subject: '', body: '' });
  const close = useCallback(() => { if (!busy) setOpen(false); }, [busy]);
  const allowed = !demoMode && can(user, 'emails', 'edit');
  const draft = module === 'emails';
  const compose = async () => {
    setError(null); setDelivery(null);
    let recipient = record.email || record.contact?.email || '';
    if (module === 'deals' && record.contactId && !recipient && can(user, 'contacts', 'read')) {
      try { recipient = (await apiFetch(`/contacts/${record.contactId}`)).email || ''; } catch { /* The address can be entered by hand. */ }
    }
    setForm({ to: recipient, subject: '', body: '' }); setOpen(true);
  };
  const sent = data => { setDelivery(data.delivery); onChanged(); };
  const sendDraft = async () => {
    if (busy) return; setBusy(true); setError(null);
    try { sent(await apiFetch(`/emails/${record.id}/send`, { method: 'POST', body: {} })); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const send = async e => {
    e.preventDefault(); if (busy) return; setBusy(true); setError(null);
    try {
      const data = await apiFetch('/emails/send', { method: 'POST', body: { ...form, ...(module === 'contacts' ? { contactId: record.id } : { dealId: record.id, ...(record.contactId && can(user, 'contacts', 'read') && { contactId: record.contactId }) }) } });
      sent(data); setOpen(false);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <section className={panel} aria-label="Email actions">
    {allowed && (draft ? String(record.status).toLowerCase() !== 'sent' && <Button onClick={sendDraft} disabled={busy}>{busy ? 'Sending…' : 'Send email'}</Button> : <Button onClick={compose}>Compose email</Button>)}
    {!allowed && <p className="text-sm text-[#7E8598]">Email edit permission is required to send email.</p>}
    {delivery && <p role={delivery.status === 'failed' ? 'alert' : 'status'} className="text-sm mt-3">
      {delivery.delivered ? 'Email sent.' : delivery.status === 'queued' ? 'Email was not sent. No mail server is configured; the message was logged.' : `Email failed: ${delivery.error || 'Delivery failed'}`}
    </p>}
    <Problem message={open ? null : error} />
    <Modal open={open} onClose={close} title="Compose email">
      <form onSubmit={send} className="space-y-3">
        <Input label="Recipient" type="email" required value={form.to} onChange={to => setForm(p => ({ ...p, to }))} />
        <Input label="Subject" required value={form.subject} onChange={subject => setForm(p => ({ ...p, subject }))} />
        <TextArea label="Message" rows={7} value={form.body} onChange={body => setForm(p => ({ ...p, body }))} />
        <Problem message={error} />
        <div className="flex justify-end gap-2"><Button variant="secondary" disabled={busy} onClick={close}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send email'}</Button></div>
      </form>
    </Modal>
  </section>;
}

export function validateQuoteForm(form) {
  if (!form.name?.trim()) return 'A quote name is required.';
  if (!Array.isArray(form.items) || !form.items.length) return 'Add at least one product line.';
  for (const item of form.items) {
    if (!item.productId) return 'Select a product for each line.';
    if (!Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1) return 'Quantities must be positive whole numbers.';
    if (!Number.isFinite(Number(item.unitPrice)) || Number(item.unitPrice) < 0) return 'Unit prices must be zero or more.';
    if (!Number.isFinite(Number(item.discount || 0)) || Number(item.discount || 0) < 0 || lineTotal(item) < 0) return 'A line discount must be between zero and its line amount.';
  }
  const subtotal = form.items.reduce((sum, item) => sum + lineTotal(item), 0);
  if (!Number.isFinite(Number(form.discount || 0)) || Number(form.discount || 0) < 0 || Number(form.discount || 0) > subtotal) return 'The quote discount must be between zero and the subtotal.';
  if (!Number.isFinite(Number(form.tax || 0)) || Number(form.tax || 0) < 0) return 'Tax must be zero or more.';
  return null;
}

export function QuoteFormExtras({ form, setForm }) {
  const { user } = useAuth();
  const items = form.items || [];
  const update = (index, values) => setForm(p => ({ ...p, items: (p.items || []).map((item, i) => i === index ? { ...item, ...values } : item) }));
  const subtotal = items.reduce((sum, item) => sum + lineTotal(item), 0);
  return <div className="space-y-4 mb-4">
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {['accounts', 'contacts', 'deals'].map(module => can(user, module, 'read') && <RecordPicker key={module} module={module} label={module.slice(0, -1).replace(/^./, c => c.toUpperCase())} value={form[`${module.slice(0, -1)}Id`]} selected={form[module.slice(0, -1)]} onChange={(id, record) => setForm(p => ({ ...p, [`${module.slice(0, -1)}Id`]: id, [module.slice(0, -1)]: record }))} />)}
    </div>
    <h4 className="text-sm font-semibold">Product lines</h4>
    {items.map((item, index) => <fieldset key={index} className="p-3 rounded-lg border border-[#182550] space-y-3">
      <legend className="text-xs px-2">Line {index + 1}</legend>
      <RecordPicker module="products" label={`Product for line ${index + 1}`} value={item.productId} selected={item.product} onChange={(productId, product) => update(index, { productId, product, ...(product && { unitPrice: product.price || 0, description: product.name }) })} />
      <Input label={`Description for line ${index + 1}`} value={item.description} onChange={description => update(index, { description })} />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Input label={`Quantity for line ${index + 1}`} type="number" min="1" step="1" value={item.quantity} onChange={quantity => update(index, { quantity })} />
        <Input label={`Unit price for line ${index + 1}`} type="number" min="0" step="0.01" value={item.unitPrice} onChange={unitPrice => update(index, { unitPrice })} />
        <Input label={`Discount amount for line ${index + 1}`} type="number" min="0" step="0.01" value={item.discount} onChange={discount => update(index, { discount })} />
      </div>
      <div className="flex justify-between items-center gap-2"><span className="text-sm">Line total: {money(lineTotal(item))}</span><Button variant="danger" size="sm" onClick={() => setForm(p => ({ ...p, items: p.items.filter((_, i) => i !== index) }))}>Remove line {index + 1}</Button></div>
    </fieldset>)}
    {can(user, 'products', 'read') ? <Button variant="secondary" onClick={() => setForm(p => ({ ...p, items: [...(p.items || []), { productId: null, quantity: 1, unitPrice: 0, discount: 0, description: '' }] }))}>Add product line</Button> : <p className="text-sm">Product read permission is required to add lines.</p>}
    <div aria-label="Quote totals" className="text-sm space-y-1"><p>Subtotal: {money(round(subtotal))}</p><p>Discount: {money(Number(form.discount || 0))}</p><p>Tax: {money(Number(form.tax || 0))}</p><p className="font-semibold">Total: {money(round(subtotal - Number(form.discount || 0) + Number(form.tax || 0)))}</p></div>
  </div>;
}

export function LineItems({ record }) {
  if (!record.items?.length) return null;
  return <section className={panel} aria-label="Product lines"><h2 className="text-sm font-semibold mb-3">Product lines</h2>
    <div className="space-y-3">{record.items.map((item, index) => <div key={item.id || index} className="text-sm flex flex-wrap justify-between gap-2 border-b border-[#182550] pb-2">
      <span>{item.product?.name || item.description || 'Product'} · {item.quantity} × {money(item.unitPrice)}{item.discount > 0 && ` · Discount ${money(item.discount)}`}</span><strong>{money(item.total)}</strong>
    </div>)}</div>
  </section>;
}

export function QuoteActions({ record, onChanged }) {
  const { apiFetch, user, demoMode } = useAuth();
  const { navigate } = useContext(RouteContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [html, setHtml] = useState(null);
  const [invoice, setInvoice] = useState(null);
  const [acceptOpen, setAcceptOpen] = useState(false);
  const frame = useRef(null);
  const run = async fn => { if (busy) return; setBusy(true); setError(null); try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(false); } };
  return <section className={panel} aria-label="Quote actions">
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" disabled={busy} onClick={() => run(async () => setHtml((await apiFetch(`/quotes/${record.id}/pdf?format=json`)).html))}>Preview quote</Button>
      {!demoMode && can(user, 'quotes', 'edit') && record.status !== 'Accepted' && <Button disabled={busy} onClick={() => setAcceptOpen(true)}>Record acceptance</Button>}
      {!demoMode && can(user, 'invoices', 'edit') && !invoice && <Button disabled={busy} onClick={() => run(async () => { setInvoice(await apiFetch(`/quotes/${record.id}/create-invoice`, { method: 'POST', body: {} })); })}>Create invoice</Button>}
      {invoice && <Button variant="secondary" onClick={() => navigate('invoices', invoice.id)}>Open invoice {invoice.number}</Button>}
    </div>
    {invoice && <p role="status" className="text-sm mt-3">Invoice created with {invoice.items?.length || 0} product lines. Total: {money(invoice.total)}.</p>}
    <Problem message={acceptOpen ? null : error} />
    <Modal open={acceptOpen} onClose={() => { if (!busy) setAcceptOpen(false); }} title="Record quote acceptance">
      <p className="text-sm mb-4">Confirm that the customer has accepted this quote.</p>
      <Problem message={error} />
      <div className="flex justify-end gap-2"><Button variant="secondary" disabled={busy} onClick={() => setAcceptOpen(false)}>Cancel</Button><Button disabled={busy} onClick={() => run(async () => { await apiFetch(`/quotes/${record.id}/accept`, { method: 'POST', body: {} }); setAcceptOpen(false); onChanged(); })}>Confirm acceptance</Button></div>
    </Modal>
    <Modal open={html !== null} onClose={() => setHtml(null)} title="Quote preview" wide>
      <Button variant="secondary" onClick={() => { frame.current?.contentWindow?.focus(); frame.current?.contentWindow?.print(); }}>Print / Save as PDF</Button>
      <iframe ref={frame} title="Quote document" sandbox="allow-same-origin allow-modals" srcDoc={html || ''} className="w-full h-[55vh] bg-white rounded-lg mt-3" />
    </Modal>
  </section>;
}

export function RelatedRecords({ record }) {
  const { user } = useAuth();
  const { navigate } = useContext(RouteContext);
  const links = ['account', 'contact', 'deal', 'quote'].filter(key => record[`${key}Id`] && can(user, `${key}s`, 'read'));
  if (!links.length) return null;
  return <section className={panel} aria-label="Related records"><h2 className="text-sm font-semibold mb-3">Related records</h2><div className="flex flex-wrap gap-2">
    {links.map(key => <Button key={key} variant="secondary" onClick={() => navigate(`${key}s`, record[`${key}Id`])}>Open {key}{record[key] && `: ${nameOf(record[key])}`}</Button>)}
  </div></section>;
}
