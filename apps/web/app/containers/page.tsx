'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import {Activity,ArrowLeft,Boxes,Play,Pause,RefreshCw,RotateCw,Search,Server,Square,TriangleAlert} from 'lucide-react';
import {api} from '@/lib/api';

type Org={id:string;name:string;role:string};
type Port={privatePort:number;publicPort?:number;type:string};
type Container={id:string;name:string;image:string;state:string;status:string;ports:Port[];composeProject?:string;composeService?:string;serverId:string;serverName:string;serverHostname:string|null};
type ServerStatus={id:string;name:string;hostname:string|null;status:string;error:string|null};
type Payload={containers:Container[];servers:ServerStatus[]};

function normalizeState(value:string){return value.toLowerCase()}

export default function ContainersPage(){
  const router=useRouter();
  const [org,setOrg]=useState<Org|null>(null);
  const [containers,setContainers]=useState<Container[]>([]);
  const [servers,setServers]=useState<ServerStatus[]>([]);
  const [filter,setFilter]=useState('');
  const [state,setState]=useState<'all'|'running'|'stopped'>('all');
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState('');

  async function load(silent=false){
    if(!silent)setLoading(true);
    try{
      const orgs=await api<{organizations:Org[]}>('/organizations');
      const selected=orgs.organizations[0];
      if(!selected)throw new Error('No workspace found');
      const data=await api<Payload>(`/organizations/${selected.id}/docker/containers`);
      setOrg(selected);setContainers(data.containers);setServers(data.servers);setError('');
    }catch(e){setError(e instanceof Error?e.message:'Unable to load containers')}
    finally{if(!silent)setLoading(false)}
  }

  useEffect(()=>{void load();const timer=setInterval(()=>void load(true),15000);return()=>clearInterval(timer)},[]);

  const visible=useMemo(()=>containers.filter(container=>{
    const text=`${container.name} ${container.image} ${container.serverName} ${container.composeProject??''}`.toLowerCase();
    const matchesText=text.includes(filter.toLowerCase());
    const running=normalizeState(container.state)==='running';
    const matchesState=state==='all'||(state==='running'&&running)||(state==='stopped'&&!running);
    return matchesText&&matchesState;
  }),[containers,filter,state]);

  const running=containers.filter(item=>normalizeState(item.state)==='running').length;
  const failedServers=servers.filter(item=>item.error).length;

  async function act(container:Container,action:'start'|'stop'|'restart'){
    const key=`${container.serverId}:${container.id}`;setBusy(key);setError('');
    try{
      await api(`/servers/${container.serverId}/docker/containers/${container.id}/action`,{method:'POST',body:JSON.stringify({action,confirm:true})});
      await load(true);
    }catch(e){setError(e instanceof Error?e.message:`Unable to ${action} container`)}
    finally{setBusy(null)}
  }

  return <div className="deploy-page ops-page">
    <header className="deploy-topbar"><button onClick={()=>router.push('/dashboard')}><ArrowLeft size={16}/> Dashboard</button><span><Activity size={18}/> clouddeck.</span><div>{org?.name??'Workspace'} · Containers</div></header>
    <main className="deploy-content">
      <section className="deploy-hero"><div><span className="eyebrow">WORKSPACE / CONTAINERS</span><h1>Docker across your fleet</h1><p>Inspect container state across all connected servers and perform common lifecycle actions from one place.</p></div><div className="deploy-hero-actions"><button className="deploy-refresh" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/> Refresh</button></div></section>
      {error&&<div className="notice" role="status">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}
      {failedServers>0&&<div className="notice" role="status"><TriangleAlert size={16}/> {failedServers} server{failedServers===1?'':'s'} could not return Docker inventory. Other servers are still shown.</div>}
      <section className="deploy-stats">
        <div><Boxes size={18}/><span>Total containers</span><strong>{containers.length}</strong></div>
        <div><Play size={18}/><span>Running</span><strong>{running}</strong></div>
        <div><Square size={18}/><span>Stopped</span><strong>{containers.length-running}</strong></div>
        <div><Server size={18}/><span>Servers reporting</span><strong>{servers.filter(item=>item.status==='online'&&!item.error).length}</strong></div>
      </section>
      <section className="deploy-section">
        <div className="deploy-section-head"><div><h2>Container inventory</h2><p>Inventory refreshes every 15 seconds. Actions are audited on the owning server.</p></div><div className="alert-filters"><button className={state==='all'?'active':''} onClick={()=>setState('all')}>all</button><button className={state==='running'?'active':''} onClick={()=>setState('running')}>running</button><button className={state==='stopped'?'active':''} onClick={()=>setState('stopped')}>stopped</button></div></div>
        <label className="search-box" style={{maxWidth:440,marginBottom:18}}><Search size={16}/><input placeholder="Filter by container, image, server or compose project..." value={filter} onChange={event=>setFilter(event.target.value)}/></label>
        <div className="alert-list">
          {visible.map(container=>{const key=`${container.serverId}:${container.id}`;const isRunning=normalizeState(container.state)==='running';return <article className={`alert-row ${isRunning?'resolved':'open'}`} key={key}>
            <span className="alert-icon"><Boxes size={18}/></span>
            <div className="alert-copy"><div><strong>{container.name}</strong><span className={`health-state ${isRunning?'resolved':'failing'}`}>{container.state}</span></div><p>{container.image}</p><small>{container.serverName}{container.serverHostname?` · ${container.serverHostname}`:''}{container.composeProject?` · ${container.composeProject}/${container.composeService??''}`:''}</small>{container.ports.length>0&&<small>Ports: {container.ports.slice(0,6).map(port=>`${port.publicPort??'—'}→${port.privatePort}/${port.type}`).join(', ')}</small>}</div>
            <div className="alert-actions">{isRunning?<button onClick={()=>void act(container,'stop')} disabled={busy===key}><Pause size={14}/> Stop</button>:<button className="primary" onClick={()=>void act(container,'start')} disabled={busy===key}><Play size={14}/> Start</button>}<button onClick={()=>void act(container,'restart')} disabled={busy===key}><RotateCw size={14}/> Restart</button><button onClick={()=>router.push(`/servers/${container.serverId}`)}>Server</button></div>
          </article>})}
          {!visible.length&&!loading&&<div className="deployment-empty">No containers match the current filters.</div>}
          {loading&&<div className="deployment-empty">Loading container inventory…</div>}
        </div>
      </section>
    </main>
  </div>
}
