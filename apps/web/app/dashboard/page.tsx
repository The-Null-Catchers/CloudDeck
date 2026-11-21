'use client';
import {useCallback,useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import {Activity,Server,LayoutDashboard,Boxes,Globe2,Rocket,DatabaseBackup,HeartPulse,Bell,ChartNoAxesCombined,ScrollText,Users,Settings2,Search,Plus,ArrowUpRight,Cpu,MemoryStick,HardDrive,Command,CircleHelp,ChevronDown,Wifi,WifiOff,ShieldCheck,KeyRound} from 'lucide-react';
import {api} from '@/lib/api';
import type {ServerSummary} from '@clouddeck/shared';
type Org={id:string;name:string;role:string;demo?:boolean};
const nav=[{label:'WORKSPACE',items:[[LayoutDashboard,'Dashboard'],[Server,'Servers'],[Boxes,'Containers'],[Globe2,'Domains']]},{label:'OPERATIONS',items:[[Rocket,'Deployments'],[DatabaseBackup,'Backups'],[HeartPulse,'Health checks'],[Bell,'Alerts']]},{label:'OBSERVABILITY',items:[[ChartNoAxesCombined,'Metrics'],[ScrollText,'Logs']]},{label:'ORGANIZATION',items:[[Users,'Members'],[KeyRound,'Secrets'],[ShieldCheck,'Audit logs'],[Settings2,'Settings']]}] as const;
const destinations:Record<string,string>={Servers:'/servers',Containers:'/containers',Domains:'/domains',Deployments:'/deployments',Backups:'/backups','Health checks':'/health-checks',Alerts:'/alerts',Metrics:'/metrics',Logs:'/logs',Members:'/members',Secrets:'/secrets','Audit logs':'/audit-logs',Settings:'/security'};
export default function Dashboard(){
  const router=useRouter();
  const [servers,setServers]=useState<ServerSummary[]>([]);
  const [org,setOrg]=useState<Org|null>(null);
  const [loading,setLoading]=useState(true);
  const [demoCreating,setDemoCreating]=useState(false);
  const [error,setError]=useState('');
  const [pairing,setPairing]=useState('');
  const [pairedServerId,setPairedServerId]=useState('');
  const [filter,setFilter]=useState('');
  const [openAlerts,setOpenAlerts]=useState(0);

  const load=useCallback(async()=>{
    setLoading(true);
    setError('');
    try{
      const data=await api<{organizations:Org[]}>('/organizations');
      const selected=data.organizations[0];
      if(!selected){
        setOrg(null);setServers([]);setOpenAlerts(0);
        setError('No workspace is available for this account. Create a workspace or sign in again.');
        return;
      }
      const [fleet,summary]=await Promise.all([
        api<{servers:ServerSummary[]}>(`/organizations/${selected.id}/servers`),
        api<{openAlerts:number}>(`/organizations/${selected.id}/dashboard`)
      ]);
      setOrg(selected);setServers(fleet.servers);setOpenAlerts(summary.openAlerts);
    }catch(e){
      setOrg(null);setServers([]);setOpenAlerts(0);
      setError(e instanceof Error?e.message:'Unable to load workspace data.');
    }finally{setLoading(false)}
  },[]);

  useEffect(()=>{void load()},[load]);
  useEffect(()=>{
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'&&document.activeElement instanceof HTMLElement)document.activeElement.blur()};
    window.addEventListener('keydown',onKey);
    return()=>window.removeEventListener('keydown',onKey);
  },[]);

  async function createDemoWorkspace(){
    if(demoCreating)return;
    setDemoCreating(true);setError('');
    try{await api('/demo/workspace',{method:'POST',body:JSON.stringify({})});await load()}
    catch(e){setError(e instanceof Error?e.message:'Unable to create the synthetic demo workspace.')}
    finally{setDemoCreating(false)}
  }

  async function addServer(){
    if(!org){router.push('/login');return}
    if(org.demo){setError('The synthetic demo workspace is read-only.');return}
    const name=window.prompt('Server name');
    if(!name?.trim())return;
    try{
      const result=await api<{id:string;pairingToken:string}>('/servers',{method:'POST',body:JSON.stringify({organizationId:org.id,name:name.trim()})});
      setPairing(result.pairingToken);setPairedServerId(result.id);
      const rows=await api<{servers:ServerSummary[]}>(`/organizations/${org.id}/servers`);setServers(rows.servers);
    }catch(e){setError(e instanceof Error?e.message:'Unable to add server')}
  }

  const demoMode=org?.demo===true;
  const visible=servers.filter(s=>`${s.name} ${s.hostname??''}`.toLowerCase().includes(filter.toLowerCase()));
  const online=servers.filter(s=>s.status==='online').length;
  const offline=servers.filter(s=>s.status==='offline').length;
  const openGlobalSearch=()=>window.dispatchEvent(new Event('clouddeck:open-search'));

  return <div className='shell'>
    <aside className='sidebar'>
      <div className='brand'><span className='brand-icon'><Activity size={20}/></span>clouddeck<span className='brand-dot'>.</span></div>
      <div className='workspace'><span className='workspace-symbol'>{org?.name[0]?.toUpperCase()??'C'}</span><span><strong>{org?.name??'No workspace'}</strong><small>{org?(demoMode?'Synthetic demo workspace':`${org.role} workspace`):'Workspace unavailable'}</small></span><ChevronDown size={15}/></div>
      <nav>{nav.map(group=><section key={group.label}><div className='nav-label'>{group.label}</div>{group.items.map(([Icon,label])=><button key={label} className={`nav-link ${label==='Dashboard'?'selected':''}`} title={label} onClick={()=>{const destination=destinations[label];if(destination)router.push(destination);else if(label!=='Dashboard')setError(`${label} is not available yet.`)}}><Icon size={17}/><span>{label}</span>{label==='Alerts'&&openAlerts>0&&<span className='nav-count'>{openAlerts}</span>}</button>)}</section>)}</nav>
      <div className='side-bottom'><div className='side-help'><CircleHelp size={17}/> Documentation <ArrowUpRight size={14}/></div><div className='profile'><span className='avatar'>CD</span><span><strong>{org?'Workspace member':'Not signed in'}</strong><small>{org?'Authenticated workspace':'Connect an account'}</small></span><ChevronDown size={14}/></div></div>
    </aside>
    <main className='main'>
      <header className='topbar'><div className='breadcrumbs'>Workspace <span>/</span> <strong>Dashboard</strong></div><div className='top-actions'><button className='keyboard' aria-label='Open global search' onClick={openGlobalSearch}><Command size={13}/> K</button><button aria-label='Search' onClick={openGlobalSearch}><Search size={19}/></button><button aria-label='Notifications' onClick={()=>router.push('/notifications')}><Bell size={19}/></button><span className='top-avatar'>CD</span></div></header>
      <div className='content'>
        <div className='page-head'><div><div className='eyebrow'>OVERVIEW <span className='head-date'>/ {new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</span></div><h1>Infrastructure overview</h1><p className='muted'>Your servers and services at a glance.</p></div><div className='dashboard-actions'>{org&&!demoMode&&<button className='demo-action' onClick={createDemoWorkspace} disabled={demoCreating}>{demoCreating?'Preparing demo…':'Open synthetic demo'}</button>}<button className='primary' onClick={addServer} disabled={!org||demoMode||loading} title={demoMode?'Demo workspaces are read-only':'Add a Linux server'}><Plus size={17}/> Add server</button></div></div>
        {demoMode&&<div className='demo-banner'><div><strong>Portfolio demo · synthetic data</strong><span>These server metrics, alerts and deployment events are generated fixtures. No external hosts are connected, and operational controls are disabled.</span></div><span className='demo-readonly'>READ ONLY</span></div>}
        {pairing&&<div className='pair-banner'><strong>Pairing token — shown once, expires in 10 minutes</strong><code>Server ID: {pairedServerId}<br/>Pairing token: {pairing}</code><span>Install the Go agent, then set CLOUDDECK_SERVER_ID and CLOUDDECK_PAIRING_TOKEN. See docs/AGENT_PROTOCOL.md.</span><button onClick={()=>setPairing('')}>Dismiss</button></div>}
        {error&&<div className='notice' role='alert'>{error}<button onClick={()=>void load()} disabled={loading}>Retry</button></div>}
        {loading?<div className='empty' role='status'>Loading workspace data…</div>:org&&!error?<><div className='section-title'>Fleet health <span>{demoMode?'SYNTHETIC DATA':'WORKSPACE DATA'}</span></div><div className='stats'><Stat icon={<Server size={19}/>} label='Total servers' value={servers.length} sub='Across this workspace'/><Stat icon={<Wifi size={19}/>} label='Online' value={online} sub='Reporting normally' color='green'/><Stat icon={<WifiOff size={19}/>} label='Offline' value={offline} sub={offline?'Needs your attention':'All systems online'} color='red'/><Stat icon={<Bell size={19}/>} label='Open alerts' value={openAlerts} sub='Active incidents' color='amber'/></div>
          <div className='section-line'><div><h2>Servers</h2><p className='muted'>{demoMode?'Synthetic fleet for the portfolio walkthrough':'Monitor and manage your infrastructure'}</p></div><div className='list-tools'><label className='search-box'><Search size={16}/><input id='server-filter' placeholder='Filter this server list...' value={filter} onChange={e=>setFilter(e.target.value)}/></label><span className='server-total'>{visible.length} servers</span></div></div>
          {visible.length>0?<div className='server-grid'>{visible.map(s=><article className='server-card' key={s.id}><div className='server-top'><div className='server-icon'><Server size={20}/></div><span className={`badge ${s.status}`}>● {s.status}</span></div><h3>{s.name}</h3><p className='hostname'>{s.hostname??'Awaiting agent pairing'}</p><div className='card-divider'/><div className='metric-row'><span><Cpu size={15}/> CPU</span><strong>{s.cpuPercent??'—'}{s.cpuPercent==null?'':'%'}</strong></div><div className='meter'><i style={{width:`${s.cpuPercent??0}%`}}/></div><div className='metric-row'><span><MemoryStick size={15}/> Memory</span><strong>{s.memoryPercent??'—'}{s.memoryPercent==null?'':'%'}</strong></div><div className='meter'><i style={{width:`${s.memoryPercent??0}%`}}/></div><div className='metric-row'><span><HardDrive size={15}/> Disk</span><strong>{s.diskPercent??'—'}{s.diskPercent==null?'':'%'}</strong></div><div className='meter'><i style={{width:`${s.diskPercent??0}%`}}/></div><div className='card-footer'><span>{s.status==='online'?'● Reporting normally':s.status==='pending'?'● Awaiting agent':'● Connection lost'}</span><button onClick={()=>router.push(`/servers/${s.id}`)}>View server <ArrowUpRight size={14}/></button></div></article>)}</div>:<div className='empty'>{demoMode?'The demo workspace has no synthetic servers yet.':'No servers connected yet. Add a Linux server to begin monitoring your fleet.'}</div>}</>:null}
        {!loading&&!org&&!error&&<div className='empty'>No workspace data is available.</div>}
        <footer className='page-footer'><span>CloudDeck · Server operations in one place</span><span><span className='system-dot'/>{demoMode?'Synthetic portfolio data':'Workspace data'}</span></footer>
      </div>
    </main>
  </div>;
}
function Stat({icon,label,value,sub,color='blue'}:{icon:React.ReactNode;label:string;value:number;sub:string;color?:string}){return <div className='stat'><div className={`stat-icon ${color}`}>{icon}</div><span className='stat-label'>{label}</span><strong>{value.toString().padStart(2,'0')}</strong><span className='stat-sub'>{sub}</span></div>}