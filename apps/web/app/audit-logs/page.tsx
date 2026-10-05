'use client';

import {useEffect,useMemo,useState,type CSSProperties} from 'react';
import {useRouter} from 'next/navigation';
import {Activity,ArrowLeft,Clock3,Filter,RefreshCw,Search,ShieldCheck,UserRound} from 'lucide-react';
import {api} from '@/lib/api';

type Org={id:string;name:string;role:string};
type AuditLog={
  id:number;action:string;resource_type:string;resource_id:string|null;ip:string|null;
  metadata:Record<string,unknown>;created_at:string;actor_email:string|null;
};
type AuditResponse={auditLogs:AuditLog[];nextBeforeId:number|null};

const styles:Record<string,CSSProperties>={
  toolbar:{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'},
  search:{display:'flex',alignItems:'center',gap:8,border:'1px solid #dfe5ee',borderRadius:9,padding:'9px 11px',background:'#fff',minWidth:260},
  input:{border:0,outline:0,background:'transparent',width:'100%',color:'#15243b'},
  select:{border:'1px solid #dfe5ee',borderRadius:9,padding:'9px 11px',background:'#fff',color:'#15243b'},
  list:{display:'grid',gap:10},
  row:{display:'grid',gridTemplateColumns:'minmax(210px,1.4fr) minmax(150px,1fr) minmax(180px,1fr) minmax(190px,1fr)',gap:16,alignItems:'start',padding:'15px 16px',border:'1px solid #e6ebf2',borderRadius:12,background:'#fff'},
  cell:{minWidth:0},
  muted:{display:'block',marginTop:5,color:'#8b97a7',fontSize:12,overflow:'hidden',textOverflow:'ellipsis'},
  action:{fontSize:13,fontWeight:800,color:'#17243a',wordBreak:'break-word'},
  badge:{display:'inline-flex',alignItems:'center',padding:'4px 7px',borderRadius:999,background:'#f0f3fb',color:'#5369cf',fontSize:10,fontWeight:800,textTransform:'uppercase',letterSpacing:'.45px'},
  metadata:{marginTop:7,fontFamily:'ui-monospace,SFMono-Regular,Menlo,monospace',fontSize:11,color:'#667386',whiteSpace:'pre-wrap',wordBreak:'break-word'},
  footer:{display:'flex',justifyContent:'center',paddingTop:8}
};

function formatAction(value:string){return value.replaceAll('.',' › ').replaceAll('_',' ')}
function stringifyMetadata(value:Record<string,unknown>){
  if(!Object.keys(value??{}).length)return 'No metadata';
  try{return JSON.stringify(value,null,2)}catch{return 'Metadata unavailable'}
}

export default function AuditLogsPage(){
  const router=useRouter();
  const [org,setOrg]=useState<Org|null>(null);
  const [logs,setLogs]=useState<AuditLog[]>([]);
  const [nextBeforeId,setNextBeforeId]=useState<number|null>(null);
  const [loading,setLoading]=useState(true);
  const [loadingMore,setLoadingMore]=useState(false);
  const [error,setError]=useState('');
  const [query,setQuery]=useState('');
  const [resourceType,setResourceType]=useState('all');

  async function fetchPage(selected:Org,beforeId?:number){
    const suffix=beforeId?`?limit=100&beforeId=${beforeId}`:'?limit=100';
    return api<AuditResponse>(`/organizations/${selected.id}/audit-logs${suffix}`);
  }

  async function load(){
    setLoading(true);
    try{
      const orgs=await api<{organizations:Org[]}>('/organizations');
      const selected=orgs.organizations[0];
      if(!selected)throw new Error('No workspace found');
      const data=await fetchPage(selected);
      setOrg(selected);setLogs(data.auditLogs);setNextBeforeId(data.nextBeforeId);setError('');
    }catch(e){setError(e instanceof Error?e.message:'Unable to load audit logs')}
    finally{setLoading(false)}
  }

  useEffect(()=>{void load()},[]);

  async function loadMore(){
    if(!org||!nextBeforeId||loadingMore)return;
    setLoadingMore(true);
    try{
      const data=await fetchPage(org,nextBeforeId);
      setLogs(items=>[...items,...data.auditLogs]);setNextBeforeId(data.nextBeforeId);
    }catch(e){setError(e instanceof Error?e.message:'Unable to load older audit logs')}
    finally{setLoadingMore(false)}
  }

  const resourceTypes=useMemo(()=>Array.from(new Set(logs.map(item=>item.resource_type))).sort(),[logs]);
  const visible=useMemo(()=>{
    const needle=query.trim().toLowerCase();
    return logs.filter(item=>{
      if(resourceType!=='all'&&item.resource_type!==resourceType)return false;
      if(!needle)return true;
      return `${item.action} ${item.resource_type} ${item.resource_id??''} ${item.actor_email??''} ${item.ip??''}`.toLowerCase().includes(needle);
    });
  },[logs,query,resourceType]);

  return <div className="deploy-page ops-page">
    <header className="deploy-topbar">
      <button onClick={()=>router.push('/dashboard')}><ArrowLeft size={16}/> Dashboard</button>
      <span><Activity size={18}/> clouddeck.</span>
      <div>{org?.name??'Workspace'} · Audit logs</div>
    </header>

    <main className="deploy-content">
      <section className="deploy-hero">
        <div><span className="eyebrow">ORGANIZATION / AUDIT LOGS</span><h1>Operational activity trail</h1><p>Review workspace actions with actor, resource, origin, timestamp, and sanitized metadata.</p></div>
        <div className="deploy-hero-actions"><button className="deploy-refresh" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/> Refresh</button></div>
      </section>

      {error&&<div className="notice" role="status">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}

      <section className="deploy-stats">
        <div><ShieldCheck size={18}/><span>Loaded events</span><strong>{logs.length}</strong></div>
        <div><UserRound size={18}/><span>Actors</span><strong>{new Set(logs.map(item=>item.actor_email).filter(Boolean)).size}</strong></div>
        <div><Filter size={18}/><span>Resource types</span><strong>{resourceTypes.length}</strong></div>
        <div><Clock3 size={18}/><span>Retention view</span><strong>{nextBeforeId?'100+':'≤100'}</strong></div>
      </section>

      <section className="deploy-section">
        <div className="deploy-section-head">
          <div><h2>Audit events</h2><p>Secret-like metadata fields are redacted by the API before they reach the browser.</p></div>
          <div style={styles.toolbar}>
            <label style={styles.search}><Search size={15}/><input style={styles.input} value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search events…"/></label>
            <select style={styles.select} value={resourceType} onChange={event=>setResourceType(event.target.value)} aria-label="Resource type filter"><option value="all">All resources</option>{resourceTypes.map(value=><option key={value} value={value}>{value}</option>)}</select>
          </div>
        </div>

        <div style={styles.list}>
          {visible.map(item=><article key={item.id} style={styles.row}>
            <div style={styles.cell}><span style={styles.badge}>{item.resource_type}</span><div style={styles.action}>{formatAction(item.action)}</div><small style={styles.muted}>{item.resource_id??'Workspace-level event'}</small></div>
            <div style={styles.cell}><strong>{item.actor_email??'System'}</strong><small style={styles.muted}>{item.ip??'No client IP'}</small></div>
            <div style={styles.cell}><strong>{new Date(item.created_at).toLocaleString()}</strong><small style={styles.muted}>Event #{item.id}</small></div>
            <div style={styles.cell}><strong>Metadata</strong><pre style={styles.metadata}>{stringifyMetadata(item.metadata)}</pre></div>
          </article>)}
          {!visible.length&&!loading&&<div className="deployment-empty">No audit events match the current filters.</div>}
          {loading&&<div className="deployment-empty">Loading audit trail…</div>}
        </div>
        {nextBeforeId&&<div style={styles.footer}><button className="deploy-refresh" onClick={()=>void loadMore()} disabled={loadingMore}>{loadingMore?'Loading…':'Load older events'}</button></div>}
      </section>
    </main>
  </div>
}
