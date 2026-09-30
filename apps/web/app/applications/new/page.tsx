'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import {Activity,ArrowLeft,Boxes,Check,GitBranch,GitFork,PlugZap,Server,Workflow} from 'lucide-react';
import {api} from '@/lib/api';

type Org={id:string;name:string;role:string};
type ServerRow={id:string;name:string;hostname:string|null;status:string};
type Installation={id:string;installation_id:number;account_login:string;account_type:string};
type Repo={id:number;name:string;full_name:string;private:boolean;archived?:boolean;disabled?:boolean;default_branch:string};
type Branch={name:string;commit:{sha:string}};

export default function NewApplicationPage(){
  const router=useRouter();
  const [org,setOrg]=useState<Org|null>(null);
  const [servers,setServers]=useState<ServerRow[]>([]);
  const [installations,setInstallations]=useState<Installation[]>([]);
  const [repos,setRepos]=useState<Repo[]>([]);
  const [branches,setBranches]=useState<Branch[]>([]);
  const [installationId,setInstallationId]=useState('');
  const [repository,setRepository]=useState('');
  const [branch,setBranch]=useState('');
  const [name,setName]=useState('');
  const [serverId,setServerId]=useState('');
  const [deploymentType,setDeploymentType]=useState<'dockerfile'|'compose'>('dockerfile');
  const [sourcePath,setSourcePath]=useState('Dockerfile');
  const [containerName,setContainerName]=useState('');
  const [containerPort,setContainerPort]=useState('');
  const [hostPort,setHostPort]=useState('');
  const [restartPolicy,setRestartPolicy]=useState<'no'|'always'|'unless-stopped'|'on-failure'>('unless-stopped');
  const [composeProject,setComposeProject]=useState('');
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');

  useEffect(()=>{void (async()=>{
    try{
      const orgs=await api<{organizations:Org[]}>('/organizations');
      const selected=orgs.organizations[0];
      if(!selected)throw new Error('No workspace found');
      const [serverRows,github]=await Promise.all([
        api<{servers:ServerRow[]}>(`/organizations/${selected.id}/servers`),
        api<{installations:Installation[]}>(`/organizations/${selected.id}/github/installations`)
      ]);
      setOrg(selected);setServers(serverRows.servers);setInstallations(github.installations);
      if(serverRows.servers[0])setServerId(serverRows.servers[0].id);
      if(github.installations[0])setInstallationId(github.installations[0].id);
    }catch(e){setError(e instanceof Error?e.message:'Unable to load application setup')}
    finally{setLoading(false)}
  })()},[]);

  useEffect(()=>{if(!org||!installationId){setRepos([]);return}
    let cancelled=false;void (async()=>{try{
      const data=await api<{repositories:Repo[]}>(`/organizations/${org.id}/github/installations/${installationId}/repositories?perPage=100&page=1`);
      if(cancelled)return;
      const available=data.repositories.filter(repo=>!repo.archived&&!repo.disabled);
      setRepos(available);
      const first=available[0];setRepository(first?.full_name??'');setBranch(first?.default_branch??'');
    }catch(e){if(!cancelled)setError(e instanceof Error?e.message:'Unable to load repositories')}})();
    return()=>{cancelled=true};
  },[org,installationId]);

  useEffect(()=>{if(!org||!installationId||!repository){setBranches([]);return}
    const [owner,repo]=repository.split('/');if(!owner||!repo)return;
    let cancelled=false;void (async()=>{try{
      const data=await api<{branches:Branch[]}>(`/organizations/${org.id}/github/installations/${installationId}/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?perPage=100&page=1`);
      if(cancelled)return;setBranches(data.branches);
      if(!data.branches.some(item=>item.name===branch))setBranch(data.branches[0]?.name??'');
    }catch(e){if(!cancelled)setError(e instanceof Error?e.message:'Unable to load branches')}})();
    return()=>{cancelled=true};
  },[org,installationId,repository]);

  useEffect(()=>{
    setSourcePath(deploymentType==='dockerfile'?'Dockerfile':'docker-compose.yml');
    if(deploymentType==='dockerfile'&&!containerName&&name)setContainerName(name.toLowerCase().replace(/[^a-z0-9_.-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64));
    if(deploymentType==='compose'&&!composeProject&&name)setComposeProject(name.toLowerCase().replace(/[^a-z0-9_.-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64));
  },[deploymentType,name]);

  const selectedRepo=useMemo(()=>repos.find(item=>item.full_name===repository),[repos,repository]);

  async function connectGitHub(){
    if(!org)return;setBusy(true);setError('');
    try{
      const result=await api<{url:string}>(`/organizations/${org.id}/github/connect`,{method:'POST'});
      window.location.assign(result.url);
    }catch(e){setError(e instanceof Error?e.message:'Unable to start GitHub connection');setBusy(false)}
  }

  async function createApplication(event:React.FormEvent){
    event.preventDefault();if(!org)return;
    setBusy(true);setError('');
    try{
      const runtime=deploymentType==='dockerfile'?{
        containerName:containerName.trim(),
        ...(containerPort?{containerPort:Number(containerPort)}:{}),
        ...(hostPort?{hostPort:Number(hostPort)}:{}),
        restartPolicy
      }:{composeProject:composeProject.trim()};
      await api('/applications',{
        method:'POST',
        body:JSON.stringify({
          organizationId:org.id,
          serverId,
          name:name.trim(),
          githubInstallationId:installationId,
          repositoryFullName:repository,
          branch,
          deploymentType,
          sourcePath:sourcePath.trim(),
          runtime
        })
      });
      router.push('/deployments');
    }catch(e){setError(e instanceof Error?e.message:'Unable to create application')}
    finally{setBusy(false)}
  }

  return <div className="deploy-detail-page">
    <header className="deploy-topbar">
      <button onClick={()=>router.push('/deployments')}><ArrowLeft size={16}/> Deployments</button>
      <span><Activity size={18}/> clouddeck.</span>
      <div>New application</div>
    </header>
    <main className="application-setup-content">
      <section className="application-setup-hero">
        <span className="eyebrow">DEPLOYMENT / APPLICATION SETUP</span>
        <h1>Connect source to runtime</h1>
        <p>Choose a verified GitHub source and define exactly how CloudDeck should run it.</p>
      </section>

      {error&&<div className="notice" role="status">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}
      {loading?<div className="empty">Loading workspace configuration…</div>:!installations.length?
        <section className="github-connect-card">
          <span><PlugZap size={22}/></span>
          <div><h2>Connect GitHub first</h2><p>Link a GitHub App installation so CloudDeck can verify repositories and deploy pinned commits without storing long-lived tokens.</p></div>
          <button className="primary" onClick={()=>void connectGitHub()} disabled={busy}>Connect GitHub</button>
        </section>:
        <form className="application-setup-form" onSubmit={createApplication}>
          <section className="setup-card">
            <div className="setup-card-head"><span><GitFork size={18}/></span><div><h2>Source</h2><p>Select an installation, repository, and branch.</p></div></div>
            <div className="setup-grid">
              <label>GitHub installation<select value={installationId} onChange={e=>setInstallationId(e.target.value)} required>{installations.map(item=><option value={item.id} key={item.id}>{item.account_login}</option>)}</select></label>
              <label>Repository<select value={repository} onChange={e=>setRepository(e.target.value)} required>{repos.map(item=><option value={item.full_name} key={item.id}>{item.full_name}{item.private?' · private':''}</option>)}</select></label>
              <label>Branch<select value={branch} onChange={e=>setBranch(e.target.value)} required>{branches.map(item=><option value={item.name} key={item.name}>{item.name}</option>)}</select></label>
              <label>Source path<input value={sourcePath} onChange={e=>setSourcePath(e.target.value)} required maxLength={240}/></label>
            </div>
            {selectedRepo&&<div className="setup-hint"><GitBranch size={14}/> Default branch: {selectedRepo.default_branch}</div>}
          </section>

          <section className="setup-card">
            <div className="setup-card-head"><span><Server size={18}/></span><div><h2>Application</h2><p>Name the application and choose the target server.</p></div></div>
            <div className="setup-grid">
              <label>Application name<input value={name} onChange={e=>setName(e.target.value)} required maxLength={100} placeholder="Production API"/></label>
              <label>Server<select value={serverId} onChange={e=>setServerId(e.target.value)} required>{servers.map(item=><option value={item.id} key={item.id}>{item.name} · {item.status}</option>)}</select></label>
            </div>
          </section>

          <section className="setup-card">
            <div className="setup-card-head"><span><Workflow size={18}/></span><div><h2>Runtime</h2><p>CloudDeck will snapshot these settings into every deployment.</p></div></div>
            <div className="deploy-type-picker">
              <button type="button" className={deploymentType==='dockerfile'?'active':''} onClick={()=>setDeploymentType('dockerfile')}><Boxes size={16}/><span><strong>Dockerfile</strong><small>Build and replace one container</small></span>{deploymentType==='dockerfile'&&<Check size={15}/>}</button>
              <button type="button" className={deploymentType==='compose'?'active':''} onClick={()=>setDeploymentType('compose')}><Workflow size={16}/><span><strong>Docker Compose</strong><small>Deploy a safe multi-service project</small></span>{deploymentType==='compose'&&<Check size={15}/>}</button>
            </div>
            {deploymentType==='dockerfile'?<div className="setup-grid runtime">
              <label>Container name<input value={containerName} onChange={e=>setContainerName(e.target.value)} required placeholder="clouddeck-api"/></label>
              <label>Restart policy<select value={restartPolicy} onChange={e=>setRestartPolicy(e.target.value as typeof restartPolicy)}><option value="unless-stopped">unless-stopped</option><option value="always">always</option><option value="on-failure">on-failure</option><option value="no">no</option></select></label>
              <label>Container port <small>optional</small><input inputMode="numeric" value={containerPort} onChange={e=>setContainerPort(e.target.value.replace(/\D/g,''))} placeholder="4000"/></label>
              <label>Host port <small>optional</small><input inputMode="numeric" value={hostPort} onChange={e=>setHostPort(e.target.value.replace(/\D/g,''))} placeholder="14000"/></label>
            </div>:<div className="setup-grid runtime">
              <label>Compose project<input value={composeProject} onChange={e=>setComposeProject(e.target.value)} required placeholder="production"/></label>
            </div>}
          </section>

          <div className="setup-submit">
            <button type="button" onClick={()=>router.push('/deployments')}>Cancel</button>
            <button className="primary" type="submit" disabled={busy||!repository||!branch||!serverId}>{busy?'Verifying source…':'Create application'}</button>
          </div>
        </form>}
    </main>
  </div>
}
