'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import {Activity,ArrowLeft,ChartNoAxesCombined,Cpu,HardDrive,MemoryStick,Network,RefreshCw,Server} from 'lucide-react';
import {api} from '@/lib/api';

type Org={id:string;name:string;role:string};
type Range='1h'|'6h'|'24h'|'7d'|'30d';
type Point={bucket_at:string;cpu_percent:number|null;memory_percent:number|null;disk_percent:number|null;load_1:number|null;network_rx_bytes:number|null;network_tx_bytes:number|null;reporting_servers:number};
type ServerMetric={id:string;name:string;hostname:string|null;status:string;lastSeenAt:string|null;cpuPercent:number|null;memoryPercent:number|null;diskPercent:number|null;load1:number|null;networkRxBytes:number|null;networkTxBytes:number|null};
type MetricResponse={range:Range;resolution:'minute'|'hour';servers:ServerMetric[];points:Point[]};
const ranges:Range[]=['1h','6h','24h','7d','30d'];
const n=(value:number|null|undefined)=>value==null?0:Number(value);
const pct=(value:number|null|undefined)=>value==null?'—':`${Number(value).toFixed(1)}%`;
const bytes=(value:number|null|undefined)=>{if(value==null)return '—';const units=['B','KB','MB','GB','TB'];let x=Number(value),i=0;while(x>=1024&&i<units.length-1){x/=1024;i++}return `${x.toFixed(i?1:0)} ${units[i]}`};

export default function MetricsPage(){
  const router=useRouter();
  const [org,setOrg]=useState<Org|null>(null);const [range,setRange]=useState<Range>('24h');const [data,setData]=useState<MetricResponse|null>(null);const [loading,setLoading]=useState(true);const [error,setError]=useState('');
  async function load(silent=false){if(!silent)setLoading(true);try{const orgs=await api<{organizations:Org[]}>('/organizations');const selected=orgs.organizations[0];if(!selected)throw new Error('No workspace found');const metrics=await api<MetricResponse>(`/organizations/${selected.id}/metrics?range=${range}`);setOrg(selected);setData(metrics);setError('')}catch(e){setError(e instanceof Error?e.message:'Unable to load metrics')}finally{if(!silent)setLoading(false)}}
  useEffect(()=>{void load();const timer=setInterval(()=>void load(true),15000);return()=>clearInterval(timer)},[range]);
  const latest=data?.points.at(-1);const reporting=data?.servers.filter(s=>s.cpuPercent!=null).length??0;
  const busiest=useMemo(()=>[...(data?.servers??[])].filter(s=>s.cpuPercent!=null).sort((a,b)=>n(b.cpuPercent)-n(a.cpuPercent)).slice(0,20),[data]);
  return <div className="deploy-page ops-page">
    <header className="deploy-topbar"><button onClick={()=>router.push('/dashboard')}><ArrowLeft size={16}/> Dashboard</button><span><Activity size={18}/> clouddeck.</span><div>{org?.name??'Workspace'} · Metrics</div></header>
    <main className="deploy-content">
      <section className="deploy-hero"><div><span className="eyebrow">OBSERVABILITY / METRICS</span><h1>Fleet performance</h1><p>Compare infrastructure pressure across your workspace and inspect fleet-wide trends.</p></div><div className="deploy-hero-actions"><button className="deploy-refresh" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/> Refresh</button></div></section>
      {error&&<div className="notice" role="status">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}
      <section className="deploy-stats"><div><Server size={18}/><span>Servers</span><strong>{data?.servers.length??0}</strong></div><div><Cpu size={18}/><span>Fleet CPU</span><strong>{pct(latest?.cpu_percent)}</strong></div><div><MemoryStick size={18}/><span>Memory</span><strong>{pct(latest?.memory_percent)}</strong></div><div><ChartNoAxesCombined size={18}/><span>Reporting</span><strong>{reporting}</strong></div></section>
      <section className="deploy-section">
        <div className="deploy-section-head alert-head"><div><h2>Fleet trend</h2><p>{data?.resolution==='hour'?'Hourly rollups':'Minute-level samples'} averaged across reporting servers.</p></div><div className="alert-filters">{ranges.map(item=><button key={item} className={range===item?'active':''} onClick={()=>setRange(item)}>{item}</button>)}</div></div>
        {data?.points.length?<FleetChart points={data.points}/>:<div className="deployment-empty">{loading?'Loading metrics…':'No metric samples in this range.'}</div>}
      </section>
      <section className="deploy-section"><div className="deploy-section-head"><div><h2>Server pressure</h2><p>Latest sample per server, sorted by CPU usage.</p></div></div><div className="alert-list">
        {busiest.map(server=><article className="alert-row" key={server.id}><span className="alert-icon"><Server size={18}/></span><div className="alert-copy"><div><strong>{server.name}</strong><span className={`health-state ${server.status==='online'?'resolved':'failing'}`}>{server.status}</span></div><p>{server.hostname??'Agent not paired'} · load {server.load1==null?'—':Number(server.load1).toFixed(2)}</p><small><Network size={12}/> RX {bytes(server.networkRxBytes)} · TX {bytes(server.networkTxBytes)}</small></div><div className="alert-actions"><button onClick={()=>router.push(`/servers/${server.id}`)}>Open server</button></div><div style={{minWidth:220}}><div className="metric-row"><span><Cpu size={14}/> CPU</span><strong>{pct(server.cpuPercent)}</strong></div><div className="metric-row"><span><MemoryStick size={14}/> Memory</span><strong>{pct(server.memoryPercent)}</strong></div><div className="metric-row"><span><HardDrive size={14}/> Disk</span><strong>{pct(server.diskPercent)}</strong></div></div></article>)}
        {!busiest.length&&!loading&&<div className="deployment-empty">No servers are reporting metrics yet.</div>}
      </div></section>
    </main>
  </div>
}

function FleetChart({points}:{points:Point[]}){const sample=points.length<=180?points:Array.from({length:180},(_,i)=>points[Math.round(i*(points.length-1)/179)]);const line=(key:'cpu_percent'|'memory_percent'|'disk_percent')=>sample.map((p,i)=>`${(i/Math.max(1,sample.length-1))*900},${180-Math.min(100,Math.max(0,n(p[key])))*1.7}`).join(' ');return <div><svg className="chart-svg" role="img" aria-label="Fleet CPU, memory, and disk usage over time" viewBox="0 0 900 200" preserveAspectRatio="none"><path d="M0 10H900 M0 95H900 M0 180H900" stroke="#e9edf5" fill="none"/><polyline points={line('disk_percent')} fill="none" stroke="#e5ad58" strokeWidth="2.5"/><polyline points={line('memory_percent')} fill="none" stroke="#56bfa0" strokeWidth="2.5"/><polyline points={line('cpu_percent')} fill="none" stroke="#4668e7" strokeWidth="3"/></svg><div className="chart-legend"><span>● CPU</span><span>● Memory</span><span>● Disk</span></div></div>}
