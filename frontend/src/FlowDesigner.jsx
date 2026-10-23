import { FlowActionEditor } from './FlowActionEditor';
import React, { useEffect, useState } from 'react';
import { Button, Input, Select } from './Controls';
import { useAuth } from './contexts';
import { panel, Problem } from './SalesWorkspace';

const blank = () => ({ name: '', module: 'deals', type: 'RecordTriggered', triggerType: 'update', triggerConditions: [], canvas: { nodes: [{ id: 'start', type: 'start' }, { id: 'end', type: 'end' }], edges: [{ source: 'start', target: 'end' }] } });
export function FlowDesigner() {
  const { apiFetch } = useAuth();
  const [customObjects, setCustomObjects] = useState([]);
  useEffect(() => { apiFetch('/custom-objects?limit=200').then(r => setCustomObjects(r.data)).catch(e => setError(e.message)); }, [apiFetch]);
  const [flows, setFlows] = useState([]), [flow, setFlow] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [recordId, setRecordId] = useState(''), [result, setResult] = useState(null), [runs, setRuns] = useState([]);
  const load = async () => setFlows((await apiFetch('/flows')).data);
  useEffect(() => { load().catch(e => setError(e.message)); }, [apiFetch]);
  const act = async fn => { if (busy) return; setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const set = (key, value) => { setFlow(f => ({ ...f, [key]: value })); setResult(null); };
  const nodes = flow?.canvas.nodes || [];
  const change = (id, config) => set('canvas', { ...flow.canvas, nodes: nodes.map(n => n.id === id ? { ...n, config } : n) });
  const connect = (id, target, condition) => set('canvas', { ...flow.canvas, edges: [...flow.canvas.edges.filter(e => !(e.source === id && e.condition === condition)), { source: id, target, ...(condition && { condition }) }] });
  const save = async () => { const saved = await apiFetch('/flows' + (flow.id ? '/' + flow.id : ''), { method: flow.id ? 'PUT' : 'POST', body: flow }); setFlow(saved); await load(); return saved; };
  return <div className="space-y-4"><h1 className="text-xl font-bold">Flow designer</h1><Problem message={error} /><Button onClick={() => { setFlow(blank()); setRuns([]); setResult(null); }}>New flow</Button>
    <div className="grid lg:grid-cols-[15rem_1fr] gap-4"><aside className={panel}>{flows.map(f => <button key={f.id} className="block mb-3 text-left" onClick={() => act(async () => { const detail = await apiFetch('/flows/' + f.id); setFlow(detail); setRuns(detail.runs || []); setResult(null); })}>{f.name} · {f.status}</button>)}</aside>
    {flow && <div className="space-y-4"><section className={panel}><Input label="Flow name" value={flow.name} onChange={v => set('name', v)} /><Select label="Module" value={flow.module} options={[...['deals', 'leads', 'contacts', 'accounts', 'cases', 'activities'], ...customObjects.map(o => ({ value: 'custom:' + o.id, label: o.label }))]} onChange={v => set('module', v)} /><Select label="Run mode" value={flow.type} options={['RecordTriggered', 'AutoLaunched', 'Scheduled']} onChange={v => set('type', v)} />{flow.type === 'Scheduled' && <Input label="Run every (minutes, minimum 15)" type="number" value={flow.scheduleMinutes || 60} onChange={v => set('scheduleMinutes', Number(v))} />}{flow.type === 'RecordTriggered' && <Select label="Trigger" value={flow.triggerType} options={['create', 'update']} onChange={v => set('triggerType', v)} />}</section>
      <p>Connect each step to its successor. Decisions need both branches. Saving changes pauses the flow until you publish again.</p>
      {nodes.map(node => <section key={node.id} className={panel}><h2 className="font-semibold">{node.id} · {node.type}</h2>
        {node.type === 'decision' && <div className="grid sm:grid-cols-3 gap-3"><Input label="Field" value={node.config?.conditions?.[0]?.field || ''} onChange={v => change(node.id, { conditions: [{ ...node.config?.conditions?.[0], field: v }] })} /><Select label="Comparison" value={node.config?.conditions?.[0]?.operator || 'equals'} options={['equals', 'notEquals', 'contains', 'gt', 'lt', 'isEmpty', 'isNotEmpty']} onChange={v => change(node.id, { conditions: [{ ...node.config?.conditions?.[0], operator: v }] })} /><Input label="Compare with" value={node.config?.conditions?.[0]?.value ?? ''} onChange={v => change(node.id, { conditions: [{ ...node.config?.conditions?.[0], value: v }] })} /></div>}
        {node.type === 'wait' && <Input label="Wait minutes" type="number" value={node.config?.minutes || 1} onChange={v => change(node.id, { minutes: Number(v) })} />}
        {node.type === 'action' && <FlowActionEditor module={flow.module} action={node.config?.action} onChange={action => change(node.id, { action })} />}
        {node.type !== 'end' && (node.type === 'decision' ? ['true', 'false'] : [undefined]).map(branch => <Select key={branch || 'next'} label={branch ? 'When ' + branch : 'Next step'} placeholder="Choose next step" value={flow.canvas.edges.find(e => e.source === node.id && e.condition === branch)?.target || ''} options={nodes.filter(n => n.id !== node.id).map(n => ({ value: n.id, label: n.id + ' · ' + n.type }))} onChange={v => connect(node.id, v, branch)} />)}
        {!['start', 'end'].includes(node.type) && <Button variant="danger" onClick={() => set('canvas', { nodes: nodes.filter(n => n.id !== node.id), edges: flow.canvas.edges.filter(e => e.source !== node.id && e.target !== node.id) })}>Remove step</Button>}
      </section>)}
      <div className="flex gap-2">{['decision', 'action', 'wait'].map(type => <Button key={type} variant="secondary" onClick={() => set('canvas', { ...flow.canvas, nodes: [...nodes, { id: type + '-' + crypto.randomUUID().slice(0, 8), type, config: type === 'action' ? { action: { type: 'createActivity', config: {} } } : type === 'decision' ? { conditions: [{ field: '', operator: 'equals', value: '' }] } : { minutes: 1 } }] })}>Add {type}</Button>)}</div>
      <Button disabled={busy} onClick={() => act(save)}>Save draft</Button><Button disabled={busy} onClick={() => act(async () => { const saved = await save(); setFlow(await apiFetch('/flows/' + saved.id + '/publish', { method: 'POST' })); await load(); })}>Publish</Button>
      <section className={panel}><Input label="Trigger record ID" value={recordId} onChange={setRecordId} /><Button disabled={busy || !recordId} onClick={() => act(async () => { const saved = await save(); setResult(await apiFetch('/flows/' + saved.id + '/test', { method: 'POST', body: { recordId } })); })}>Preview path</Button><Button disabled={busy || !recordId || !flow.id} onClick={() => act(async () => { setResult(await apiFetch('/flows/' + flow.id + '/run', { method: 'POST', body: { recordId } })); setRuns((await apiFetch('/flows/' + flow.id + '/executions')).data); })}>Run saved flow</Button>{result && <p role="status">{result.dryRun ? result.path.map(n => n.id).join(' → ') : 'Run ' + result.status}</p>}</section>
      <section className={panel}><h2>Recent runs</h2>{runs.map(r => <div key={r.id} className="my-3"><span>{new Date(r.startedAt).toLocaleString()} · {r.status} {r.error}</span>{r.status === 'Failed' && <Button disabled={busy} onClick={() => act(async () => { await apiFetch('/flows/' + flow.id + '/executions/' + r.id + '/retry', { method: 'POST' }); setRuns((await apiFetch('/flows/' + flow.id + '/executions')).data); })}>Retry failed step</Button>}</div>)}</section>
    </div>}
    </div>
  </div>;
}
