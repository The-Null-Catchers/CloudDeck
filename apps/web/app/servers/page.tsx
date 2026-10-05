'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import {Activity,ArrowLeft,ArrowUpRight,Cpu,HardDrive,MemoryStick,Plus,RefreshCw,Search,Server,Wifi,WifiOff,Clock3} from 'lucide-react';
import {api} from '@/lib/api';
import type {ServerSummary} from '@clouddeck/shared';

type Org={id:string;name:string;role:string};
type StatusFilter='all'|'online'|'offline'|'pending';

function metric(value:number|null|undefined){return value==null?'—':`${Number(value).toFixed(1)}%`}
function lastSeen(value:string|null){return value?new Date(value).toLocaleString():'Never'}

export default function ServersPage(){
  const router=useRouter();
  const [org,setOrg]=useState<Org|null>(null);
  const [servers,setServers]=useState<ServerSummary[]>([]);
  const [filter,setFilter]=useState<StatusFilter>('all');
  const [query,setQuery]=useState('');
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [pairing,setPairing]=useState<{serverId:string;token:string}|null>(null);

  async function load(silent=false){
    if(!silent)setLoading(true);
    try{
      const orgs=await api<{organizations:Org[]}>('/organizations');
      const selected=orgs.organizations[0];
      if(!selected)throw new Error('No workspace found');
      const data=await api<{servers:ServerSummary[]}>(`/organizations/${selected.id}/servers`);
      setOrg(selected);setServers(data.servers);setError('');
    }catch(e){setError(e instanceof Error?e.message:'Unable to load servers')}
    finally{if(!silent)setLoading(false)}
  }

  useEffect(()=>{void load();const timer=setInterval(()=>void load(true),15000);return()=>clearInterval(timer)},[]);

  async function addServer(){
    if(!org)return;
    const name=prompt('Server name');
    if(!name?.trim())return;
    try{
      const result=await api<{id:string;pairingToken:string}>('/servers',{method:'POST',body:JSON.stringify({organizationId:org.id,name:name.trim()})});
      setPairing({serverId:result.id,token:result.pairingToken});
      await load(true);
    }catch(e){setError(e instanceof Error?e.message:'Unable to add server')}
  }

  const visible=useMemo(()=>{
    const needle=query.trim().toLowerCase();
    return servers.filter(server=>(filter==='all'||server.status===filter)&&(!needle||`${server.name} ${server.hostname??''}`.toLowerCase().includes(needle)));
  },[servers,filter,query]);
  const online=servers.filter(server=>server.status==='online').length;
  const offline=servers.filter(server=>server.status==='offline').length;
  const pending=servers.filter(server=>server.status==='pending').length;
  const avgCpu=servers.filter(server=>server.cpuPercent!=null).reduce((sum,server)=>sum+Number(server.cpuPercent),0)/Math.max(1,servers.filter(server=>server.cpuPercent!=null).length);

  return <div className="deploy-page ops-page">
    <header className="deploy-topbar"><button onClick={()=>router.push('/dashboard')}><ArrowLeft size={16}/> Dashboard</button><span><Activity size={18}/> clouddeck.</span><div>{org?.name??'Workspace'} · Servers</div></header>
    <main className="deploy-content">
      <section className="deploy-hero">
        <div><span className="eyebrow">INFRASTRUCTURE / SERVERS</span><h1>Fleet inventory and health</h1><p>Track every connected server, current resource pressure, pairing state, and last agent contact from one place.</p></div>
        <div className="deploy-hero-actions"><button className="deploy-refresh" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/> Refresh</button><button className="primary" onClick={()=>void addServer()}><Plus size={16}/> Add server</button></div>
      </section>

      {error&&<div className="notice" role="status">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}
      {pairing&&<div className="pair-banner"><strong>Pairing token — shown once, expires in 10 minutes</strong><code>Server ID: {pairing.serverId}<br/>Pairing token: {pairing.token}</code><span>Install the CloudDeck agent and provide this server ID and token during pairing.</span><button onClick={()=>setPairing(null)}>Dismiss</button></div>}

      <section className="deploy-stats">
        <div><Server size={18}/><span>Total servers</span><strong>{servers.length}</strong></div>
        <div><Wifi size={18}/><span>Online</span><strong>{online}</strong></div>
        <div><WifiOff size={18}/><span>Offline</span><strong>{offline}</strong></div>
        <div><Cpu size={18}/><span>Fleet CPU avg.</span><strong>{servers.some(server=>server.cpuPercent!=null)?`${avgCpu.toFixed(1)}%`:'—'}</strong></div>
      </section>

      <section className="deploy-section">
        <div className="deploy-section-head alert-head">
          <div><h2>Server fleet</h2><p>{pending?`${pending} server${pending===1?' is':'s are'} awaiting agent pairing. `:''}Live metrics refresh every 15 seconds.</p></div>
          <div className="alert-filters">{(['all','online','offline','pending'] as const).map(value=><button key={value} className={filter===value?'active':''} onClick={()=>setFilter(value)}>{value}</button>)}</div>
        </div>
        <div style={{marginBottom:16}}><label className="search-box" style={{maxWidth:420}}><Search size={16}/><input placeholder="Search by server name or hostname" value={query} onChange={event=>setQuery(event.target.value)}/></label></div>

        <div className="server-grid">
          {visible.map(server=><article className="server-card" key={server.id}>
            <div className="server-top"><div className="server-icon"><Server size={20}/></div><span className={`badge ${server.status}`}>● {server.status}</span></div>
            <h3>{server.name}</h3><p className="hostname">{server.hostname??'Awaiting agent pairing'}</p>
            <div className="card-divider"/>
            <div className="metric-row"><span><Cpu size={15}/> CPU</span><strong>{metric(server.cpuPercent)}</strong></div><div className="meter"><i style={{width:`${Math.min(100,Number(server.cpuPercent??0))}%`}}/></div>
            <div className="metric-row"><span><MemoryStick size={15}/> Memory</span><strong>{metric(server.memoryPercent)}</strong></div><div className="meter"><i style={{width:`${Math.min(100,Number(server.memoryPercent??0))}%`}}/></div>
            <div className="metric-row"><span><HardDrive size={15}/> Disk</span><strong>{metric(server.diskPercent)}</strong></div><div className="meter"><i style={{width:`${Math.min(100,Number(server.diskPercent??0))}%`}}/></div>
            <div className="card-footer"><span><Clock3 size={12}/> {lastSeen(server.lastSeenAt)}</span><button onClick={()=>router.push(`/servers/${server.id}`)}>Manage <ArrowUpRight size={14}/></button></div>
          </article>)}
        </div>
        {!visible.length&&!loading&&<div className="deployment-empty">No servers match this view.</div>}
        {loading&&!servers.length&&<div className="deployment-empty">Loading server fleet…</div>}
      </section>
    </main>
  </div>
}
