'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import {
  Activity,ArrowLeft,CheckCircle2,DatabaseBackup,HardDrive,History,Play,Plus,RefreshCw,ShieldCheck,Trash2,TriangleAlert
} from 'lucide-react';
import {api} from '@/lib/api';

type Org={id:string;name:string;role:string};
type ServerRow={id:string;name:string;hostname:string|null;status:'online'|'offline'|'pending'};
type BackupJob={
  id:string;organization_id:string;server_id:string;name:string;kind:'directory'|'docker_volume';source:string;
  schedule:string;retention_count:number;target_type:'local';enabled:boolean;server_name:string;server_status:string;
  latest_backup_id:string|null;latest_backup_status:'running'|'successful'|'failed'|null;latest_backup_size:number|null;
  latest_verified_at:string|null;latest_backup_created_at:string|null;
};
type BackupRow={
  id:string;job_id:string;status:'pending'|'running'|'verifying'|'successful'|'failed';size_bytes:number|null;
  verified_at:string|null;started_at:string|null;finished_at:string|null;storage_key:string|null;sha256:string|null;
  error:string|null;manifest:{entryCount?:number;verification?:string};created_at:string;
};
type Form={name:string;serverId:string;kind:'directory'|'docker_volume';source:string;retentionCount:string};

const emptyForm:Form={name:'',serverId:'',kind:'directory',source:'',retentionCount:'7'};

function when(value:string|null){return value?new Date(value).toLocaleString():'Never'}
function bytes(value:number|null){
  if(value===null||value===undefined)return '—';
  if(value<1024)return `${value} B`;
  const units=['KB','MB','GB','TB'];let n=value/1024;let i=0;
  while(n>=1024&&i<units.length-1){n/=1024;i++}
  return `${n.toFixed(n>=10?1:2)} ${units[i]}`;
}

export default function BackupsPage(){
  const router=useRouter();
  const [org,setOrg]=useState<Org|null>(null);
  const [servers,setServers]=useState<ServerRow[]>([]);
  const [jobs,setJobs]=useState<BackupJob[]>([]);
  const [history,setHistory]=useState<Record<string,BackupRow[]>>({});
  const [expanded,setExpanded]=useState<string|null>(null);
  const [form,setForm]=useState<Form>(emptyForm);
  const [showCreate,setShowCreate]=useState(false);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState('');

  const canManage=org?.role==='owner'||org?.role==='admin';

  async function load(silent=false){
    if(!silent)setLoading(true);
    try{
      const orgs=await api<{organizations:Org[]}>('/organizations');
      const selected=orgs.organizations[0];
      if(!selected)throw new Error('No workspace found');
      const [jobData,serverData]=await Promise.all([
        api<{jobs:BackupJob[]}>(`/organizations/${selected.id}/backup-jobs`),
        api<{servers:ServerRow[]}>(`/organizations/${selected.id}/servers`)
      ]);
      setOrg(selected);setJobs(jobData.jobs);setServers(serverData.servers);setError('');
      setForm(current=>current.serverId||!serverData.servers.length?current:{...current,serverId:serverData.servers[0].id});
    }catch(e){setError(e instanceof Error?e.message:'Unable to load backups')}
    finally{if(!silent)setLoading(false)}
  }

  useEffect(()=>{void load();},[]);

  async function createJob(event:React.FormEvent){
    event.preventDefault();
    if(!org||!canManage)return;
    setBusy('create');setError('');
    try{
      await api(`/organizations/${org.id}/backup-jobs`,{
        method:'POST',
        body:JSON.stringify({
          name:form.name.trim(),
          serverId:form.serverId,
          kind:form.kind,
          source:form.source.trim(),
          retentionCount:Number(form.retentionCount)
        })
      });
      setShowCreate(false);setForm(current=>({...emptyForm,serverId:current.serverId}));await load(true);
    }catch(e){setError(e instanceof Error?e.message:'Unable to create backup job')}
    finally{setBusy(null)}
  }

  async function run(job:BackupJob){
    if(!canManage||job.server_status!=='online')return;
    setBusy(`run:${job.id}`);setError('');
    try{
      await api(`/backup-jobs/${job.id}/run`,{method:'POST'});
      await load(true);
      if(expanded===job.id)await loadHistory(job.id);
    }catch(e){setError(e instanceof Error?e.message:'Backup run failed')}
    finally{setBusy(null)}
  }

  async function loadHistory(jobId:string){
    setBusy(`history:${jobId}`);
    try{
      const result=await api<{backups:BackupRow[]}>(`/backup-jobs/${jobId}/backups`);
      setHistory(current=>({...current,[jobId]:result.backups}));
      setExpanded(jobId);
    }catch(e){setError(e instanceof Error?e.message:'Unable to load backup history')}
    finally{setBusy(null)}
  }

  async function remove(job:BackupJob){
    if(!canManage||!confirm(`Delete backup job "${job.name}" and its local archives? This cannot be undone.`))return;
    setBusy(`delete:${job.id}`);setError('');
    try{
      await api(`/backup-jobs/${job.id}`,{method:'DELETE',body:JSON.stringify({confirm:true})});
      setJobs(items=>items.filter(item=>item.id!==job.id));
      setHistory(current=>{const next={...current};delete next[job.id];return next});
    }catch(e){setError(e instanceof Error?e.message:'Unable to delete backup job')}
    finally{setBusy(null)}
  }

  const summary=useMemo(()=>({
    total:jobs.length,
    verified:jobs.filter(item=>item.latest_backup_status==='successful').length,
    failed:jobs.filter(item=>item.latest_backup_status==='failed').length,
    never:jobs.filter(item=>!item.latest_backup_id).length
  }),[jobs]);

  return <div className="deploy-page ops-page">
    <header className="deploy-topbar">
      <button onClick={()=>router.push('/dashboard')}><ArrowLeft size={16}/> Dashboard</button>
      <span><Activity size={18}/> clouddeck.</span>
      <div>{org?.name??'Workspace'} · Backups</div>
    </header>

    <main className="deploy-content">
      <section className="deploy-hero">
        <div><span className="eyebrow">OPERATIONS / BACKUPS</span><h1>Verified backups</h1><p>Create Agent-verified local backups for allowlisted directories and Docker volumes.</p></div>
        <div className="deploy-hero-actions"><button className="deploy-refresh" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/> Refresh</button>{canManage&&<button className="primary" onClick={()=>setShowCreate(value=>!value)}><Plus size={15}/> New backup job</button>}</div>
      </section>

      {error&&<div className="notice" role="status">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}

      <section className="deploy-stats backup-stats">
        <div><DatabaseBackup size={18}/><span>Backup jobs</span><strong>{summary.total}</strong></div>
        <div><CheckCircle2 size={18}/><span>Latest verified</span><strong>{summary.verified}</strong></div>
        <div><TriangleAlert size={18}/><span>Latest failed</span><strong>{summary.failed}</strong></div>
        <div><History size={18}/><span>Never run</span><strong>{summary.never}</strong></div>
      </section>

      {showCreate&&canManage&&<form className="deploy-section backup-form" onSubmit={createJob}>
        <div className="deploy-section-head"><div><h2>Create local backup job</h2><p>Directory paths are accepted by the Agent only when they resolve under its configured backup source allowlist.</p></div></div>
        <div className="domain-form-grid">
          <label>Name<input required maxLength={120} value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Production uploads"/></label>
          <label>Server<select required value={form.serverId} onChange={e=>setForm({...form,serverId:e.target.value})}><option value="">Choose server</option>{servers.map(item=><option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label>
          <label>Source type<select value={form.kind} onChange={e=>setForm({...form,kind:e.target.value as Form['kind'],source:''})}><option value="directory">Directory</option><option value="docker_volume">Docker volume</option></select></label>
          <label>{form.kind==='directory'?'Absolute directory':'Docker volume name'}<input required value={form.source} onChange={e=>setForm({...form,source:e.target.value})} placeholder={form.kind==='directory'?'/srv/app/uploads':'postgres-data'}/></label>
          <label>Retention count<input required type="number" min={1} max={100} value={form.retentionCount} onChange={e=>setForm({...form,retentionCount:e.target.value})}/></label>
        </div>
        <div className="domain-form-actions"><button type="button" onClick={()=>setShowCreate(false)}>Cancel</button><button className="primary" disabled={busy==='create'||!servers.length}>{busy==='create'?'Creating…':'Create job'}</button></div>
      </form>}

      <section className="deploy-section">
        <div className="deploy-section-head"><div><h2>Backup jobs</h2><p>Success means the Agent closed, synced, re-opened, and fully read the archive before verification was persisted.</p></div><span>{jobs.length} configured</span></div>
        <div className="backup-list">
          {jobs.map(job=><article className="backup-card" key={job.id}>
            <div className="backup-main">
              <span className="backup-icon">{job.kind==='docker_volume'?<HardDrive size={18}/>:<DatabaseBackup size={18}/>}</span>
              <div className="backup-copy"><strong>{job.name}</strong><small>{job.server_name} · {job.kind.replace('_',' ')} · {job.source}</small><em>Retention {job.retention_count} · local target</em></div>
              <div className="backup-latest">
                <span className={`health-state ${job.latest_backup_status==='successful'?'healthy':job.latest_backup_status==='failed'?'warning':'pending'}`}>{job.latest_backup_status??'never run'}</span>
                <strong>{bytes(job.latest_backup_size)}</strong>
                <small>{job.latest_verified_at?`Verified ${when(job.latest_verified_at)}`:job.latest_backup_created_at?when(job.latest_backup_created_at):'No backups yet'}</small>
              </div>
              <div className="backup-actions">
                <button title="View history" onClick={()=>expanded===job.id?setExpanded(null):void loadHistory(job.id)} disabled={busy===`history:${job.id}`}><History size={15}/></button>
                {canManage&&<button className="primary compact" title="Run backup now" onClick={()=>void run(job)} disabled={busy===`run:${job.id}`||job.server_status!=='online'}><Play size={14}/>{busy===`run:${job.id}`?'Running…':'Run now'}</button>}
                {canManage&&<button className="danger" title="Delete backup job" onClick={()=>void remove(job)} disabled={busy===`delete:${job.id}`}><Trash2 size={15}/></button>}
              </div>
            </div>
            {expanded===job.id&&<div className="backup-history">
              {(history[job.id]??[]).map(item=><div className="backup-history-row" key={item.id}>
                <span className={`health-state ${item.status==='successful'?'healthy':item.status==='failed'?'warning':'pending'}`}>{item.status}</span>
                <strong>{bytes(item.size_bytes)}</strong>
                <span>{when(item.created_at)}</span>
                <code>{item.sha256?item.sha256.slice(0,16)+'…':'—'}</code>
                <small>{item.status==='successful'?`${item.manifest?.entryCount??0} entries · verified`:item.error??'In progress'}</small>
              </div>)}
              {!history[job.id]?.length&&<div className="deployment-empty">No backup runs yet.</div>}
            </div>}
          </article>)}
          {!jobs.length&&!loading&&<div className="deployment-empty">No backup jobs configured yet.</div>}
        </div>
      </section>

      <section className="domain-security-note">
        <ShieldCheck size={17}/><div><strong>Verified before successful</strong><span>CloudDeck never marks a local backup successful until the Agent has re-opened the generated archive, validated its paths, read every entry, and returned SHA-256 metadata.</span></div>
      </section>
    </main>
  </div>
}
