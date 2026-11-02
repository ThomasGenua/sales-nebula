import React, { useEffect, useState } from 'react';

export default function MarketingOverview({ apiFetch }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    setData(null); setError('');
    apiFetch(`/marketing/summary?days=${days}`).then(value => { if (current) setData(value); }).catch(e => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [apiFetch, days, refresh]);
  const metric = (row, key) => {
    const value = row.metrics[key];
    if (!value.samples) return 'No samples';
    return `${key === 'cls' ? value.p75.toFixed(3) : `${Math.round(value.p75)} ms`} (${value.samples})`;
  };
  return <details className="mb-5 rounded-xl p-4" style={{ border: '1px solid var(--sn-rule)', background: 'var(--sn-panel)' }}>
    <summary className="cursor-pointer font-semibold text-sm">Website conversion, activation & performance</summary>
    <div className="flex flex-wrap items-center gap-3 mt-4 mb-4">
      <label className="text-xs">Visitor cohort <select aria-label="Measurement period" value={days} onChange={e => setDays(Number(e.target.value))} className="ml-2 p-2 rounded" style={{ background: 'var(--sn-raised)' }}>{[7, 14, 30].map(d => <option key={d} value={d}>Last {d} days</option>)}</select></label>
      <button type="button" className="text-xs underline" onClick={() => setRefresh(v => v + 1)}>Refresh measurements</button>
    </div>
    {error ? <p role="alert" className="text-sm">{error}</p> : !data ? <p role="status">Loading measurements…</p> : <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">{[
        ['Visits', 'visits'], ['Demos started', 'demos'], ['Tours finished', 'tours'], ['Forms started', 'forms'], ['Access requested', 'requested'], ['Email verified', 'verified'], ['First sign-in', 'activated'],
      ].map(([label, key]) => <div key={key} className="p-3 rounded" style={{ background: 'var(--sn-raised)' }}><span className="block text-xs" style={{ color: 'var(--sn-slate)' }}>{label}</span><strong className="text-xl">{data.funnel[key]}</strong></div>)}</div>
      <p className="text-xs my-4" style={{ color: 'var(--sn-slate)' }}>Unique measured visitor sessions in this cohort. Demo and form steps are optional. Verification and first sign-in come from approved access requests, not browser events. Opted-out visits and unlinked requests are excluded. {data.sampled && 'Limited to the most recent 10,000 sessions.'}</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-xs"><caption className="text-left font-semibold py-2">Acquisition sources</caption><thead><tr>{['Source / medium', 'Campaign', 'Visits', 'Demos', 'Requests', 'First sign-in'].map(h => <th key={h} className="p-2">{h}</th>)}</tr></thead><tbody>{data.sources.map((r, i) => <tr key={i} style={{ borderTop: '1px solid var(--sn-rule)' }}><td className="p-2">{r.source}{r.medium && ` / ${r.medium}`}</td><td className="p-2">{r.campaign || '—'}</td>{['visits', 'demos', 'requests', 'activated'].map(k => <td className="p-2" key={k}>{r[k]}</td>)}</tr>)}</tbody></table></div>
      {data.activation && <section className="my-5"><h3 className="font-semibold text-sm mb-3">From access to useful work</h3><div className="grid grid-cols-2 sm:grid-cols-5 gap-3">{[['Linked accounts', 'accounts'], ['First contact import', 'firstImport'], ['First deal', 'firstDeal'], ['First quote', 'firstQuote'], ['Used on 2+ days', 'repeatUsage']].map(([label, key]) => <div className="p-3 rounded" key={key} style={{ background: 'var(--sn-raised)' }}><span className="block text-xs">{label}</span><strong className="text-xl">{data.activation[key]}</strong></div>)}</div><p className="text-xs mt-3" style={{ color: 'var(--sn-slate)' }}>Distinct linked team accounts with measurement enabled. Milestones come from successful saves and imports during this period. Repeat use means opening the signed-in workspace on at least two UTC dates. Steps can happen in any order; these counts are not a sequential funnel.</p></section>}
      {!data.sources.length && <p className="text-xs py-3">No measured visits in this period.</p>}
      <div className="overflow-x-auto mt-5"><table className="w-full text-left text-xs"><caption className="text-left font-semibold py-2">Public-page performance · p75 and sample count</caption><thead><tr>{['Landing page', 'Device', 'LCP', 'INP', 'CLS'].map(h => <th key={h} className="p-2">{h}</th>)}</tr></thead><tbody>{data.performance.map(r => <tr key={`${r.page}:${r.device}`} style={{ borderTop: '1px solid var(--sn-rule)' }}><td className="p-2">{r.page}</td><td className="p-2">{r.device}</td>{['lcpMs', 'inpMs', 'cls'].map(k => <td className="p-2" key={k}>{metric(r, k)}</td>)}</tr>)}</tbody></table></div>
      <p className="text-xs mt-3" style={{ color: 'var(--sn-slate)' }}>Latest reported value per visitor session and landing document. Sparse samples are not a performance verdict. Targets: LCP ≤ 2,500 ms, INP ≤ 200 ms, CLS ≤ 0.1. Anonymous session measurements expire after 30 days.</p>
    </>}
  </details>;
}
