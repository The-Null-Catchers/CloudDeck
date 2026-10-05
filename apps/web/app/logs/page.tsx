'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import {Activity,ArrowLeft,Box,RefreshCw,Search,Server,ScrollText,TerminalSquare} from 'lucide-react';
import {api} from '@/lib/api';

type Org={id:string;name:string;role:string};
type ServerRow={id:string;name:string;hostname:string|null;status:string};
type Service={name:string;load:string;active:string;sub:string;description:string};
type Container={id:string;name:string;image:string;state:string;status:string;serverId:string;serverName:string;serverHostname:string|null};
type LogResult={lines:string[];truncated:boolean};
type Source='systemd'|'docker';

export default function LogsPage(){
  const router=useRouter();
  const [org,setOrg]=useState<Org|null>(null);const [servers,setServers]=useState<ServerRow[]>([]);const [services,setServices]=useState<Service[]>([]);const [containers,setContainers]=useState<Container[]>([]);
  const [source,setSource]=useState<Source>('systemd');const [serverId,setServerId]=useState('');const [target,setTarget]=useState('');const [limit,setLimit]=useState(200);const [result,setResult]=useState<LogResult|null>(null);const [query,setQuery]=useState('');const [loading,setLoading]=useState(true);const [busy,setBusy]=useState(false);const [error,setError]=useState('');

  useEffect(()=>{let active=true;(async()=>{try{const orgs=await api<{organizations:Org[]}>('/organizations');const selected=orgs.organizations[0];if(!selected)throw new Error('No workspace found');const [fleet,docker]=await Promise.all([api<{servers:ServerRow[]}>(`/organizations/${selected.id}/servers`),api<{containers:Container[]}>(`/organizations/${selected.id}/docker/containers`)]);if(!active)return;setOrg(selected);setServers(fleet.servers);setContainers(docker.containers);const first=fleet.servers.find(s=>s.status==='online')??fleet.servers[0];if(first)setServerId(first.id)}catch(e){if(active)setError(e instanceof Error?e.message:'Unable to load log sources')}finally{if(active)setLoading(false)}})();return()=>{active=false}},[]);

  useEffect(()=>{if(source!=='systemd'||!serverId){setServices([]);if(source==='systemd')setTarget('');return}let active=true;(async()=>{try{const data=await api<{services:Service[]}>(`/servers/${serverId}/services`);if(!active)return;setServices(data.services);setTarget(current=>data.services.some(s=>s.name===current)?current:(data.services[0]?.name??''));setError('')}catch(e){if(active){setServices([]);setTarget('');setError(e instanceof Error?e.message:'Unable to load services')}}})();return()=>{active=false}},[source,serverId]);

  useEffect(()=>{if(source!=='docker')return;const available=containers.filter(c=>!serverId||c.serverId===serverId);setTarget(current=>available.some(c=>c.id===current)?current:(available[0]?.id??''))},[source,serverId,containers]);

  async function loadLogs(){if(!serverId||!target)return;setBusy(true);setError('');try{const url=source==='systemd'?`/servers/${serverId}/logs/systemd?unit=${encodeURIComponent(target)}&limit=${limit}`:`/servers/${serverId}/docker/containers/${encodeURIComponent(target)}/logs?limit=${limit}`;setResult(await api<LogResult>(url))}catch(e){setError(e instanceof Error?e.message:'Unable to load logs')}finally{setBusy(false)}}
  const targets=source==='systemd'?services:containers.filter(c=>c.serverId===serverId);
  const visible=useMemo(()=>{const lines=result?.lines??[];const needle=query.trim().toLowerCase();return needle?lines.filter(line=>line.toLowerCase().includes(needle)):lines},[result,query]);
  return <div className="deploy-page ops-page">
    <header className="deploy-topbar"><button onClick={()=>router.push('/dashboard')}><ArrowLeft size={16}/> Dashboard</button><span><Activity size={18}/> clouddeck.</span><div>{org?.name??'Workspace'} · Logs</div></header>
    <main className="deploy-content">
      <section className="deploy-hero"><div><span className="eyebrow">OBSERVABILITY / LOGS</span><h1>Centralized log explorer</h1><p>Inspect systemd and Docker logs from every connected server without leaving the workspace view.</p></div><div className="deploy-hero-actions"><button className="deploy-refresh" onClick={()=>void loadLogs()} disabled={busy||!target}><RefreshCw size={15}/> {busy?'Loading…':'Refresh logs'}</button></div></section>
      {error&&<div className="notice" role="status">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}
      <section className="deploy-section"><div className="deploy-section-head"><div><h2>Log source</h2><p>Select a server and runtime source. Log reads are audited by CloudDeck.</p></div></div>
        <div className="alert-filters" style={{marginBottom:16}}><button className={source==='systemd'?'active':''} onClick={()=>{setSource('systemd');setResult(null)}}><TerminalSquare size={14}/> systemd</button><button className={source==='docker'?'active':''} onClick={()=>{setSource('docker');setResult(null)}}><Box size={14}/> Docker</button></div>
        <div className="form-grid">
          <label><span>Server</span><select value={serverId} onChange={e=>{setServerId(e.target.value);setTarget('');setResult(null)}} disabled={loading}>{servers.map(server=><option key={server.id} value={server.id}>{server.name} · {server.hostname??server.status}</option>)}</select></label>
          <label><span>{source==='systemd'?'Service':'Container'}</span><select value={target} onChange={e=>{setTarget(e.target.value);setResult(null)}}>{targets.map(item=>source==='systemd'?<option key={(item as Service).name} value={(item as Service).name}>{(item as Service).name} · {(item as Service).active}</option>:<option key={(item as Container).id} value={(item as Container).id}>{(item as Container).name} · {(item as Container).image}</option>)}</select></label>
          <label><span>Lines</span><select value={limit} onChange={e=>setLimit(Number(e.target.value))}><option value={100}>100</option><option value={200}>200</option><option value={500}>500</option></select></label>
        </div><div className="deploy-hero-actions" style={{marginTop:16}}><button className="primary" onClick={()=>void loadLogs()} disabled={busy||!target}><ScrollText size={15}/> Load logs</button></div>
      </section>
      <section className="deploy-section"><div className="deploy-section-head alert-head"><div><h2>Output</h2><p>{result?`${result.lines.length} lines${result.truncated?' · truncated':''}`:'Choose a source and load logs.'}</p></div><label className="search-box"><Search size={15}/><input placeholder="Filter loaded lines…" value={query} onChange={e=>setQuery(e.target.value)}/></label></div>
        <pre style={{minHeight:360,maxHeight:'65vh',overflow:'auto',padding:18,borderRadius:12,background:'#0b1020',color:'#d8e1ff',fontSize:12,lineHeight:1.65,whiteSpace:'pre-wrap',wordBreak:'break-word'}}>{visible.length?visible.join('\n'):busy?'Loading logs…':result?'No lines match the filter.':'No logs loaded yet.'}</pre>
      </section>
      <section className="deploy-stats"><div><Server size={18}/><span>Servers</span><strong>{servers.length}</strong></div><div><TerminalSquare size={18}/><span>Services</span><strong>{services.length}</strong></div><div><Box size={18}/><span>Containers</span><strong>{containers.length}</strong></div><div><ScrollText size={18}/><span>Visible lines</span><strong>{visible.length}</strong></div></section>
    </main>
  </div>
}
