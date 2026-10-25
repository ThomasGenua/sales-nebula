import React, { useEffect, useState } from 'react';
import { useAuth, can } from './contexts';
import { Button, Input, Select, TextArea } from './Controls';
import { RecordPicker } from './SalesWorkflows';
import { panel, Problem, dateLabel } from './SalesWorkspace';
function useAction() {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const run = async fn => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return {
    error,
    busy,
    notice,
    setNotice,
    setError,
    run
  };
}
function Feedback({
  action
}) {
  return <><Problem message={action.error} />{action.notice && <p role="status">{action.notice}</p>}</>;
}
export function PaymentsWorkspace() {
  const {
      apiFetch,
      user
    } = useAuth(),
    a = useAction();
  const [id, setId] = useState(''),
    [data, setData] = useState(null),
    [amount, setAmount] = useState(''),
    [reference, setReference] = useState('');
  const editable = can(user, 'invoices', 'edit');
  const load = async () => {
    if (id) setData(await apiFetch('/payments/' + id));
  };
  useEffect(() => {
    setData(null);
    if (id) load().catch(e => a.setError(e.message));
  }, [id]);
  const money = n => `${data?.currency} ${(n / 100).toFixed(2)}`;
  return <section className={`${panel} space-y-4`}><h2 className="text-xl font-bold">Invoice payments</h2><RecordPicker module="invoices" label="Invoice" value={id} onChange={setId} /><Feedback action={a} />{data && <>
    <div className="grid sm:grid-cols-3 gap-4"><p>Total<br /><strong>{money(data.totalMinor)}</strong></p><p>Paid<br /><strong>{money(data.paidMinor)}</strong></p><p>Outstanding<br /><strong>{money(data.outstandingMinor)}</strong></p></div>
    {data.creditMinor > 0 && <p>Overpayment to reconcile: {money(data.creditMinor)}</p>}
    <Button variant="secondary" onClick={() => a.run(async () => {
        const response = await fetch('/api/invoices/' + id + '/pdf', {
          credentials: 'include'
        });
        if (!response.ok) throw new Error('Could not download invoice');
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url;
        link.download = 'invoice.pdf';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      })}>Download invoice PDF</Button>
    {editable && <><div className="grid sm:grid-cols-2 gap-3"><Input label="Payment amount" type="number" min="0.01" step="0.01" value={amount} onChange={setAmount} /><Input label="Bank or payment reference" value={reference} onChange={setReference} /></div><div className="flex flex-wrap gap-2"><Button disabled={a.busy || !amount || !reference} onClick={() => a.run(async () => {
            await apiFetch('/payments/' + id + '/record', {
              method: 'POST',
              body: {
                amount: Number(amount),
                reference
              }
            });
            await load();
            a.setNotice('Payment recorded.');
          })}>Record received payment</Button><Button disabled={a.busy || !data.outstandingMinor} onClick={() => a.run(async () => {
            await apiFetch('/payments/' + id + '/checkout', {
              method: 'POST',
              body: amount ? {
                amount: Number(amount)
              } : {}
            });
            await load();
            a.setNotice('Stripe payment link created.');
          })}>Create Stripe payment link</Button><Button variant="secondary" disabled={a.busy} onClick={() => a.run(async () => {
            await apiFetch('/payments/' + id + '/reminders', {
              method: 'POST',
              body: {
                enabled: !data.remindersEnabled
              }
            });
            await load();
          })}>{data.remindersEnabled ? 'Disable' : 'Enable'} overdue reminders</Button></div><p className="text-xs">Enabling reminders authorizes a weekly email to the invoice contact while payment is overdue.</p></>}
    {data.lastReminderError && <Problem message={data.lastReminderError} />}<h3 className="font-semibold">Payment history</h3>{data.payments.length === 0 && <p>No payments recorded.</p>}{data.payments.map(p => <p key={p.id}>{dateLabel(p.createdAt)} · {money(p.amountMinor)} · {p.provider} · {p.reference}</p>)}
    <h3 className="font-semibold">Payment links</h3>{data.checkouts.map(c => <div key={c.id} className="flex gap-3 items-center"><span>{money(c.amountMinor)} · {c.status}</span>{c.url && <a className="underline" href={c.url} target="_blank" rel="noreferrer">Open Stripe checkout</a>}{editable && c.sessionId && c.status !== 'Paid' && <Button size="sm" variant="secondary" disabled={a.busy} onClick={() => a.run(async () => {
          await apiFetch('/payments/' + id + '/reconcile', {
            method: 'POST',
            body: {
              sessionId: c.sessionId
            }
          });
          await load();
        })}>Check payment</Button>}</div>)}
  </>}</section>;
}
export function ComputedFieldsWorkspace() {
  const {
      apiFetch,
      user
    } = useAuth(),
    a = useAction();
  const [module, setModule] = useState('deals'),
    [fields, setFields] = useState([]),
    [name, setName] = useState(''),
    [formula, setFormula] = useState('DATEDIFF(NOW(), createdAt)'),
    [kind, setKind] = useState('formula'),
    [child, setChild] = useState('deals'),
    [field, setField] = useState('value'),
    [fn, setFn] = useState('sum'),
    [recordId, setRecordId] = useState(''),
    [preview, setPreview] = useState(null);
  const load = async () => {
    const r = await apiFetch('/formulas?module=' + module);
    setFields(r.data || r);
  };
  useEffect(() => {
    load().catch(e => a.setError(e.message));
    setRecordId('');
    setPreview(null);
    setChild(module === 'deals' ? 'activities' : 'deals');
    setKind('formula');
  }, [module]);
  const children = module === 'accounts' ? ['deals', 'invoices', 'cases'] : module === 'contacts' ? ['deals'] : module === 'deals' ? ['activities'] : [];
  return <section className={`${panel} space-y-3`}><h2 className="text-xl font-bold">Formula fields and rollups</h2><Feedback action={a} /><Select label="Module" value={module} options={['deals', 'accounts', 'contacts', 'leads', 'invoices', 'products', 'cases']} onChange={setModule} />
    <p className="text-sm">Computed fields appear in custom-field views, list filters and reports. Related totals include records the viewer can access.</p>
    {fields.map(f => <div key={f.id} className="border-b border-slate-700 py-2"><strong>{f.name}</strong> · {f.rollup ? `${f.rollup.function} ${f.rollup.module}.${f.rollup.field || 'records'}` : f.formula} · {f.active ? 'Active' : 'Inactive'}{can(user, 'settings', 'full') && <Button size="sm" variant="secondary" onClick={() => a.run(async () => {
        await apiFetch('/formulas/' + f.id, {
          method: 'PUT',
          body: {
            active: !f.active
          }
        });
        await load();
      })}>{f.active ? 'Disable' : 'Enable'}</Button>}</div>)}
    {can(user, 'settings', 'full') && <details><summary>Add a computed field</summary><div className="space-y-3 mt-3"><Input label="Field name" value={name} onChange={setName} /><Select label="Calculation" value={kind} options={['formula', ...(children.length ? ['rollup'] : [])]} onChange={setKind} />{kind === 'formula' ? <TextArea label="Formula" value={formula} onChange={setFormula} /> : <><Select label="Related records" value={child} options={children} onChange={setChild} /><Select label="Aggregation" value={fn} options={['count', 'sum', 'avg', 'min', 'max']} onChange={setFn} />{fn !== 'count' && <Input label="Numeric field" value={field} onChange={setField} />}</>}<Button disabled={a.busy || !name} onClick={() => a.run(async () => {
          await apiFetch('/formulas', {
            method: 'POST',
            body: {
              name,
              module,
              formula: kind === 'formula' ? formula : '0',
              returnType: 'number',
              precision: 2,
              ...(kind === 'rollup' && {
                rollup: {
                  module: child,
                  function: fn,
                  field,
                  filters: []
                }
              })
            }
          });
          setName('');
          await load();
        })}>Create computed field</Button></div></details>}
    <RecordPicker module={module} label="Preview record" value={recordId} onChange={setRecordId} /><Button disabled={!recordId || a.busy} onClick={() => a.run(async () => setPreview(await apiFetch('/studio/values/' + module + '/' + recordId)))}>Preview computed values</Button>{preview?.filter(f => f.computed).map(f => <p key={f.id}>{f.label}: {String(f.value ?? '—')}</p>)}
  </section>;
}
export function CampaignExecution() {
  const {
      apiFetch,
      user
    } = useAuth(),
    a = useAction();
  const [id, setId] = useState(''),
    [subject, setSubject] = useState(''),
    [body, setBody] = useState(''),
    [data, setData] = useState(null);
  const load = async () => {
    if (id) setData(await apiFetch('/campaigns/' + id + '/delivery'));
  };
  useEffect(() => {
    setData(null);
    if (id) load().catch(e => a.setError(e.message));
  }, [id]);
  return <section className={`${panel} space-y-3`}><h2 className="text-xl font-bold">Campaign delivery</h2><RecordPicker module="campaigns" label="Campaign" value={id} onChange={setId} /><Feedback action={a} /><p className="text-sm">Add recipients on the campaign first. Sending snapshots this message and queues accessible, unsuppressed recipients once per campaign.</p>{can(user, 'campaigns', 'edit') && <><Input label="Campaign email subject" value={subject} onChange={setSubject} /><TextArea label="Campaign email body" value={body} onChange={setBody} rows={6} /><Button disabled={!id || !subject || !body || a.busy} onClick={() => a.run(async () => {
        const r = await apiFetch('/campaigns/' + id + '/send', {
          method: 'POST',
          body: {
            subject,
            body
          }
        });
        a.setNotice(`${r.queued} queued; ${r.skipped} skipped.`);
        await load();
      })}>Queue campaign emails</Button></>}{id && <Button variant="secondary" onClick={() => a.run(load)}>Refresh delivery status</Button>}
    {data && <><p>{Object.entries(data.counts).map(([s, n]) => `${s}: ${n}`).join(' · ')}</p><div className="overflow-auto"><table className="w-full text-sm"><thead><tr><th className="text-left">Recipient</th><th>Status</th><th>Sent</th><th>Details</th></tr></thead><tbody>{data.data.map(r => <tr key={r.id}><td className="py-2">{r.email}</td><td>{r.status}</td><td>{dateLabel(r.sentAt)}</td><td>{r.error}</td></tr>)}</tbody></table></div><p className="text-xs">Showing the newest 200 deliveries. Failed or uncertain sends require review; the worker does not blindly resend them.</p></>}
  </section>;
}
export function DealRoomsWorkspace() {
  const {
      apiFetch,
      user
    } = useAuth(),
    a = useAction();
  const [rooms, setRooms] = useState([]),
    [id, setId] = useState(''),
    [data, setData] = useState(null),
    [dealId, setDealId] = useState(''),
    [name, setName] = useState(''),
    [url, setUrl] = useState('');
  const [kind, setKind] = useState('milestone'),
    [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [documentUrl, setDocumentUrl] = useState(''),
    [dueDate, setDueDate] = useState(''),
    [quoteId, setQuoteId] = useState(''),
    [signer, setSigner] = useState(''),
    [email, setEmail] = useState('');
  const editable = can(user, 'deals', 'edit'),
    loadRooms = async () => setRooms((await apiFetch('/deal-rooms')).data),
    load = async () => {
      if (id) setData(await apiFetch('/deal-rooms/' + id));
    };
  useEffect(() => {
    a.run(loadRooms);
  }, []);
  useEffect(() => {
    setData(null);
    if (id) load().catch(e => a.setError(e.message));
  }, [id]);
  return <section className={`${panel} space-y-4`}><h2 className="text-xl font-bold">Customer deal rooms</h2><Feedback action={a} /><Select label="Deal room" value={id} options={rooms.map(r => ({
      value: r.id,
      label: r.name + (r.revokedAt ? ' (revoked)' : '')
    }))} onChange={setId} />
    {editable && <details><summary>Create a deal room</summary><div className="space-y-3 mt-3"><RecordPicker module="deals" label="Deal" value={dealId} onChange={setDealId} /><Input label="Room name" value={name} onChange={setName} /><Button disabled={!dealId || a.busy} onClick={() => a.run(async () => {
          const r = await apiFetch('/deal-rooms', {
            method: 'POST',
            body: {
              dealId,
              name,
              days: 30
            }
          });
          setUrl(r.url);
          setId(r.id);
          await loadRooms();
        })}>Create 30-day customer link</Button></div></details>}
    {url && <div className="rounded border border-amber-600 p-3"><p>Copy this link now; it is shown only once. Anyone with the link can access the shared room.</p><a className="underline break-all" href={url} target="_blank" rel="noreferrer">{url}</a></div>}
    {data && <><p>Expires {dateLabel(data.room.expiresAt)} · {data.room.revokedAt ? 'Revoked' : 'Active'}</p>{editable && !data.room.revokedAt && <Button variant="secondary" onClick={() => a.run(async () => {
        await apiFetch('/deal-rooms/' + id + '/revoke', {
          method: 'POST',
          body: {}
        });
        await load();
        await loadRooms();
      })}>Revoke customer access</Button>}
      {data.items.map(i => <article key={i.id} className="border-t border-slate-700 py-3"><h3 className="font-semibold">{i.title}</h3><p className="text-sm whitespace-pre-wrap">{i.kind === 'proposal' ? 'Shared proposal PDF' : i.body}</p>{i.url && <a href={i.url} className="underline" target="_blank" rel="noreferrer">Open document</a>}{i.kind === 'milestone' && <p>{i.completedAt ? 'Completed' : 'Due ' + dateLabel(i.dueDate)} {editable && <Button size="sm" variant="secondary" onClick={() => a.run(async () => {
            await apiFetch(`/deal-rooms/${id}/items/${i.id}/complete`, {
              method: 'POST',
              body: {
                completed: !i.completedAt
              }
            });
            await load();
          })}>{i.completedAt ? 'Reopen' : 'Complete'}</Button>}</p>}<small>{i.author}</small></article>)}
      {editable && <details><summary>Add shared content</summary><div className="space-y-3 mt-3"><Select label="Content type" value={kind} options={['milestone', 'document', 'comment']} onChange={setKind} /><Input label="Title" value={title} onChange={setTitle} /><TextArea label="Description or comment" value={body} onChange={setBody} />{kind === 'document' && <Input label="HTTPS document URL" value={documentUrl} onChange={setDocumentUrl} />} {kind === 'milestone' && <Input label="Due date" type="date" value={dueDate} onChange={setDueDate} />}<Button disabled={!title || a.busy} onClick={() => a.run(async () => {
            await apiFetch(`/deal-rooms/${id}/items`, {
              method: 'POST',
              body: {
                kind,
                title,
                body,
                url: documentUrl,
                dueDate: dueDate || null
              }
            });
            setTitle('');
            setBody('');
            await load();
          })}>Add to customer room</Button></div></details>}
      {editable && can(user, 'quotes', 'edit') && <details><summary>Proposals and DocuSign</summary><div className="space-y-3 mt-3"><RecordPicker module="quotes" label="Quote belonging to this deal" value={quoteId} onChange={setQuoteId} /><Button disabled={!quoteId || a.busy} onClick={() => a.run(async () => {
            await apiFetch(`/deal-rooms/${id}/proposals`, {
              method: 'POST',
              body: {
                quoteId
              }
            });
            await load();
          })}>Share proposal snapshot</Button><Input label="Signer name" value={signer} onChange={setSigner} /><Input label="Signer email" value={email} onChange={setEmail} />{!data.docusignConfigured && <p>DocuSign credentials and consent must be configured before sending.</p>}<Button disabled={!quoteId || !signer || !email || !data.docusignConfigured || a.busy} onClick={() => a.run(async () => {
            await apiFetch(`/deal-rooms/${id}/signatures`, {
              method: 'POST',
              body: {
                quoteId,
                name: signer,
                email
              }
            });
            await load();
          })}>Email signature request via DocuSign</Button><p className="text-xs">A completed signature is recorded against the sent quote version. Accept the current quote through its normal approval process.</p></div></details>}
      {data.signatures.map(s => <div key={s.id}><p>{s.signerName} · {s.status} {s.error}</p>{editable && can(user, 'quotes', 'edit') && <Button variant="secondary" onClick={() => a.run(async () => {
          const r = await apiFetch(`/deal-rooms/${id}/signatures/${s.id}/reconcile`, {
            method: 'POST',
            body: {}
          });
          await load();
          a.setNotice(r.quoteChanged ? 'The quote changed after this signature request.' : 'Signature status updated.');
        })}>Refresh signature status</Button>}</div>)}
    </>}
  </section>;
}
export function SuccessWorkspace() {
  const {
      apiFetch,
      user
    } = useAuth(),
    a = useAction();
  const [playbooks, setPlaybooks] = useState([]),
    [accountId, setAccountId] = useState(''),
    [playbookId, setPlaybookId] = useState(''),
    [enrollments, setEnrollments] = useState([]),
    [name, setName] = useState(''),
    [milestones, setMilestones] = useState([{
      title: 'Kickoff meeting',
      days: 7
    }]),
    [rules, setRules] = useState([{
      metric: 'overdueMilestones',
      threshold: 0,
      penalty: 30
    }]),
    [riskThreshold, setRiskThreshold] = useState(75);
  const load = async () => {
    if (accountId) setEnrollments((await apiFetch('/success-playbooks/accounts/' + accountId)).data);
  };
  const definitions = async () => setPlaybooks((await apiFetch('/success-playbooks')).data);
  useEffect(() => {
    a.run(definitions);
  }, []);
  useEffect(() => {
    setEnrollments([]);
    if (accountId) load().catch(e => a.setError(e.message));
  }, [accountId]);
  return <section className={`${panel} space-y-3`}><h2 className="text-xl font-bold">Account success playbooks</h2><Feedback action={a} /><RecordPicker module="accounts" label="Account" value={accountId} onChange={setAccountId} /><Select label="Playbook" value={playbookId} options={playbooks.filter(p => p.active).map(p => ({
      value: p.id,
      label: p.name
    }))} onChange={setPlaybookId} />{can(user, 'accounts', 'edit') && <div className="flex gap-2"><Button disabled={!accountId || !playbookId || a.busy} onClick={() => a.run(async () => {
        await apiFetch('/success-playbooks/accounts/' + accountId + '/enroll', {
          method: 'POST',
          body: {
            playbookId
          }
        });
        await load();
      })}>Start playbook</Button><Button variant="secondary" disabled={!accountId || a.busy} onClick={() => a.run(async () => {
        await apiFetch('/success-playbooks/accounts/' + accountId + '/evaluate', {
          method: 'POST',
          body: {}
        });
        await load();
      })}>Evaluate account health</Button></div>}
    {enrollments.map(e => <article key={e.id} className="border-t border-slate-700 py-3"><h3 className="font-semibold">{e.definition.name} · {e.lastEvaluatedAt ? e.healthScore + '/100' : 'Not evaluated'} · {e.atRisk ? 'At risk' : 'On track'}</h3><Problem message={e.lastError} />{e.milestones.map(m => <p key={m.id}>{m.completedAt ? '✓' : '○'} {m.title} · due {dateLabel(m.dueDate)}</p>)}<p className="text-xs">Complete milestones in My Day or Activities. New risk episodes create an assigned recovery task and notification.</p></article>)}
    {can(user, 'settings', 'full') && <details><summary>Create a playbook template</summary><div className="space-y-3 mt-3"><Input label="Playbook name" value={name} onChange={setName} /><h3>Onboarding milestones</h3>{milestones.map((m, i) => <div className="grid sm:grid-cols-2 gap-2" key={i}><Input label={`Milestone ${i + 1}`} value={m.title} onChange={v => setMilestones(all => all.map((x, j) => j === i ? {
            ...x,
            title: v
          } : x))} /><Input label="Days after enrollment" type="number" value={m.days} onChange={v => setMilestones(all => all.map((x, j) => j === i ? {
            ...x,
            days: Number(v)
          } : x))} /></div>)}<Button variant="secondary" onClick={() => setMilestones(all => [...all, {
          title: '',
          days: 14
        }])}>Add milestone</Button><h3>Health deductions</h3>{rules.map((r, i) => <div className="grid sm:grid-cols-3 gap-2" key={i}><Select label="Metric" value={r.metric} options={['overdueMilestones', 'openCases', 'overdueInvoices', 'staleDeals']} onChange={v => setRules(all => all.map((x, j) => j === i ? {
            ...x,
            metric: v
          } : x))} /><Input label="When count exceeds" type="number" value={r.threshold} onChange={v => setRules(all => all.map((x, j) => j === i ? {
            ...x,
            threshold: Number(v)
          } : x))} /><Input label="Deduct points" type="number" value={r.penalty} onChange={v => setRules(all => all.map((x, j) => j === i ? {
            ...x,
            penalty: Number(v)
          } : x))} /></div>)}<Button variant="secondary" onClick={() => setRules(all => [...all, {
          metric: 'openCases',
          threshold: 3,
          penalty: 25
        }])}>Add health rule</Button><Input label="At risk below score" type="number" value={riskThreshold} onChange={v => setRiskThreshold(Number(v))} /><Button disabled={!name || a.busy} onClick={() => a.run(async () => {
          await apiFetch('/success-playbooks', {
            method: 'POST',
            body: {
              name,
              milestones,
              healthRules: rules,
              riskThreshold
            }
          });
          await definitions();
          setName('');
          a.setNotice('Playbook template created.');
        })}>Save playbook template</Button></div></details>}
  </section>;
}
