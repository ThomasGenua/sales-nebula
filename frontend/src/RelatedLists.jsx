import React, { useContext, useEffect, useState } from 'react';
import { useAuth, can, RouteContext } from './contexts';
import { fmt, money } from './prefs';

// A record's related lists: the records of other modules that link to it by a
// column of their own (a contact's accountId, a quote's dealId). Each comes
// from that module's own list filtered by the column, so its permission and
// row security apply as on the module's page: a list the viewer may not read
// is left out, and one they may read shows only the records they may see.

/** Which modules link to a module's records, and by which column. */
export const RELATED = {
  accounts: [['contacts', 'accountId'], ['deals', 'accountId'], ['cases', 'accountId'], ['activities', 'accountId'],
    ['quotes', 'accountId'], ['invoices', 'accountId'], ['contracts', 'accountId'], ['orders', 'accountId']],
  contacts: [['deals', 'contactId'], ['cases', 'contactId'], ['activities', 'contactId'], ['emails', 'contactId'],
    ['quotes', 'contactId'], ['invoices', 'contactId']],
  deals: [['activities', 'dealId'], ['emails', 'dealId'], ['quotes', 'dealId'], ['cases', 'dealId'],
    ['contracts', 'dealId'], ['orders', 'dealId']],
  quotes: [['invoices', 'quoteId'], ['orders', 'quoteId'], ['contracts', 'quoteId']],
};

const LABELS = {
  contacts: 'Contacts', deals: 'Deals', cases: 'Cases', activities: 'Activities', emails: 'Emails',
  quotes: 'Quotes', invoices: 'Invoices', contracts: 'Contracts', orders: 'Orders',
};
const day = value => (value ? new Date(value).toLocaleDateString(...fmt()) : '');
const amount = (value, currency) => (value || value === 0 ? money(value, currency || 'USD') : '');
/** A row of each module: its name, then what tells it apart at a glance. */
const ROW = {
  contacts: r => [[r.firstName, r.lastName].filter(Boolean).join(' '), r.title, r.email],
  deals: r => [r.name, r.stage, amount(r.value, r.currency)],
  cases: r => [[r.caseNumber, r.subject].filter(Boolean).join(' · '), r.status, r.priority],
  activities: r => [r.subject, r.type, r.status, r.dueDate && `Due ${day(r.dueDate)}`],
  emails: r => [r.subject, r.status, r.sentAt && `Sent ${day(r.sentAt)}`],
  quotes: r => [r.name || r.number, r.name && r.number, r.status, amount(r.total)],
  invoices: r => [r.number, r.status, amount(r.total), r.dueDate && `Due ${day(r.dueDate)}`],
  contracts: r => [r.name || r.contractNumber, r.name && r.contractNumber, r.status, r.endDate && `Ends ${day(r.endDate)}`],
  orders: r => [r.name || r.orderNumber, r.name && r.orderNumber, r.status, amount(r.total)],
};
const FIRST = 5; // rows before "Show all"
const MOST = 50; // rows fetched, newest first

function RelatedList({ module, field, record }) {
  const { apiFetch } = useAuth();
  const { navigate } = useContext(RouteContext);
  const [state, setState] = useState({ loading: true });
  const [all, setAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    apiFetch(`/${module}?${field}=${encodeURIComponent(record.id)}&limit=${MOST}&sortBy=createdAt&sortDir=desc`)
      .then(d => { if (!cancelled) setState({ rows: d.data || [], total: d.meta?.total ?? (d.data || []).length }); })
      .catch(e => { if (!cancelled) setState({ error: e.message || 'Could not load these records' }); });
    return () => { cancelled = true; };
  }, [apiFetch, module, field, record.id]);

  const label = LABELS[module];
  const rows = state.rows || [];
  const shown = all ? rows : rows.slice(0, FIRST);
  return (
    <section aria-label={label} className="bg-[#0B1228] border border-[#182550] rounded-xl">
      <div className="px-4 py-3 border-b border-[#182550] flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[#C8C2B4]">{label}</h3>
        {!state.loading && !state.error && <span className="text-xs text-[#4A5168]">{state.total}</span>}
      </div>
      <div className="p-2">
        {state.loading ? <p className="text-xs text-[#4A5168] px-2 py-3">Loading…</p>
          : state.error ? <p role="alert" className="text-xs text-[#F87171] px-2 py-3">{state.error}</p>
          : rows.length === 0 ? <p className="text-xs text-[#4A5168] px-2 py-3">No {label.toLowerCase()} yet</p>
          : (
            <ul>
              {shown.map(r => {
                const [title, ...details] = ROW[module](r);
                return (
                  <li key={r.id}>
                    <button type="button" onClick={() => navigate(module, r.id)}
                      className="w-full text-left px-2 py-2.5 rounded-lg hover:bg-[#0E1630] transition-colors touch-manipulation">
                      <span className="block text-sm text-[#F0EDE5] truncate">{title || 'Untitled'}</span>
                      <span className="block text-xs text-[#7E8598] truncate">{details.filter(Boolean).join(' · ')}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        {rows.length > FIRST && (
          <button type="button" onClick={() => setAll(a => !a)} className="text-xs font-medium text-[#F5A623] px-2 py-2 touch-manipulation">
            {all ? 'Show fewer' : `Show all ${rows.length}`}
          </button>
        )}
        {all && state.total > rows.length && <p className="text-xs text-[#4A5168] px-2 pb-2">The newest {rows.length} of {state.total}.</p>}
      </div>
    </section>
  );
}

/** The related lists of `record`, a record of `module`, that the viewer may read. */
export function RelatedLists({ module, record }) {
  const { user } = useAuth();
  const lists = (RELATED[module] || []).filter(([related]) => can(user, related, 'read'));
  if (!lists.length) return <p className="text-sm text-[#7E8598]">You can't see any of the records that link to this one.</p>;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {lists.map(([related, field]) => <RelatedList key={related} module={related} field={field} record={record} />)}
    </div>
  );
}
