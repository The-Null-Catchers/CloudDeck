'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import {
  Activity,ArrowLeft,CheckCircle2,Clock3,Globe2,HeartPulse,Pause,Play,Plus,
  RefreshCw,Server,Trash2,TriangleAlert,Wifi
} from 'lucide-react';
import {api} from '@/lib/api';

type Org={id:string;name:string;role:string};
type HealthCheck={
  id:string;organization_id:string;server_id:string|null;server_name:string|null;name:string;
  kind:'http'|'https'|'tcp';target:string;interval_seconds:number;timeout_seconds:number;
  expected_status:number|null;failure_threshold:number;enabled:boolean;next_check_at:string;
  last_checked_at:string|null;last_success_at:string|null;consecutive_failures:number;
  last_success:boolean|null;last_response_ms:number|null;last_status_code:number|null;last_error:string|null;
  alert_id:string|null;alert_state:'open'|'acknowledged'|null;
};
type HealthResult={id:string;checked_at:string;success:boolean;response_ms:number;status_code:number|null;error:string|null};
type CreateForm={name:string;kind:'http'|'https'|'tcp';target:string;intervalSeconds:number;timeoutSeconds:number;expectedStatus:string;failureThreshold:number};

const initialForm:CreateForm={
  name:'',kind:'https',target:'https://example.com/health',intervalSeconds:60,timeoutSeconds:5,expectedStatus:'200',failureThreshold:3
};

function when(value:string|null){return value?new Date(value).toLocaleString():'Never'}
function pct(value:number){return Number.isFinite(value)?value.toFixed(1):'0.0'}

export default function HealthChecksPage(){
  const router=useRouter();
  const [org,setOrg]=useState<Org|null>(null);
  const [checks,setChecks]=useState<HealthCheck[]>([]);
  const [selected,setSelected]=useState<string|null>(null);
  const [results,setResults]=useState<HealthResult[]>([]);
  const [showCreate,setShowCreate]=useState(false);
  const [form,setForm]=useState<CreateForm>(initialForm);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState('');

  async function load(silent=false){
    if(!silent)setLoading(true);
    try{
      const orgs=await api<{organizations:Org[]}>('/organizations');
      const selectedOrg=orgs.organizations[0];
      if(!selectedOrg)throw new Error('No workspace found');
      const data=await api<{healthChecks:HealthCheck[]}>(`/organizations/${selectedOrg.id}/health-checks`);
      setOrg(selectedOrg);setChecks(data.healthChecks);setError('');
      if(selected&&!data.healthChecks.some(item=>item.id===selected)){setSelected(null);setResults([])}
    }catch(e){setError(e instanceof Error?e.message:'Unable to load health checks')}
    finally{if(!silent)setLoading(false)}
  }

  useEffect(()=>{void load();const timer=setInterval(()=>void load(true),15000);return()=>clearInterval(timer)},[]);

  async function openResults(id:string){
    setSelected(id);
    try{
      const data=await api<{results:HealthResult[]}>(`/health-checks/${id}/results?limit=100`);
      setResults(data.results);
    }catch(e){setError(e instanceof Error?e.message:'Unable to load check history')}
  }

  async function createCheck(event:React.FormEvent){
    event.preventDefault();
    if(!org)return;
    setBusy('create');setError('');
    try{
      await api(`/organizations/${org.id}/health-checks`,{
        method:'POST',
        body:JSON.stringify({
          name:form.name.trim(),kind:form.kind,target:form.target.trim(),
          intervalSeconds:Number(form.intervalSeconds),timeoutSeconds:Number(form.timeoutSeconds),
          expectedStatus:form.kind==='tcp'||!form.expectedStatus?null:Number(form.expectedStatus),
          failureThreshold:Number(form.failureThreshold),enabled:true
        })
      });
      setForm(initialForm);setShowCreate(false);await load(true);
    }catch(e){setError(e instanceof Error?e.message:'Unable to create health check')}
    finally{setBusy(null)}
  }

  async function toggle(check:HealthCheck){
    setBusy(`toggle:${check.id}`);setError('');
    try{
      await api(`/health-checks/${check.id}`,{method:'PATCH',body:JSON.stringify({enabled:!check.enabled})});
      setChecks(items=>items.map(item=>item.id===check.id?{...item,enabled:!item.enabled}:item));
    }catch(e){setError(e instanceof Error?e.message:'Unable to update health check')}
    finally{setBusy(null)}
  }

  async function remove(check:HealthCheck){
    if(!confirm(`Delete health check “${check.name}”? Its history and related alert will be removed.`))return;
    setBusy(`delete:${check.id}`);setError('');
    try{
      await api(`/health-checks/${check.id}`,{method:'DELETE'});
      if(selected===check.id){setSelected(null);setResults([])}
      setChecks(items=>items.filter(item=>item.id!==check.id));
    }catch(e){setError(e instanceof Error?e.message:'Unable to delete health check')}
    finally{setBusy(null)}
  }

  const selectedCheck=checks.find(item=>item.id===selected)??null;
  const summary=useMemo(()=>{
    const successful=results.filter(item=>item.success);
    const avg=successful.length?successful.reduce((sum,item)=>sum+item.response_ms,0)/successful.length:0;
    const uptime=results.length?(successful.length/results.length)*100:0;
    const lastFailure=results.find(item=>!item.success)?.checked_at??null;
    return {uptime,avg,lastFailure};
  },[results]);

  const healthy=checks.filter(item=>item.enabled&&item.last_success===true&&!item.alert_id).length;
  const failing=checks.filter(item=>Boolean(item.alert_id)).length;
  const paused=checks.filter(item=>!item.enabled).length;

  return <div className="deploy-page ops-page">
    <header className="deploy-topbar">
      <button onClick={()=>router.push('/dashboard')}><ArrowLeft size={16}/> Dashboard</button>
      <span><Activity size={18}/> clouddeck.</span>
      <div>{org?.name??'Workspace'} · Health checks</div>
    </header>

    <main className="deploy-content">
      <section className="deploy-hero">
        <div><span className="eyebrow">OPERATIONS / HEALTH CHECKS</span><h1>Watch every endpoint</h1><p>Run distributed HTTP, HTTPS, and TCP probes with failure thresholds and incident recovery.</p></div>
        <div className="deploy-hero-actions"><button className="deploy-refresh" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/> Refresh</button><button className="primary" onClick={()=>setShowCreate(value=>!value)}><Plus size={15}/> New check</button></div>
      </section>

      {error&&<div className="notice" role="status">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}

      <section className="deploy-stats">
        <div><HeartPulse size={18}/><span>Total checks</span><strong>{checks.length}</strong></div>
        <div><CheckCircle2 size={18}/><span>Healthy</span><strong>{healthy}</strong></div>
        <div><TriangleAlert size={18}/><span>Failing</span><strong>{failing}</strong></div>
        <div><Pause size={18}/><span>Paused</span><strong>{paused}</strong></div>
      </section>

      {showCreate&&<form className="deploy-section health-create" onSubmit={createCheck}>
        <div className="deploy-section-head"><div><h2>Create health check</h2><p>Targets are validated server-side and private/reserved network ranges are rejected.</p></div></div>
        <div className="health-form-grid">
          <label>Name<input required maxLength={100} value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Production API"/></label>
          <label>Protocol<select value={form.kind} onChange={e=>setForm({...form,kind:e.target.value as CreateForm['kind'],expectedStatus:e.target.value==='tcp'?'':form.expectedStatus})}><option value="https">HTTPS</option><option value="http">HTTP</option><option value="tcp">TCP</option></select></label>
          <label className="wide">Target<input required value={form.target} onChange={e=>setForm({...form,target:e.target.value})} placeholder={form.kind==='tcp'?'example.com:443':'https://example.com/health'}/></label>
          <label>Interval (seconds)<input type="number" min={30} max={86400} value={form.intervalSeconds} onChange={e=>setForm({...form,intervalSeconds:Number(e.target.value)})}/></label>
          <label>Timeout (seconds)<input type="number" min={1} max={30} value={form.timeoutSeconds} onChange={e=>setForm({...form,timeoutSeconds:Number(e.target.value)})}/></label>
          <label>Failure threshold<input type="number" min={1} max={20} value={form.failureThreshold} onChange={e=>setForm({...form,failureThreshold:Number(e.target.value)})}/></label>
          <label>Expected HTTP status<input disabled={form.kind==='tcp'} type="number" min={100} max={599} value={form.expectedStatus} onChange={e=>setForm({...form,expectedStatus:e.target.value})} placeholder="Any 2xx/3xx"/></label>
        </div>
        <div className="health-form-actions"><button type="button" onClick={()=>setShowCreate(false)}>Cancel</button><button className="primary" disabled={busy==='create'}>{busy==='create'?'Creating…':'Create check'}</button></div>
      </form>}

      <section className="deploy-section">
        <div className="deploy-section-head"><div><h2>Checks</h2><p>Latest probe state for this workspace.</p></div><span>{checks.length} configured</span></div>
        <div className="health-list">
          {checks.map(check=>{
            const state=!check.enabled?'paused':check.alert_id?'failing':check.last_success===false?'warning':check.last_success===true?'healthy':'pending';
            return <article className="health-row" key={check.id}>
              <button className="health-main" onClick={()=>void openResults(check.id)}>
                <span className={`health-protocol ${check.kind}`}>{check.kind==='tcp'?<Wifi size={16}/>:<Globe2 size={16}/>}</span>
                <span className="health-copy"><strong>{check.name}</strong><small>{check.target}</small><em>{check.server_name??'External endpoint'} · every {check.interval_seconds}s</em></span>
                <span className={`health-state ${state}`}>{state}</span>
                <span className="health-latency"><strong>{check.last_response_ms==null?'—':`${check.last_response_ms} ms`}</strong><small>{check.last_status_code??(check.last_error?'error':'awaiting result')}</small></span>
                <span className="health-last"><Clock3 size={13}/>{when(check.last_checked_at)}</span>
              </button>
              <div className="health-actions">
                <button title={check.enabled?'Pause':'Resume'} onClick={()=>void toggle(check)} disabled={busy===`toggle:${check.id}`}>{check.enabled?<Pause size={15}/>:<Play size={15}/>}</button>
                <button className="danger" title="Delete" onClick={()=>void remove(check)} disabled={busy===`delete:${check.id}`}><Trash2 size={15}/></button>
              </div>
            </article>
          })}
          {!checks.length&&!loading&&<div className="deployment-empty">No health checks yet. Create one to start monitoring availability.</div>}
        </div>
      </section>

      {selectedCheck&&<section className="deploy-section health-history">
        <div className="deploy-section-head"><div><h2>{selectedCheck.name} history</h2><p>Latest {results.length} probe results.</p></div><button className="deploy-refresh" onClick={()=>void openResults(selectedCheck.id)}><RefreshCw size={14}/> Reload</button></div>
        <div className="health-summary">
          <div><span>Sample uptime</span><strong>{pct(summary.uptime)}%</strong></div>
          <div><span>Average response</span><strong>{summary.avg?Math.round(summary.avg)+' ms':'—'}</strong></div>
          <div><span>Last successful</span><strong>{when(selectedCheck.last_success_at)}</strong></div>
          <div><span>Last failure</span><strong>{when(summary.lastFailure)}</strong></div>
        </div>
        <div className="health-result-list">
          {results.map(result=><div key={result.id}><span className={result.success?'result-ok':'result-fail'}>{result.success?'Healthy':'Failed'}</span><strong>{result.response_ms} ms</strong><span>{result.status_code??'—'}</span><time>{when(result.checked_at)}</time><code>{result.error??'OK'}</code></div>)}
          {!results.length&&<div className="deployment-empty">No probe results yet.</div>}
        </div>
      </section>}
    </main>
  </div>
}
