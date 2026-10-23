import React, { useEffect, useState } from 'react';
import { Button, Select } from './Controls';
import { useAuth } from './contexts';
import { panel, Problem } from './SalesWorkspace';
export function ReportSchedules({ report }) {
  const { apiFetch, user } = useAuth();
  const [rows,setRows]=useState([]),[cron,setCron]=useState('0 8 * * *'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const load=async()=>setRows((await apiFetch('/reports/'+report.id)).schedules||[]);
  useEffect(()=>{if(report.id&&report.createdById===user.id)load().catch(e=>setError(e.message));},[report.id,apiFetch]);
  if(!report.id||report.createdById!==user.id)return null;
  const act=async fn=>{setBusy(true);setError('');try{await fn();await load();}catch(e){setError(e.message);}finally{setBusy(false);}};
  return <details className={panel+' mb-4'}><summary>Scheduled delivery to my email</summary><Problem message={error}/><p>Reports use your current access. Times are UTC. Delivery requires configured SMTP.</p><Select label="Delivery schedule" value={cron} onChange={setCron} options={[{value:'0 * * * *',label:'Hourly'},{value:'0 8 * * *',label:'Daily at 08:00'},{value:'0 8 * * 1',label:'Monday at 08:00'}]}/><Button disabled={busy||rows.some(r=>r.active&&r.cron===cron)} onClick={()=>act(()=>apiFetch('/reports/'+report.id+'/schedule',{method:'POST',body:{cron}}))}>Schedule delivery</Button>{rows.map(r=><div className="my-2" key={r.id}><p>Next: {r.nextRun?new Date(r.nextRun).toLocaleString():'Not scheduled'} · Last delivered: {r.lastRun?new Date(r.lastRun).toLocaleString():'Never'}</p><Problem message={r.lastError}/><Button disabled={busy} variant="danger" onClick={()=>act(()=>apiFetch('/reports/schedule/'+r.id,{method:'DELETE'}))}>Cancel delivery</Button></div>)}</details>;
}
