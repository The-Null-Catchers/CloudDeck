'use client';
import {useEffect,useRef,useState} from 'react';
import {Boxes,RotateCcw,Play,Square,Pause,Trash2,Layers3,Eye,RefreshCw,X,Radio} from 'lucide-react';
import {api,openLogStream} from '@/lib/api';

type Container={id:string;name:string;image:string;state:string;status:string;ports:{privatePort:number;publicPort?:number;type:string}[];composeProject?:string;composeService?:string};
type ComposeProject={name:string;services:string[];running:number;total:number};
type Inspect={image:string;created:string;restartCount:number;mounts:{type:string;source?:string;destination:string;readOnly:boolean}[];networks:string[];ports:string[]};
type Stats={cpuPercent:number;memoryUsage:number;memoryLimit:number;networkRxBytes:number;networkTxBytes:number};
type Logs={lines:string[];truncated:boolean};

const formatBytes=(value:number)=>value>=1073741824?(value/1073741824).toFixed(1)+' GB':value>=1048576?(value/1048576).toFixed(1)+' MB':value>=1024?(value/1024).toFixed(1)+' KB':value+' B';

export function DockerPanel({serverId,organizationId,demo}:{serverId:string;organizationId:string;demo:boolean}){
 const [containers,setContainers]=useState<Container[]>([]);
 const [projects,setProjects]=useState<ComposeProject[]>([]);
 const [busy,setBusy]=useState('');
 const [message,setMessage]=useState('');
 const [operator,setOperator]=useState(false);
 const [loading,setLoading]=useState(!demo);
 const [selected,setSelected]=useState<Container|null>(null);
 const [inspect,setInspect]=useState<Inspect|null>(null);
 const [stats,setStats]=useState<Stats|null>(null);
 const [logs,setLogs]=useState<Logs|null>(null);
 const [inspectLoading,setInspectLoading]=useState(false);
 const [live,setLive]=useState(false);
 const [liveStatus,setLiveStatus]=useState('');
 const liveSocket=useRef<WebSocket|null>(null);
 const liveGeneration=useRef(0);

 useEffect(()=>()=>{liveSocket.current?.close()},[]);

 useEffect(()=>{
  if(demo){
   setContainers([{id:'aaaaaaaaaaaa',name:'clouddeck-api',image:'clouddeck/api:stable',state:'running',status:'Up 12 days',ports:[{privatePort:4000,publicPort:4000,type:'tcp'}],composeProject:'clouddeck',composeService:'api'}]);
   setProjects([{name:'clouddeck',services:['api'],running:1,total:1}]);
   return;
  }
  let active=true;
  api<{organizations:{id:string;role:string}[]}>('/organizations').then(({organizations})=>{if(active)setOperator(['owner','admin','operator'].includes(organizations.find(o=>o.id===organizationId)?.role??''))}).catch(()=>{});
  const load=()=>Promise.all([api<{containers:Container[]}>('/servers/'+serverId+'/docker/containers'),api<{projects:ComposeProject[]}>('/servers/'+serverId+'/docker/compose')]).then(([a,b])=>{if(active){setContainers(a.containers);setProjects(b.projects);setMessage('')}}).catch(e=>{if(active)setMessage(e instanceof Error?e.message:'Unable to load Docker inventory')}).finally(()=>{if(active)setLoading(false)});
  load();const timer=setInterval(load,30000);return()=>{active=false;clearInterval(timer)}
 },[serverId,organizationId,demo]);

 async function refreshInventory(){
  if(demo)return;
  const [a,b]=await Promise.all([api<{containers:Container[]}>('/servers/'+serverId+'/docker/containers'),api<{projects:ComposeProject[]}>('/servers/'+serverId+'/docker/compose')]);
  setContainers(a.containers);setProjects(b.projects);
 }

 async function runAction(container:Container,action:'start'|'stop'|'restart'|'pause'|'unpause'|'remove'){
  const label=action==='unpause'?'resume':action;
  if(!window.confirm(action==='remove'?'Remove '+container.name+'? This cannot be undone.':label+' '+container.name+'?'))return;
  setBusy(container.id+action);setMessage('');
  try{await api('/servers/'+serverId+'/docker/containers/'+container.id+'/action',{method:'POST',body:JSON.stringify({action,confirm:true})});setMessage(container.name+': '+label+' completed');await refreshInventory()}
  catch(e){setMessage(e instanceof Error?e.message:label+' failed')}finally{setBusy('')}
 }

 async function runComposeAction(project:string,service:string,action:'start'|'stop'|'restart'){
  if(!window.confirm(action+' '+project+'/'+service+'?'))return;
  setBusy(project+service+action);setMessage('');
  try{await api('/servers/'+serverId+'/docker/compose/'+encodeURIComponent(project)+'/services/'+encodeURIComponent(service)+'/action',{method:'POST',body:JSON.stringify({action,confirm:true})});setMessage(project+'/'+service+': '+action+' completed');await refreshInventory()}
  catch(e){setMessage(e instanceof Error?e.message:action+' failed')}finally{setBusy('')}
 }

 function stopLive(){
  liveGeneration.current+=1;
  liveSocket.current?.close();
  liveSocket.current=null;
  setLive(false);
  setLiveStatus('');
 }

 async function startLive(){
  if(!selected||demo)return;
  stopLive();
  const generation=liveGeneration.current;
  setLogs({lines:[],truncated:false});
  setLiveStatus('connecting');
  try{
   const socket=await openLogStream(serverId,'docker',selected.id,event=>{
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
  }catch(e){if(generation===liveGeneration.current){setLive(false);setLiveStatus(e instanceof Error?e.message:'Unable to start live logs')}}
 }

 async function openInspector(container:Container){
  stopLive();
  setSelected(container);setInspect(null);setStats(null);setLogs(null);setInspectLoading(true);
  if(demo){setInspect({image:container.image,created:new Date().toISOString(),restartCount:1,mounts:[{type:'volume',source:'clouddeck-data',destination:'/data',readOnly:false}],networks:['clouddeck_default'],ports:['4000/tcp']});setStats({cpuPercent:8.2,memoryUsage:134217728,memoryLimit:536870912,networkRxBytes:7340032,networkTxBytes:3145728});setLogs({lines:['2026-09-29T17:00:00Z API listening on :4000','2026-09-29T17:01:00Z health check ok'],truncated:false});setInspectLoading(false);return}
  try{
   const [i,s,l]=await Promise.all([
    api<Inspect>('/servers/'+serverId+'/docker/containers/'+container.id+'/inspect'),
    api<Stats>('/servers/'+serverId+'/docker/containers/'+container.id+'/stats'),
    api<Logs>('/servers/'+serverId+'/docker/containers/'+container.id+'/logs?limit=200')
   ]);
   setInspect(i);setStats(s);setLogs(l);
  }catch(e){setMessage(e instanceof Error?e.message:'Unable to inspect container')}finally{setInspectLoading(false)}
 }

 return <section className="chart-card docker-panel">
  <div className="chart-heading"><div><h2><Boxes size={19}/> Docker operations</h2><p>{demo?'Simulated Docker topology':'Allowlisted container and Compose operations'}</p></div><span className="server-total">{containers.length} containers</span></div>

  {!!projects.length&&<div className="compose-projects">{projects.map(p=><div className="compose-project" key={p.name}><Layers3 size={17}/><div className="compose-copy"><strong>{p.name}</strong><small>{p.running}/{p.total} running</small>{p.services.map(service=><div className="compose-service-row" key={service}><span>{service}</span>{!demo&&operator&&<span className="compose-actions"><button disabled={!!busy} onClick={()=>runComposeAction(p.name,service,'start')} title="Start service"><Play size={12}/></button><button disabled={!!busy} onClick={()=>runComposeAction(p.name,service,'stop')} title="Stop service"><Square size={12}/></button><button disabled={!!busy} onClick={()=>runComposeAction(p.name,service,'restart')} title="Restart service"><RotateCcw size={12}/></button></span>}</div>)}</div></div>)}</div>}

  {message&&<p className="docker-message" role="status">{message}</p>}
  {loading?<div className="chart-empty">Loading Docker inventory…</div>:<div className="container-list">{containers.map(c=><div className="container-row" key={c.id}><span className="container-icon"><Boxes size={18}/></span><div><strong>{c.name}</strong><small>{c.image} · {c.status}{c.composeProject?' · '+c.composeProject+'/'+(c.composeService??'service'):''}</small></div><span className={'badge '+(c.state==='running'?'online':'offline')}>● {c.state}</span><div className="container-actions">
   <button onClick={()=>openInspector(c)} title="Inspect"><Eye size={14}/></button>
   {!demo&&operator&&<>
    {c.state!=='running'&&c.state!=='paused'&&<button disabled={!!busy} onClick={()=>runAction(c,'start')} title="Start"><Play size={14}/></button>}
    {c.state==='running'&&<button disabled={!!busy} onClick={()=>runAction(c,'pause')} title="Pause"><Pause size={14}/></button>}
    {c.state==='paused'&&<button disabled={!!busy} onClick={()=>runAction(c,'unpause')} title="Resume"><Play size={14}/></button>}
    {c.state==='running'&&<button disabled={!!busy} onClick={()=>runAction(c,'stop')} title="Stop"><Square size={14}/></button>}
    <button disabled={!!busy} onClick={()=>runAction(c,'restart')} title="Restart"><RotateCcw size={14}/></button>
    {c.state!=='running'&&c.state!=='paused'&&<button className="danger" disabled={!!busy} onClick={()=>runAction(c,'remove')} title="Remove"><Trash2 size={14}/></button>}
   </>}
  </div></div>)}</div>}

  {selected&&<div className="docker-inspector">
   <div className="inspector-head"><div><span className="eyebrow">CONTAINER INSPECTOR</span><h3>{selected.name}</h3><p>{selected.id.slice(0,12)} · {selected.image}</p></div><div><button onClick={()=>openInspector(selected)} title="Refresh inspector"><RefreshCw size={15}/></button><button onClick={()=>{stopLive();setSelected(null)}} title="Close inspector"><X size={15}/></button></div></div>
   {inspectLoading?<div className="chart-empty">Loading container details…</div>:<div className="inspector-grid">
    <div className="inspector-card"><h4>Resources</h4>{stats?<><strong>{stats.cpuPercent.toFixed(1)}% CPU</strong><span>{formatBytes(stats.memoryUsage)} / {formatBytes(stats.memoryLimit)} memory</span><span>RX {formatBytes(stats.networkRxBytes)} · TX {formatBytes(stats.networkTxBytes)}</span></>:<span>No stats available</span>}</div>
    <div className="inspector-card"><h4>Runtime</h4>{inspect?<><strong>{inspect.restartCount} restarts</strong><span>Created {new Date(inspect.created).toLocaleString()}</span><span>Networks: {inspect.networks.join(', ')||'none'}</span><span>Ports: {inspect.ports.join(', ')||'none'}</span></>:<span>No inspect data</span>}</div>
    <div className="inspector-card wide"><h4>Mounts</h4>{inspect?.mounts.length?inspect.mounts.map((m,i)=><span key={i}>{m.type}: {m.source?m.source+' → ':''}{m.destination}{m.readOnly?' (read-only)':''}</span>):<span>No mounts</span>}</div>
    <div className="inspector-card wide logs-card"><div className="logs-title"><h4>{live?'Live logs':'Recent logs'}</h4><div className="log-controls">{liveStatus&&<span className={live?'live-status active':'live-status'}>{liveStatus}</span>}{logs?.truncated&&<span>truncated</span>}{!demo&&(live?<button onClick={stopLive}><Square size={12}/> Stop</button>:<button onClick={startLive}><Radio size={12}/> Live</button>)}</div></div><pre>{logs?.lines.join('\n')||'No log output'}</pre></div>
   </div>}
  </div>}
 </section>
}
