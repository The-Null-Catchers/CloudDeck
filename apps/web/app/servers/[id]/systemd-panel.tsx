'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import {Play,Square,RotateCcw,Search,FileText,Radio,X,RefreshCw,ServerCog} from 'lucide-react';
import {api,openLogStream} from '@/lib/api';

type Service={name:string;load:string;active:string;sub:string;description:string};
type LogSnapshot={lines:string[];truncated:boolean};

export function SystemdPanel({serverId,organizationId,demo}:{serverId:string;organizationId:string;demo:boolean}){
 const [services,setServices]=useState<Service[]>([]);
 const [query,setQuery]=useState('');
 const [loading,setLoading]=useState(!demo);
 const [message,setMessage]=useState('');
 const [operator,setOperator]=useState(false);
 const [busy,setBusy]=useState('');
 const [selected,setSelected]=useState<Service|null>(null);
 const [logs,setLogs]=useState<LogSnapshot|null>(null);
 const [logsLoading,setLogsLoading]=useState(false);
 const [live,setLive]=useState(false);
 const [liveStatus,setLiveStatus]=useState('');
 const liveSocket=useRef<WebSocket|null>(null);
 const liveGeneration=useRef(0);

 useEffect(()=>()=>{liveSocket.current?.close()},[]);

 useEffect(()=>{
  if(demo){
   setServices([
    {name:'caddy.service',load:'loaded',active:'active',sub:'running',description:'Caddy web server'},
    {name:'docker.service',load:'loaded',active:'active',sub:'running',description:'Docker Application Container Engine'},
    {name:'postgresql.service',load:'loaded',active:'active',sub:'exited',description:'PostgreSQL database server'}
   ]);
   return;
  }
  let active=true;
  api<{organizations:{id:string;role:string}[]}>('/organizations').then(({organizations})=>{
   if(active)setOperator(['owner','admin','operator'].includes(organizations.find(o=>o.id===organizationId)?.role??''));
  }).catch(()=>{});
  const load=()=>api<{services:Service[]}>('/servers/'+serverId+'/services')
   .then(({services})=>{if(active){setServices(services);setMessage('')}})
   .catch(e=>{if(active)setMessage(e instanceof Error?e.message:'Unable to load services')})
   .finally(()=>{if(active)setLoading(false)});
  load();
  const timer=setInterval(load,30000);
  return()=>{active=false;clearInterval(timer)};
 },[serverId,organizationId,demo]);

 const filtered=useMemo(()=>{
  const term=query.trim().toLowerCase();
  if(!term)return services;
  return services.filter(service=>service.name.toLowerCase().includes(term)||service.description.toLowerCase().includes(term));
 },[services,query]);

 async function refreshServices(){
  if(demo)return;
  const result=await api<{services:Service[]}>('/servers/'+serverId+'/services');
  setServices(result.services);
 }

 async function runAction(service:Service,action:'start'|'stop'|'restart'){
  if(!window.confirm(action+' '+service.name+'?'))return;
  setBusy(service.name+action);setMessage('');
  try{
   await api('/servers/'+serverId+'/services/'+encodeURIComponent(service.name)+'/action',{method:'POST',body:JSON.stringify({action,confirm:true})});
   setMessage(service.name+': '+action+' completed');
   await refreshServices();
  }catch(e){setMessage(e instanceof Error?e.message:action+' failed')}
  finally{setBusy('')}
 }

 function stopLive(){
  liveGeneration.current+=1;
  liveSocket.current?.close();
  liveSocket.current=null;
  setLive(false);
  setLiveStatus('');
 }

 async function openLogs(service:Service){
  stopLive();
  setSelected(service);setLogs(null);setLogsLoading(true);
  if(demo){
   setLogs({lines:[
    '2026-09-29T17:00:00+0300 demo-host '+service.name+'[123]: service started',
    '2026-09-29T17:01:00+0300 demo-host '+service.name+'[123]: health check ok'
   ],truncated:false});
   setLogsLoading(false);return;
  }
  try{
   const snapshot=await api<LogSnapshot>('/servers/'+serverId+'/logs/systemd?unit='+encodeURIComponent(service.name)+'&limit=200');
   setLogs(snapshot);
  }catch(e){setMessage(e instanceof Error?e.message:'Unable to load service logs')}
  finally{setLogsLoading(false)}
 }

 async function startLive(){
  if(!selected||demo)return;
  stopLive();
  const generation=liveGeneration.current;
  setLogs({lines:[],truncated:false});
  setLiveStatus('connecting');
  try{
   const socket=await openLogStream(serverId,'systemd',selected.name,event=>{
    if(generation!==liveGeneration.current)return;
    if(event.type==='ready'){setLive(true);setLiveStatus('live');return}
    if(event.error){setLive(false);setLiveStatus(event.error);return}
    if(event.line)setLogs(current=>({lines:[...(current?.lines??[]),event.line!].slice(-500),truncated:current?.truncated??false}));
    if(event.done){setLive(false);setLiveStatus('ended')}
   },100);
   if(generation!==liveGeneration.current){socket.close();return}
   liveSocket.current=socket;
   socket.onclose=()=>{if(liveSocket.current===socket){liveSocket.current=null;setLive(false);setLiveStatus('ended')}};
   socket.onerror=()=>{if(liveSocket.current===socket){setLive(false);setLiveStatus('connection error')}};
  }catch(e){
   if(generation===liveGeneration.current){setLive(false);setLiveStatus(e instanceof Error?e.message:'Unable to start live logs')}
  }
 }

 return <section className="chart-card systemd-panel">
  <div className="chart-heading">
   <div><h2><ServerCog size={19}/> System services</h2><p>{demo?'Simulated systemd inventory':'Live systemd inventory from the connected agent'}</p></div>
   <span className="server-total">{services.length} services</span>
  </div>
  <div className="service-toolbar">
   <label><Search size={15}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search services"/></label>
   {!demo&&<button onClick={refreshServices} title="Refresh services"><RefreshCw size={14}/> Refresh</button>}
  </div>
  {message&&<p className="docker-message" role="status">{message}</p>}
  {loading?<div className="chart-empty">Loading systemd services…</div>:<div className="service-list">
   {filtered.map(service=><div className="service-row" key={service.name}>
    <span className={'service-dot '+(service.active==='active'?'active':'')}/>
    <div><strong>{service.name}</strong><small>{service.description||service.sub}</small></div>
    <span className={'badge '+(service.active==='active'?'online':'offline')}>{service.active} / {service.sub}</span>
    <div className="service-actions">
     <button onClick={()=>openLogs(service)} title="View logs"><FileText size={14}/></button>
     {!demo&&operator&&<>
      {service.active!=='active'&&<button disabled={!!busy} onClick={()=>runAction(service,'start')} title="Start"><Play size={14}/></button>}
      {service.active==='active'&&<button disabled={!!busy} onClick={()=>runAction(service,'stop')} title="Stop"><Square size={14}/></button>}
      <button disabled={!!busy} onClick={()=>runAction(service,'restart')} title="Restart"><RotateCcw size={14}/></button>
     </>}
    </div>
   </div>)}
   {!filtered.length&&<div className="chart-empty">No matching services.</div>}
  </div>}
  {selected&&<div className="service-log-viewer">
   <div className="inspector-head"><div><span className="eyebrow">SYSTEMD JOURNAL</span><h3>{selected.name}</h3><p>{selected.description||selected.sub}</p></div><div><button onClick={()=>openLogs(selected)} title="Refresh logs"><RefreshCw size={15}/></button><button onClick={()=>{stopLive();setSelected(null)}} title="Close logs"><X size={15}/></button></div></div>
   {logsLoading?<div className="chart-empty">Loading journal…</div>:<div className="inspector-card wide logs-card">
    <div className="logs-title"><h4>{live?'Live journal':'Recent journal'}</h4><div className="log-controls">{liveStatus&&<span className={live?'live-status active':'live-status'}>{liveStatus}</span>}{logs?.truncated&&<span>truncated</span>}{!demo&&(live?<button onClick={stopLive}><Square size={12}/> Stop</button>:<button onClick={startLive}><Radio size={12}/> Live</button>)}</div></div>
    <pre>{logs?.lines.join('\n')||'No journal output'}</pre>
   </div>}
  </div>}
 </section>;
}
