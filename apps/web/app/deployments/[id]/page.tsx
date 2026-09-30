'use client';

import {useEffect,useMemo,useState} from 'react';
import {useParams,useRouter} from 'next/navigation';
import {
  Activity,ArrowLeft,Boxes,CheckCircle2,Clock3,GitBranch,GitCommit,OctagonAlert,
  RefreshCw,RotateCcw,Server,ShieldCheck,TimerReset,Workflow,XCircle
} from 'lucide-react';
import {api} from '@/lib/api';

type DeploymentEvent={id:number;state:string;message:string|null;created_at:string};
type DeploymentDetail={
  id:string;application_id:string;application_name:string;organization_id:string;
  commit_sha:string|null;branch:string|null;state:string;created_at:string;started_at:string|null;
  finished_at:string|null;failure_code:string|null;requested_by:string|null;
  repository_full_name:string|null;deployment_type:'dockerfile'|'compose'|null;source_path:string|null;
  container_name:string|null;container_port:number|null;host_port:number|null;restart_policy:string|null;
  compose_project:string|null;image_ref:string|null;container_id:string|null;previous_container_id:string|null;
  compose_container_ids:Record<string,string>|null;previous_compose_container_ids:Record<string,string>|null;
  events:DeploymentEvent[];
};

const terminalStates=new Set(['successful','failed','rolled-back']);
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

  const rollbackAvailable=useMemo(()=>{
    if(!deployment||deployment.state!=='successful')return false;
    if(deployment.deployment_type==='dockerfile')return Boolean(deployment.container_id&&deployment.previous_container_id);
    if(deployment.deployment_type==='compose')return Boolean(
      deployment.compose_container_ids&&deployment.previous_compose_container_ids&&
      Object.keys(deployment.previous_compose_container_ids).length
    );
    return false;
  },[deployment]);

  const currentStageIndex=deployment?stages.indexOf(deployment.state as typeof stages[number]):-1;

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
            {rollbackAvailable&&<button className="rollback-button" onClick={()=>setRollbackConfirm(true)}><RotateCcw size={15}/> Roll back</button>}
          </div>
        </section>

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
              return <div className={`pipeline-stage ${reached?'reached':''} ${active?'active':''} ${failed?'failed':''}`} key={stage}>
                <span>{failed?<XCircle size={15}/>:reached?<CheckCircle2 size={15}/>:<Clock3 size={15}/>}</span>
                <strong>{stateText(stage)}</strong>
              </div>
            })}
          </div>
          {deployment.state==='failed'&&<div className="deployment-failure"><XCircle size={16}/><span><strong>{deployment.failure_code??'DEPLOYMENT_FAILED'}</strong> The deployment stopped safely before being marked successful.</span></div>}
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

        <section className="deploy-timeline-card">
          <div className="deploy-section-head"><div><h2>Timeline</h2><p>Append-only deployment events.</p></div><span>{deployment.events.length} events</span></div>
          <div className="deployment-timeline">
            {deployment.events.map((event,index)=><div className="timeline-event" key={event.id}>
              <span className={`timeline-dot ${event.state}`}>{event.state==='failed'?<XCircle size={14}/>:<CheckCircle2 size={14}/>}</span>
              <div><strong>{stateText(event.state)}</strong><p>{event.message??'State transition recorded.'}</p><small>{time(event.created_at)}</small></div>
              <em>{String(index+1).padStart(2,'0')}</em>
            </div>)}
          </div>
        </section>
      </>}
    </main>
  </div>
}
