'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import {
  Activity,ArrowLeft,Bell,CheckCircle2,Clock3,HeartPulse,RefreshCw,Server,
  ShieldAlert,TriangleAlert
} from 'lucide-react';
import {api} from '@/lib/api';

type Org={id:string;name:string;role:string};
type AlertState='open'|'acknowledged'|'resolved';
type Alert={
  id:string;organization_id:string;server_id:string|null;health_check_id:string|null;kind:string;
  state:AlertState;created_at:string;resolved_at:string|null;health_check_name:string|null;
  health_check_kind:string|null;health_check_target:string|null;server_name:string|null;
};

function when(value:string|null){return value?new Date(value).toLocaleString():'—'}
function label(value:string){return value.replaceAll('_',' ').replaceAll('.',' ')}

export default function AlertsPage(){
  const router=useRouter();
  const [org,setOrg]=useState<Org|null>(null);
  const [alerts,setAlerts]=useState<Alert[]>([]);
  const [filter,setFilter]=useState<'all'|AlertState>('open');
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState('');

  async function load(silent=false){
    if(!silent)setLoading(true);
    try{
      const orgs=await api<{organizations:Org[]}>('/organizations');
      const selected=orgs.organizations[0];
      if(!selected)throw new Error('No workspace found');
      const data=await api<{alerts:Alert[]}>(`/organizations/${selected.id}/alerts?state=all&limit=200`);
      setOrg(selected);setAlerts(data.alerts);setError('');
    }catch(e){setError(e instanceof Error?e.message:'Unable to load alerts')}
    finally{if(!silent)setLoading(false)}
  }

  useEffect(()=>{void load();const timer=setInterval(()=>void load(true),12000);return()=>clearInterval(timer)},[]);

  async function acknowledge(alert:Alert){
    setBusy(alert.id);setError('');
    try{
      await api(`/alerts/${alert.id}/acknowledge`,{method:'POST'});
      setAlerts(items=>items.map(item=>item.id===alert.id?{...item,state:'acknowledged'}:item));
    }catch(e){setError(e instanceof Error?e.message:'Unable to acknowledge alert')}
    finally{setBusy(null)}
  }

  const visible=useMemo(()=>filter==='all'?alerts:alerts.filter(item=>item.state===filter),[alerts,filter]);
  const counts={
    open:alerts.filter(item=>item.state==='open').length,
    acknowledged:alerts.filter(item=>item.state==='acknowledged').length,
    resolved:alerts.filter(item=>item.state==='resolved').length
  };

  return <div className="deploy-page ops-page">
    <header className="deploy-topbar">
      <button onClick={()=>router.push('/dashboard')}><ArrowLeft size={16}/> Dashboard</button>
      <span><Activity size={18}/> clouddeck.</span>
      <div>{org?.name??'Workspace'} · Alerts</div>
    </header>

    <main className="deploy-content">
      <section className="deploy-hero">
        <div><span className="eyebrow">OPERATIONS / ALERTS</span><h1>Incidents that need attention</h1><p>Acknowledge active incidents, inspect their source, and track automatic recovery.</p></div>
        <div className="deploy-hero-actions"><button className="deploy-refresh" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/> Refresh</button></div>
      </section>

      {error&&<div className="notice" role="status">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}

      <section className="deploy-stats">
        <div><Bell size={18}/><span>Total</span><strong>{alerts.length}</strong></div>
        <div><TriangleAlert size={18}/><span>Open</span><strong>{counts.open}</strong></div>
        <div><ShieldAlert size={18}/><span>Acknowledged</span><strong>{counts.acknowledged}</strong></div>
        <div><CheckCircle2 size={18}/><span>Resolved</span><strong>{counts.resolved}</strong></div>
      </section>

      <section className="deploy-section">
        <div className="deploy-section-head alert-head">
          <div><h2>Alert timeline</h2><p>Open and acknowledged alerts remain active until the underlying condition recovers.</p></div>
          <div className="alert-filters">
            {(['open','acknowledged','resolved','all'] as const).map(value=><button key={value} className={filter===value?'active':''} onClick={()=>setFilter(value)}>{value}</button>)}
          </div>
        </div>

        <div className="alert-list">
          {visible.map(alert=>{
            const health=Boolean(alert.health_check_id);
            return <article className={`alert-row ${alert.state}`} key={alert.id}>
              <span className="alert-icon">{health?<HeartPulse size={18}/>:<Server size={18}/>}</span>
              <div className="alert-copy">
                <div><strong>{health?(alert.health_check_name??'Health check failed'):(alert.server_name??'Server alert')}</strong><span className={`health-state ${alert.state==='open'?'failing':alert.state}`}>{alert.state}</span></div>
                <p>{health?(alert.health_check_target??label(alert.kind)):label(alert.kind)}</p>
                <small><Clock3 size={12}/> Opened {when(alert.created_at)}{alert.resolved_at?` · Resolved ${when(alert.resolved_at)}`:''}</small>
              </div>
              <div className="alert-actions">
                {alert.state==='open'&&<button className="primary" onClick={()=>void acknowledge(alert)} disabled={busy===alert.id}>{busy===alert.id?'Acknowledging…':'Acknowledge'}</button>}
                {health&&<button onClick={()=>router.push('/health-checks')}>View check</button>}
              </div>
            </article>
          })}
          {!visible.length&&!loading&&<div className="deployment-empty">No alerts in this state.</div>}
        </div>
      </section>
    </main>
  </div>
}
