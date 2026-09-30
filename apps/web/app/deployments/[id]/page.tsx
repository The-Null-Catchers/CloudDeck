'use client';

import {useEffect,useMemo,useState} from 'react';
import {useParams,useRouter} from 'next/navigation';
import {
  Activity,ArrowLeft,Boxes,CheckCircle2,Clock3,GitBranch,GitCommit,OctagonAlert,
  RefreshCw,RotateCcw,Server,ShieldCheck,TimerReset,Workflow,XCircle,ScrollText,Radio,CircleStop
} from 'lucide-react';
import {api,openDeploymentLogStream,type DeploymentLogRow} from '@/lib/api';

type DeploymentEvent={id:number;state:string;message:string|null;created_at:string};
type DeploymentDetail={
  id:string;application_id:string;application_name:string;organization_id:string;
  commit_sha:string|null;branch:string|null;state:string;created_at:string;started_at:string|null;
  finished_at:string|null;failure_code:string|null;requested_by:string|null;cancel_requested_at:string|null;cancelled_by:string|null;
  repository_full_name:string|null;deployment_type:'dockerfile'|'compose'|null;source_path:string|null;
  container_name:string|null;container_port:number|null;host_port:number|null;restart_policy:string|null;
  compose_project:string|null;image_ref:string|null;container_id:string|null;previous_container_id:string|null;
  compose_container_ids:Record<string,string>|null;previous_compose_container_ids:Record<string,string>|null;
  events:DeploymentEvent[];
};

const terminalStates=new Set(['successful','failed','cancelled','rolled-back']);
const stages=['queued','cloning','building','deploying','health-checking','successful'] as const;

function shortSha(value:string|null){return value?value.slice(0,12):'—'}
function stateText(value:string){return value.replaceAll('-',' ')}
function time(value:string|null){return value?new Date(value).toLocaleString():'—'}

export default function DeploymentDetailPage(){
  const params=useParams<{id:string}>();
  const router=useRouter();
  const [deployment,setDeployment]=useState<DeploymentDetail|null>(null);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  const [rollbackConfirm,setRollbackConfirm]=useState(false);
  const [rollingBack,setRollingBack]=useState(false);
  const [cancelConfirm,setCancelConfirm]=useState(false);
  const [cancelling,setCancelling]=useState(false);
  const [logs,setLogs]=useState<DeploymentLogRow[]>([]);
  const [logStatus,setLogStatus]=useState<'connecting'|'live'|'complete'|'error'>('connecting');
  const [logFilter,setLogFilter]=useState<'all'|'build'|'runtime'|'errors'>('all');

  async function load(silent=false){
    if(!silent)setLoading(true);
    try{
      const data=await api<DeploymentDetail>(`/deployments/${params.id}`);
      setDeployment(data);setError('');
    }catch(e){setError(e instanceof Error?e.message:'Unable to load deployment')}
    finally{if(!silent)setLoading(false)}
  }

  useEffect(()=>{
    void load();
    const timer=setInterval(()=>{
      if(!deployment||!terminalStates.has(deployment.state))void load(true);
    },4000);
    return()=>clearInterval(timer);
  },[params.id,deployment?.state]);

  useEffect(()=>{
    let active=true;
    let socket:WebSocket|null=null;
    let reconnect:ReturnType<typeof setTimeout>|null=null;
    let cursor=0;
    let streamDone=false;

    const append=(row:DeploymentLogRow)=>{
      if(!active)return;
      cursor=Math.max(cursor,row.id);
      setLogs(items=>{
        if(items.some(item=>item.id===row.id))return items;
        const next=[...items,row];
        return next.length>1000?next.slice(-1000):next;
      });
    };

    const connect=async()=>{
      if(!active)return;
      setLogStatus('connecting');
      try{
        const history=await api<{logs:Array<DeploymentLogRow>;nextAfter:number}>(`/deployments/${params.id}/logs?after=0&limit=500`);
        if(!active)return;
        const normalized=history.logs.map(row=>({...row,createdAt:row.createdAt??row.created_at}));
        if(cursor===0){
          setLogs(normalized);
          cursor=history.nextAfter;
        }else{
          for(const row of normalized){if(row.id>cursor)append(row)}
        }
        socket=await openDeploymentLogStream(params.id,cursor,event=>{
          if(!active)return;
          if(event.type==='ready')setLogStatus('live');
          else if(event.type==='log')append({
            id:event.id,
            stage:event.stage,
            stream:event.stream,
            line:event.line,
            createdAt:event.createdAt
          });
          else if(event.type==='done'){streamDone=true;setLogStatus('complete')}
        });
        socket.onclose=()=>{
          if(!active)return;
          if(streamDone){setLogStatus('complete');return}
          setLogStatus('connecting');
          reconnect=setTimeout(()=>void connect(),1500);
        };
        socket.onerror=()=>{if(active)setLogStatus('error')};
      }catch{
        if(!active)return;
        setLogStatus('error');
        reconnect=setTimeout(()=>void connect(),2500);
      }
    };
    void connect();
    return()=>{active=false;if(reconnect)clearTimeout(reconnect);socket?.close()};
  },[params.id]);

  async function rollback(){
    if(!deployment)return;
    setRollingBack(true);setError('');
    try{
      await api(`/deployments/${deployment.id}/rollback`,{
        method:'POST',
        body:JSON.stringify({confirm:true})
      });
      setRollbackConfirm(false);
      await load(true);
    }catch(e){setError(e instanceof Error?e.message:'Rollback failed')}
    finally{setRollingBack(false)}
  }

  async function cancelDeployment(){
    if(!deployment)return;
    setCancelling(true);setError('');
    try{
      await api(`/deployments/${deployment.id}/cancel`,{
        method:'POST',
        body:JSON.stringify({confirm:true})
      });
      setCancelConfirm(false);
      setDeployment(current=>current?{...current,cancel_requested_at:new Date().toISOString()}:current);
      await load(true);
    }catch(e){setError(e instanceof Error?e.message:'Cancellation request failed')}
    finally{setCancelling(false)}
  }

  const rollbackAvailable=useMemo(()=>{
    if(!deployment||deployment.state!=='successful')return false;
    if(deployment.deployment_type==='dockerfile')return Boolean(deployment.container_id&&deployment.previous_container_id);
    if(deployment.deployment_type==='compose')return Boolean(
      deployment.compose_container_ids&&deployment.previous_compose_container_ids&&
      Object.keys(deployment.previous_compose_container_ids).length
    );
    return false;
  },[deployment]);

  const currentStageIndex=deployment
    ? deployment.state==='cancelled'
      ? Math.max(0,...deployment.events.map(event=>stages.indexOf(event.state as typeof stages[number])).filter(index=>index>=0))
      : stages.indexOf(deployment.state as typeof stages[number])
    : -1;
  const cancelAvailable=Boolean(deployment&&!terminalStates.has(deployment.state)&&!deployment.cancel_requested_at);
  const visibleLogs=logs.filter(row=>{
    if(logFilter==='all')return true;
    if(logFilter==='build')return row.stream==='build';
    if(logFilter==='runtime')return row.stream==='stdout'||row.stream==='stderr'||row.stream==='system';
    return row.stream==='stderr';
  });

  return <div className="deploy-detail-page">
    <header className="deploy-topbar">
      <button onClick={()=>router.push('/deployments')}><ArrowLeft size={16}/> Deployments</button>
      <span><Activity size={18}/> clouddeck.</span>
      <button className="deploy-refresh compact" onClick={()=>void load()}><RefreshCw size={14}/> Refresh</button>
    </header>

    <main className="deploy-detail-content">
      {error&&<div className="notice" role="status">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}
      {!deployment? <div className="empty">{loading?'Loading deployment…':'Deployment not found.'}</div> : <>
        <section className="deploy-detail-hero">
          <div>
            <span className="eyebrow">DEPLOYMENT / {shortSha(deployment.commit_sha)}</span>
            <h1>{deployment.application_name}</h1>
            <div className="deploy-detail-sub">
              <span className={`deployment-state ${deployment.state}`}>{stateText(deployment.state)}</span>
              <span><GitBranch size={13}/>{deployment.repository_full_name} · {deployment.branch}</span>
            </div>
          </div>
          <div className="deploy-detail-actions">
            {cancelAvailable&&<button className="cancel-button" onClick={()=>setCancelConfirm(true)}><CircleStop size={15}/> Cancel deployment</button>}
            {deployment.cancel_requested_at&&!terminalStates.has(deployment.state)&&<button className="cancel-button pending" disabled><CircleStop size={15}/> Cancelling…</button>}
            {rollbackAvailable&&<button className="rollback-button" onClick={()=>setRollbackConfirm(true)}><RotateCcw size={15}/> Roll back</button>}
          </div>
        </section>

        {cancelConfirm&&<section className="rollback-confirm cancel-confirm">
          <div><OctagonAlert size={21}/><span><strong>Cancel this deployment?</strong><small>CloudDeck will stop only this deployment execution. If runtime replacement already started, the Agent attempts to restore the previous runtime before cancellation completes.</small></span></div>
          <div><button onClick={()=>setCancelConfirm(false)} disabled={cancelling}>Keep running</button><button className="danger-solid" onClick={()=>void cancelDeployment()} disabled={cancelling}>{cancelling?'Requesting…':'Confirm cancellation'}</button></div>
        </section>}

        {rollbackConfirm&&<section className="rollback-confirm">
          <div><OctagonAlert size={21}/><span><strong>Confirm rollback</strong><small>This restores the previous {deployment.deployment_type==='compose'?'Compose project':'container'} and waits for readiness before changing deployment state.</small></span></div>
          <div><button onClick={()=>setRollbackConfirm(false)} disabled={rollingBack}>Cancel</button><button className="danger-solid" onClick={()=>void rollback()} disabled={rollingBack}>{rollingBack?'Restoring…':'Confirm rollback'}</button></div>
        </section>}

        <section className="deployment-stage-card">
          <div className="deploy-section-head"><div><h2>Pipeline</h2><p>Guarded deployment state machine.</p></div><span>{deployment.state}</span></div>
          <div className="deployment-stage-track">
            {stages.map((stage,index)=>{
              const reached=currentStageIndex>=index||deployment.state==='successful'||deployment.state==='rolled-back';
              const active=deployment.state===stage;
              const failed=deployment.state==='failed'&&index===Math.max(0,deployment.events.findIndex(event=>event.state==='failed')-1);
              const cancelled=deployment.state==='cancelled'&&index===currentStageIndex;
              return <div className={`pipeline-stage ${reached?'reached':''} ${active?'active':''} ${failed?'failed':''} ${cancelled?'cancelled':''}`} key={stage}>
                <span>{failed?<XCircle size={15}/>:cancelled?<CircleStop size={15}/>:reached?<CheckCircle2 size={15}/>:<Clock3 size={15}/>}</span>
                <strong>{stateText(stage)}</strong>
              </div>
            })}
          </div>
          {deployment.state==='failed'&&<div className="deployment-failure"><XCircle size={16}/><span><strong>{deployment.failure_code??'DEPLOYMENT_FAILED'}</strong> The deployment stopped safely before being marked successful.</span></div>}
          {deployment.state==='cancelled'&&<div className="deployment-cancelled"><CircleStop size={16}/><span><strong>Deployment cancelled.</strong> Execution stopped before CloudDeck marked it successful.</span></div>}
        </section>

        <section className="deploy-detail-grid">
          <article className="deploy-meta-card">
            <h2>Source</h2>
            <div><GitCommit size={15}/><span>Commit</span><strong>{deployment.commit_sha??'—'}</strong></div>
            <div><GitBranch size={15}/><span>Branch</span><strong>{deployment.branch??'—'}</strong></div>
            <div><Boxes size={15}/><span>Type</span><strong>{deployment.deployment_type??'—'}</strong></div>
            <div><Workflow size={15}/><span>Source path</span><strong>{deployment.source_path??'—'}</strong></div>
          </article>
          <article className="deploy-meta-card">
            <h2>Runtime</h2>
            <div><Server size={15}/><span>Target</span><strong>{deployment.deployment_type==='compose'?deployment.compose_project:deployment.container_name}</strong></div>
            <div><ShieldCheck size={15}/><span>Restart policy</span><strong>{deployment.restart_policy??(deployment.deployment_type==='compose'?'Per service':'—')}</strong></div>
            <div><TimerReset size={15}/><span>Started</span><strong>{time(deployment.started_at)}</strong></div>
            <div><Clock3 size={15}/><span>Finished</span><strong>{time(deployment.finished_at)}</strong></div>
          </article>
        </section>

        {deployment.deployment_type==='dockerfile'&&<section className="deploy-runtime-card">
          <div className="deploy-section-head"><div><h2>Container result</h2><p>Runtime identifiers captured after activation.</p></div></div>
          <div className="runtime-result-grid">
            <div><span>Image</span><strong>{deployment.image_ref??'Not available yet'}</strong></div>
            <div><span>Active container</span><code>{deployment.container_id??'—'}</code></div>
            <div><span>Previous container</span><code>{deployment.previous_container_id??'No rollback target'}</code></div>
            <div><span>Port mapping</span><strong>{deployment.host_port&&deployment.container_port?`${deployment.host_port} → ${deployment.container_port}`:'Not published'}</strong></div>
          </div>
        </section>}

        {deployment.deployment_type==='compose'&&<section className="deploy-runtime-card">
          <div className="deploy-section-head"><div><h2>Compose services</h2><p>Service-to-container snapshot for this deployment.</p></div><span>{deployment.compose_project}</span></div>
          <div className="compose-result-list">
            {Object.entries(deployment.compose_container_ids??{}).map(([service,id])=><div key={service}><span><Boxes size={14}/><strong>{service}</strong></span><code>{id}</code><i>active</i></div>)}
            {!Object.keys(deployment.compose_container_ids??{}).length&&<div className="deployment-empty">Service results appear after activation.</div>}
          </div>
        </section>}

        <section className="deployment-log-card">
          <div className="deploy-section-head">
            <div><h2><ScrollText size={17}/> Live logs</h2><p>Durable build and runtime output · latest 1,000 lines in this view.</p></div>
            <span className={`deployment-log-status ${logStatus}`}><Radio size={11}/>{logStatus}</span>
          </div>
          <div className="deployment-log-toolbar">
            {(['all','build','runtime','errors'] as const).map(filter=><button key={filter} className={logFilter===filter?'active':''} onClick={()=>setLogFilter(filter)}>{filter}</button>)}
            <span>{visibleLogs.length} lines</span>
          </div>
          <div className="deployment-log-console" role="log" aria-live="polite">
            {visibleLogs.map(row=><div className={`deployment-log-line ${row.stream}`} key={row.id}>
              <time>{row.createdAt?new Date(row.createdAt).toLocaleTimeString():'--:--:--'}</time>
              <span className="log-stage">{row.stage}</span>
              <span className="log-stream">{row.stream}</span>
              <code>{row.line}</code>
            </div>)}
            {!visibleLogs.length&&<div className="deployment-log-empty">{logStatus==='connecting'?'Connecting to deployment logs…':'No log lines match this filter.'}</div>}
          </div>
        </section>

        <section className="deploy-timeline-card">
          <div className="deploy-section-head"><div><h2>Timeline</h2><p>Append-only deployment events.</p></div><span>{deployment.events.length} events</span></div>
          <div className="deployment-timeline">
            {deployment.events.map((event,index)=><div className="timeline-event" key={event.id}>
              <span className={`timeline-dot ${event.state}`}>{event.state==='failed'?<XCircle size={14}/>:event.state==='cancelled'?<CircleStop size={14}/>:<CheckCircle2 size={14}/>}</span>
              <div><strong>{stateText(event.state)}</strong><p>{event.message??'State transition recorded.'}</p><small>{time(event.created_at)}</small></div>
              <em>{String(index+1).padStart(2,'0')}</em>
            </div>)}
          </div>
        </section>
      </>}
    </main>
  </div>
}
