'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import {
  Activity,ArrowLeft,ArrowUpRight,Boxes,GitBranch,GitCommit,RefreshCw,Rocket,
  RotateCcw,Search,Server,ToggleLeft,ToggleRight,Workflow
} from 'lucide-react';
import {api} from '@/lib/api';

type Org={id:string;name:string;role:string};
type Application={
  id:string;server_id:string;name:string;repository_full_name:string;branch:string;
  deployment_type:'dockerfile'|'compose';source_path:string;auto_deploy:boolean;
  server_name:string|null;server_status:string|null;compose_project:string|null;container_name:string|null;
};
type Deployment={
  id:string;application_id:string;application_name:string;commit_sha:string|null;branch:string|null;
  state:string;created_at:string;started_at:string|null;finished_at:string|null;failure_code:string|null;
  repository_full_name:string|null;deployment_type:'dockerfile'|'compose'|null;
};

const terminalStates=new Set(['successful','failed','rolled-back']);

function shortSha(value:string|null){return value?value.slice(0,8):'pending'}
function when(value:string){return new Date(value).toLocaleString()}
function stateLabel(value:string){return value.replaceAll('-',' ')}

export default function DeploymentsPage(){
  const router=useRouter();
  const [org,setOrg]=useState<Org|null>(null);
  const [applications,setApplications]=useState<Application[]>([]);
  const [deployments,setDeployments]=useState<Deployment[]>([]);
  const [filter,setFilter]=useState('');
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState<string|null>(null);

  async function load(silent=false){
    if(!silent)setLoading(true);
    try{
      const orgs=await api<{organizations:Org[]}>('/organizations');
      const selected=orgs.organizations[0];
      if(!selected)throw new Error('No workspace found');
      const [apps,deps]=await Promise.all([
        api<{applications:Application[]}>(`/organizations/${selected.id}/applications`),
        api<{deployments:Deployment[]}>(`/organizations/${selected.id}/deployments?limit=100`)
      ]);
      setOrg(selected);setApplications(apps.applications);setDeployments(deps.deployments);setError('');
    }catch(e){
      setError(e instanceof Error?e.message:'Unable to load deployments');
    }finally{if(!silent)setLoading(false)}
  }

  useEffect(()=>{
    void load();
    const timer=setInterval(()=>void load(true),8000);
    return()=>clearInterval(timer);
  },[]);

  async function deploy(application:Application){
    setBusy(`deploy:${application.id}`);setError('');
    try{
      const created=await api<{id:string;dispatch:'enqueued'|'pending'}>(`/applications/${application.id}/deployments`,{
        method:'POST',
        headers:{'Idempotency-Key':crypto.randomUUID()},
        body:JSON.stringify({})
      });
      router.push(`/deployments/${created.id}`);
    }catch(e){setError(e instanceof Error?e.message:'Unable to start deployment')}
    finally{setBusy(null)}
  }

  async function toggleAuto(application:Application){
    setBusy(`auto:${application.id}`);setError('');
    try{
      await api(`/applications/${application.id}/auto-deploy`,{
        method:'PUT',
        body:JSON.stringify({enabled:!application.auto_deploy})
      });
      setApplications(items=>items.map(item=>item.id===application.id?{...item,auto_deploy:!item.auto_deploy}:item));
    }catch(e){setError(e instanceof Error?e.message:'Unable to update auto-deploy')}
    finally{setBusy(null)}
  }

  const visible=useMemo(()=>{
    const q=filter.trim().toLowerCase();
    if(!q)return deployments;
    return deployments.filter(item=>[
      item.application_name,item.repository_full_name,item.branch,item.state,item.commit_sha
    ].some(value=>value?.toLowerCase().includes(q)));
  },[deployments,filter]);

  const active=deployments.filter(item=>!terminalStates.has(item.state)).length;
  const failed=deployments.filter(item=>item.state==='failed').length;
  const successful=deployments.filter(item=>item.state==='successful').length;

  return <div className="deploy-page">
    <header className="deploy-topbar">
      <button onClick={()=>router.push('/dashboard')}><ArrowLeft size={16}/> Dashboard</button>
      <span><Activity size={18}/> clouddeck.</span>
      <div>{org?.name??'Workspace'} · Deployments</div>
    </header>

    <main className="deploy-content">
      <section className="deploy-hero">
        <div>
          <span className="eyebrow">OPERATIONS / DEPLOYMENTS</span>
          <h1>Ship with confidence</h1>
          <p>Deploy pinned GitHub commits, watch every stage, and roll back safely.</p>
        </div>
        <button className="deploy-refresh" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/> Refresh</button>
      </section>

      {error&&<div className="notice" role="status">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}

      <section className="deploy-stats">
        <div><Rocket size={18}/><span>Total</span><strong>{deployments.length}</strong></div>
        <div><Workflow size={18}/><span>Active</span><strong>{active}</strong></div>
        <div><GitCommit size={18}/><span>Successful</span><strong>{successful}</strong></div>
        <div><RotateCcw size={18}/><span>Failed</span><strong>{failed}</strong></div>
      </section>

      <section className="deploy-section">
        <div className="deploy-section-head">
          <div><h2>Applications</h2><p>Verified runtime targets connected to GitHub.</p></div>
          <span>{applications.length} configured</span>
        </div>
        <div className="application-grid">
          {applications.map(application=><article className="application-card" key={application.id}>
            <div className="application-card-top">
              <span className="application-icon"><Boxes size={18}/></span>
              <span className={`deploy-type ${application.deployment_type}`}>{application.deployment_type}</span>
            </div>
            <h3>{application.name}</h3>
            <div className="repo-line"><GitBranch size={14}/><span>{application.repository_full_name}</span><strong>{application.branch}</strong></div>
            <div className="runtime-line"><Server size={14}/><span>{application.server_name??'Server'}</span><i className={application.server_status==='online'?'online':'offline'}/></div>
            <div className="runtime-target">{application.deployment_type==='compose'?application.compose_project:application.container_name}</div>
            <div className="application-actions">
              <button className="auto-toggle" onClick={()=>void toggleAuto(application)} disabled={busy===`auto:${application.id}`}>
                {application.auto_deploy?<ToggleRight size={20}/>:<ToggleLeft size={20}/>}
                Auto-deploy {application.auto_deploy?'on':'off'}
              </button>
              <button className="primary" onClick={()=>void deploy(application)} disabled={busy===`deploy:${application.id}`}>
                <Rocket size={15}/>{busy===`deploy:${application.id}`?'Starting…':'Deploy now'}
              </button>
            </div>
          </article>)}
          {!applications.length&&!loading&&<div className="empty">No applications configured yet.</div>}
        </div>
      </section>

      <section className="deploy-section">
        <div className="deploy-section-head">
          <div><h2>Deployment history</h2><p>Latest 100 deployments in this workspace.</p></div>
          <label className="deploy-search"><Search size={15}/><input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Search app, repo, branch, state…"/></label>
        </div>

        <div className="deployment-table">
          <div className="deployment-row header">
            <span>Application</span><span>Source</span><span>State</span><span>Started</span><span/>
          </div>
          {visible.map(item=><button className="deployment-row" key={item.id} onClick={()=>router.push(`/deployments/${item.id}`)}>
            <span className="deployment-app"><strong>{item.application_name}</strong><small>{item.deployment_type??'deployment'}</small></span>
            <span className="deployment-source"><strong>{shortSha(item.commit_sha)}</strong><small>{item.branch??'—'}</small></span>
            <span><i className={`deployment-state ${item.state}`}>{stateLabel(item.state)}</i>{item.failure_code&&<small className="failure-code">{item.failure_code}</small>}</span>
            <span className="deployment-time">{when(item.created_at)}</span>
            <span className="deployment-open">View <ArrowUpRight size={13}/></span>
          </button>)}
          {!visible.length&&<div className="deployment-empty">{loading?'Loading deployments…':'No deployments found.'}</div>}
        </div>
      </section>
    </main>
  </div>
}
