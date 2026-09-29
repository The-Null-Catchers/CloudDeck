'use client';
import {useEffect,useState} from 'react';
import {Boxes,RotateCcw,Play,Square,Pause,Trash2,Layers3} from 'lucide-react';
import {api} from '@/lib/api';

type Container={id:string;name:string;image:string;state:string;status:string;ports:{privatePort:number;publicPort?:number;type:string}[];composeProject?:string;composeService?:string};
type ComposeProject={name:string;services:string[];running:number;total:number};

export function DockerPanel({serverId,organizationId,demo}:{serverId:string;organizationId:string;demo:boolean}){
 const [containers,setContainers]=useState<Container[]>([]);
 const [projects,setProjects]=useState<ComposeProject[]>([]);
 const [busy,setBusy]=useState('');
 const [message,setMessage]=useState('');
 const [operator,setOperator]=useState(false);
 const [loading,setLoading]=useState(!demo);
 useEffect(()=>{
  if(demo){setContainers([{id:'aaaaaaaaaaaa',name:'clouddeck-api',image:'clouddeck/api:stable',state:'running',status:'Up 12 days',ports:[],composeProject:'clouddeck',composeService:'api'}]);setProjects([{name:'clouddeck',services:['api'],running:1,total:1}]);return}
  let active=true;
  api<{organizations:{id:string;role:string}[]}>('/organizations').then(({organizations})=>{if(active)setOperator(['owner','admin','operator'].includes(organizations.find(o=>o.id===organizationId)?.role??''))}).catch(()=>{});
  const load=()=>Promise.all([api<{containers:Container[]}>('/servers/'+serverId+'/docker/containers'),api<{projects:ComposeProject[]}>('/servers/'+serverId+'/docker/compose')]).then(([a,b])=>{if(active){setContainers(a.containers);setProjects(b.projects);setMessage('')}}).catch(e=>{if(active)setMessage(e instanceof Error?e.message:'Unable to load Docker inventory')}).finally(()=>{if(active)setLoading(false)});
  load();const timer=setInterval(load,30000);return()=>{active=false;clearInterval(timer)}
 },[serverId,organizationId,demo]);
 async function runAction(container:Container,action:'start'|'stop'|'restart'|'pause'|'unpause'|'remove'){
  const label=action==='unpause'?'resume':action;
  if(!window.confirm(action==='remove'?'Remove '+container.name+'? This cannot be undone.':label+' '+container.name+'?'))return;
  setBusy(container.id+action);setMessage('');
  try{await api('/servers/'+serverId+'/docker/containers/'+container.id+'/action',{method:'POST',body:JSON.stringify({action,confirm:true})});setMessage(container.name+': '+label+' completed');const r=await api<{containers:Container[]}>('/servers/'+serverId+'/docker/containers');setContainers(r.containers)}
  catch(e){setMessage(e instanceof Error?e.message:label+' failed')}finally{setBusy('')}
 }
 return <section className="chart-card docker-panel">
  <div className="chart-heading"><div><h2><Boxes size={19}/> Docker operations</h2><p>{demo?'Simulated Docker topology':'Allowlisted container lifecycle operations'}</p></div><span className="server-total">{containers.length} containers</span></div>
  {!!projects.length&&<div className="compose-projects">{projects.map(p=><div className="compose-project" key={p.name}><Layers3 size={17}/><div><strong>{p.name}</strong><small>{p.services.join(' · ')}</small></div><span>{p.running}/{p.total} running</span></div>)}</div>}
  {message&&<p className="docker-message" role="status">{message}</p>}
  {loading?<div className="chart-empty">Loading Docker inventory…</div>:<div className="container-list">{containers.map(c=><div className="container-row" key={c.id}><span className="container-icon"><Boxes size={18}/></span><div><strong>{c.name}</strong><small>{c.image} · {c.status}{c.composeProject?' · '+c.composeProject+'/'+(c.composeService??'service'):''}</small></div><span className={'badge '+(c.state==='running'?'online':'offline')}>● {c.state}</span>{!demo&&operator&&<div className="container-actions">
   {c.state!=='running'&&c.state!=='paused'&&<button disabled={!!busy} onClick={()=>runAction(c,'start')} title="Start"><Play size={14}/></button>}
   {c.state==='running'&&<button disabled={!!busy} onClick={()=>runAction(c,'pause')} title="Pause"><Pause size={14}/></button>}
   {c.state==='paused'&&<button disabled={!!busy} onClick={()=>runAction(c,'unpause')} title="Resume"><Play size={14}/></button>}
   {c.state==='running'&&<button disabled={!!busy} onClick={()=>runAction(c,'stop')} title="Stop"><Square size={14}/></button>}
   <button disabled={!!busy} onClick={()=>runAction(c,'restart')} title="Restart"><RotateCcw size={14}/></button>
   {c.state!=='running'&&c.state!=='paused'&&<button className="danger" disabled={!!busy} onClick={()=>runAction(c,'remove')} title="Remove"><Trash2 size={14}/></button>}
  </div>}</div>)}</div>}
 </section>
}
