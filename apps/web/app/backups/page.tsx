'use client';

import {useEffect,useMemo,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {
  Activity,ArrowLeft,CheckCircle2,DatabaseBackup,HardDrive,History,Play,Plus,RefreshCw,ShieldCheck,Trash2,TriangleAlert
} from 'lucide-react';
import {api} from '@/lib/api';

type Org={id:string;name:string;role:string};
type ServerRow={id:string;name:string;hostname:string|null;status:'online'|'offline'|'pending'};
type BackupKind='directory'|'docker_volume'|'postgres'|'mysql';
type BackupSecret={id:string;name:string;kind:string};
type BackupSchedule='manual'|'hourly'|'daily'|'weekly';
type Credentials={name:string;host:string;port:string;username:string;password:string;sslMode:'disable'|'require'};
const emptyCredentials:Credentials={name:'',host:'',port:'5432',username:'',password:'',sslMode:'require'};
const sourceLabels:Record<BackupKind,string>={directory:'Directory',docker_volume:'Docker volume',postgres:'PostgreSQL',mysql:'MySQL'};

type BackupJob={
  id:string;organization_id:string;server_id:string;name:string;kind:BackupKind;source:string;source_secret_id:string|null;
  schedule:BackupSchedule;retention_count:number;target_type:'local';enabled:boolean;server_name:string;server_status:string;
  next_run_at:string|null;last_scheduled_at:string|null;
  latest_backup_id:string|null;latest_backup_status:'running'|'successful'|'failed'|null;latest_backup_size:number|null;
  latest_verified_at:string|null;latest_backup_created_at:string|null;
};
type BackupRow={
  id:string;job_id:string;status:'pending'|'running'|'verifying'|'successful'|'failed';size_bytes:number|null;
  verified_at:string|null;started_at:string|null;finished_at:string|null;storage_key:string|null;sha256:string|null;
  error:string|null;manifest:{entryCount?:number;verification?:string};created_at:string;
};
type Form={name:string;serverId:string;kind:BackupKind;source:string;sourceSecretId:string;retentionCount:string;schedule:BackupSchedule};

const emptyForm:Form={name:'',serverId:'',kind:'directory',source:'',sourceSecretId:'',retentionCount:'7',schedule:'manual'};

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
  const credentialFields=useRef<HTMLFieldSetElement>(null);
  const [org,setOrg]=useState<Org|null>(null);
  const [servers,setServers]=useState<ServerRow[]>([]);
  const [secrets,setSecrets]=useState<BackupSecret[]>([]);
  const [credentials,setCredentials]=useState<Credentials>(emptyCredentials);
  const [showCredentials,setShowCredentials]=useState(false);
  const [jobs,setJobs]=useState<BackupJob[]>([]);
  const [history,setHistory]=useState<Record<string,BackupRow[]>>({});
  const [expanded,setExpanded]=useState<string|null>(null);
  const [form,setForm]=useState<Form>(emptyForm);
  const [showCreate,setShowCreate]=useState(false);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState('');

  const canManage=org?.role==='owner'||org?.role==='admin';
  const isDatabase=form.kind==='postgres'||form.kind==='mysql';

  async function load(silent=false){
    if(!silent)setLoading(true);
    try{
      const orgs=await api<{organizations:Org[]}>('/organizations');
      const selected=orgs.organizations[0];
      if(!selected)throw new Error('No workspace found');
      const [jobData,serverData,secretData]=await Promise.all([
        api<{jobs:BackupJob[]}>(`/organizations/${selected.id}/backup-jobs`),
        api<{servers:ServerRow[]}>(`/organizations/${selected.id}/servers`),
        api<{secrets:BackupSecret[]}>(`/organizations/${selected.id}/secrets`)
      ]);
      setOrg(selected);setJobs(jobData.jobs);setServers(serverData.servers);setSecrets(secretData.secrets.filter(item=>item.kind==='backup'));setError('');
      setForm(current=>current.serverId||!serverData.servers.length?current:{...current,serverId:serverData.servers[0].id});
    }catch(e){setError(e instanceof Error?e.message:'Unable to load backups')}
    finally{if(!silent)setLoading(false)}
  }

  useEffect(()=>{void load();},[]);

  async function createJob(event:React.FormEvent){
    event.preventDefault();
    if(!org||!canManage||busy!==null||showCredentials||(isDatabase&&!form.sourceSecretId))return;
    setBusy('create');setError('');
    try{
      await api(`/organizations/${org.id}/backup-jobs`,{
        method:'POST',
        body:JSON.stringify({
          name:form.name.trim(),
          serverId:form.serverId,
          kind:form.kind,
          source:form.source.trim(),
          ...(isDatabase?{sourceSecretId:form.sourceSecretId}:{}),
          retentionCount:Number(form.retentionCount),
          schedule:form.schedule
        })
      });
      closeCreate();await load(true);
    }catch(e){setError(e instanceof Error?e.message:'Unable to create backup job')}
    finally{setBusy(null)}
  }

  function closeCreate(){
    setShowCreate(false);setShowCredentials(false);setCredentials(emptyCredentials);setForm(current=>({...emptyForm,serverId:current.serverId}));
  }

  function changeKind(kind:BackupKind){
    setForm(current=>({...current,kind,source:'',sourceSecretId:''}));
    setCredentials({...emptyCredentials,port:kind==='mysql'?'3306':'5432'});
    setShowCredentials(false);
  }

  async function saveCredentials(){
    if(!org||!canManage||!isDatabase)return;
    const fields=credentialFields.current?.querySelectorAll('input,select');
    if(fields&&[...fields].some(field=>!(field as HTMLInputElement).reportValidity()))return;
    if(/\s/.test(credentials.username)||[...credentials.username].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127)||[...credentials.password].some(c=>[0,10,13].includes(c.charCodeAt(0)))){
      setError('Username cannot contain whitespace or control characters. Password cannot contain line breaks or NUL.');return;
    }
    setBusy('credentials');setError('');
    try{
      const secret=await api<BackupSecret>(`/organizations/${org.id}/secrets`,{
        method:'POST',body:JSON.stringify({name:credentials.name.trim(),kind:'backup',value:JSON.stringify({
          host:credentials.host.trim(),port:Number(credentials.port),username:credentials.username,
          password:credentials.password,sslMode:credentials.sslMode
        })})
      });
      setSecrets(current=>[...current,secret]);
      setForm(current=>({...current,sourceSecretId:secret.id}));
      setCredentials({...emptyCredentials,port:form.kind==='mysql'?'3306':'5432'});setShowCredentials(false);
    }catch(e){setError(e instanceof Error?e.message:'Unable to save database credentials')}
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
        <div><span className="eyebrow">OPERATIONS / BACKUPS</span><h1>Verified backups</h1><p>Create Agent-verified local backups for allowlisted directories, Docker volumes, PostgreSQL, and MySQL, with safe recurring schedules.</p></div>
        <div className="deploy-hero-actions"><button className="deploy-refresh" onClick={()=>void load()} disabled={loading||busy!==null}><RefreshCw size={15}/> Refresh</button>{canManage&&<button className="primary" onClick={()=>showCreate?closeCreate():setShowCreate(true)} disabled={busy!==null}><Plus size={15}/> New backup job</button>}</div>
      </section>

      {error&&<div className="notice" role="status">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}

      <section className="deploy-stats backup-stats">
        <div><DatabaseBackup size={18}/><span>Backup jobs</span><strong>{summary.total}</strong></div>
        <div><CheckCircle2 size={18}/><span>Latest verified</span><strong>{summary.verified}</strong></div>
        <div><TriangleAlert size={18}/><span>Latest failed</span><strong>{summary.failed}</strong></div>
        <div><History size={18}/><span>Never run</span><strong>{summary.never}</strong></div>
      </section>

      {showCreate&&canManage&&<form className="deploy-section backup-form" onSubmit={createJob}>
        <div className="deploy-section-head"><div><h2>Create local backup job</h2><p>Choose a source on the managed server. Database jobs use encrypted connection credentials and store only a reference to the secret.</p></div></div>
        <div className="domain-form-grid">
          <label>Name<input required maxLength={120} value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Production uploads"/></label>
          <label>Server<select required value={form.serverId} onChange={e=>setForm({...form,serverId:e.target.value})}><option value="">Choose server</option>{servers.map(item=><option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label>
          <label>Source type<select disabled={busy!==null} value={form.kind} onChange={e=>changeKind(e.target.value as BackupKind)}><option value="directory">Directory</option><option value="docker_volume">Docker volume</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option></select></label>
          <label>{isDatabase?'Database name':form.kind==='directory'?'Absolute directory':'Docker volume name'}<input required value={form.source} onChange={e=>setForm({...form,source:e.target.value})} maxLength={isDatabase?128:500} pattern={isDatabase?String.raw`[A-Za-z0-9_][A-Za-z0-9_.\-]*`:undefined} placeholder={isDatabase?'appdb':form.kind==='directory'?'/srv/app/uploads':'app-data'}/></label>
          {isDatabase&&<label>Connection secret<select required value={form.sourceSecretId} onChange={e=>setForm({...form,sourceSecretId:e.target.value})}><option value="">Choose encrypted credentials</option>{secrets.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
          <label>Retention count<input required type="number" min={1} max={100} value={form.retentionCount} onChange={e=>setForm({...form,retentionCount:e.target.value})}/></label>
          <label>Schedule<select value={form.schedule} onChange={e=>setForm({...form,schedule:e.target.value as BackupSchedule})}><option value="manual">Manual only</option><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
        </div>
        {isDatabase&&<div className="backup-credentials">
          <p>Use a backup secret containing host, port, username, password, and SSL mode. <button type="button" disabled={busy!==null} onClick={()=>{setShowCredentials(value=>!value);setCredentials({...emptyCredentials,port:form.kind==='mysql'?'3306':'5432'})}}>{showCredentials?'Cancel new credentials':'Add connection credentials'}</button></p>
          {showCredentials&&<fieldset ref={credentialFields} disabled={busy!==null}>
            <legend>New encrypted database connection</legend>
            <div className="domain-form-grid">
              <label>Secret name<input required maxLength={120} pattern={String.raw`[A-Za-z0-9][A-Za-z0-9_.:\-]*`} value={credentials.name} onChange={e=>setCredentials({...credentials,name:e.target.value})} placeholder="production-db-backup"/></label>
              <label>Host<input required maxLength={253} pattern={String.raw`[A-Za-z0-9_.:\-]+`} value={credentials.host} onChange={e=>setCredentials({...credentials,host:e.target.value})} placeholder="db.internal"/></label>
              <label>Port<input required type="number" min={1} max={65535} step={1} value={credentials.port} onChange={e=>setCredentials({...credentials,port:e.target.value})}/></label>
              <label>Username<input required maxLength={128} autoComplete="off" value={credentials.username} onChange={e=>setCredentials({...credentials,username:e.target.value})}/></label>
              <label>Password<input required type="password" autoComplete="new-password" maxLength={4096} value={credentials.password} onChange={e=>setCredentials({...credentials,password:e.target.value})}/></label>
              <label>SSL mode<select value={credentials.sslMode} onChange={e=>setCredentials({...credentials,sslMode:e.target.value as Credentials['sslMode']})}><option value="require">Require SSL</option><option value="disable">Disable SSL</option></select></label>
            </div>
            <p>Credentials are encrypted when saved. The server needs pg_dump and pg_restore for PostgreSQL, or mysqldump for MySQL.</p>
            <button type="button" className="primary" disabled={busy!==null||!credentials.name.trim()||!credentials.host.trim()||!credentials.username||!credentials.password||!Number.isInteger(Number(credentials.port))||Number(credentials.port)<1||Number(credentials.port)>65535} onClick={()=>void saveCredentials()}>{busy==='credentials'?'Encrypting…':'Save encrypted credentials'}</button>
          </fieldset>}
        </div>}
        <div className="domain-form-actions"><button type="button" onClick={closeCreate} disabled={busy!==null}>Cancel</button><button className="primary" disabled={busy!==null||!servers.length||(isDatabase&&(!form.sourceSecretId||showCredentials))}>{busy==='create'?'Creating…':'Create job'}</button></div>
      </form>}

      <section className="deploy-section">
        <div className="deploy-section-head"><div><h2>Backup jobs</h2><p>Success means the Agent closed, synced, re-opened, and fully read the archive before verification was persisted.</p></div><span>{jobs.length} configured</span></div>
        <div className="backup-list">
          {jobs.map(job=><article className="backup-card" key={job.id}>
            <div className="backup-main">
              <span className="backup-icon">{job.kind==='docker_volume'?<HardDrive size={18}/>:<DatabaseBackup size={18}/>}</span>
              <div className="backup-copy"><strong>{job.name}</strong><small>{job.server_name} · {sourceLabels[job.kind]} · {job.source}</small><em>Retention {job.retention_count} · local target · {job.schedule==='manual'?'manual':job.schedule}{job.next_run_at?` · next ${when(job.next_run_at)}`:''}</em></div>
              <div className="backup-latest">
                <span className={`health-state ${job.latest_backup_status==='successful'?'healthy':job.latest_backup_status==='failed'?'warning':'pending'}`}>{job.latest_backup_status??'never run'}</span>
                <strong>{bytes(job.latest_backup_size)}</strong>
                <small>{job.latest_verified_at?`Verified ${when(job.latest_verified_at)}`:job.latest_backup_created_at?when(job.latest_backup_created_at):'No backups yet'}</small>
              </div>
              <div className="backup-actions">
                <button title="View history" onClick={()=>expanded===job.id?setExpanded(null):void loadHistory(job.id)} disabled={busy!==null}><History size={15}/></button>
                {canManage&&<button className="primary compact" title="Run backup now" onClick={()=>void run(job)} disabled={busy!==null||job.latest_backup_status==='running'||job.server_status!=='online'}><Play size={14}/>{busy===`run:${job.id}`?'Running…':'Run now'}</button>}
                {canManage&&<button className="danger" title="Delete backup job" onClick={()=>void remove(job)} disabled={busy!==null||job.latest_backup_status==='running'}><Trash2 size={15}/></button>}
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
