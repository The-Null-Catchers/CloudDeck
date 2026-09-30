'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import {
  Activity,ArrowLeft,Clock3,Globe2,Pause,Play,Plus,RefreshCw,
  Server,ShieldCheck,Trash2,TriangleAlert
} from 'lucide-react';
import {api} from '@/lib/api';

type Org={id:string;name:string;role:string};
type Application={
  id:string;name:string;server_id:string;server_name:string|null;server_status:string|null;
  deployment_type:'dockerfile'|'compose';host_port:number|null;compose_project:string|null;
};
type Domain={
  id:string;application_id:string;hostname:string;proxy_type:'caddy'|'nginx';target_port:number;
  enabled:boolean;https_status:'unknown'|'valid'|'invalid'|'unreachable';certificate_expires_at:string|null;
  certificate_issuer:string|null;tls_error:string|null;last_tls_checked_at:string|null;next_tls_check_at:string;
  application_name:string;server_id:string|null;server_name:string|null;server_status:string|null;
  alert_id:string|null;alert_state:'open'|'acknowledged'|null;
};
type Form={applicationId:string;hostname:string;proxyType:'caddy'|'nginx';targetPort:string;enabled:boolean};

function when(value:string|null){return value?new Date(value).toLocaleString():'Never'}
function daysLeft(value:string|null){
  if(!value)return null;
  const ms=new Date(value).getTime()-Date.now();
  if(Number.isNaN(ms))return null;
  return Math.ceil(ms/86_400_000);
}

export default function DomainsPage(){
  const router=useRouter();
  const [org,setOrg]=useState<Org|null>(null);
  const [applications,setApplications]=useState<Application[]>([]);
  const [domains,setDomains]=useState<Domain[]>([]);
  const [showCreate,setShowCreate]=useState(false);
  const [form,setForm]=useState<Form>({applicationId:'',hostname:'',proxyType:'caddy',targetPort:'',enabled:true});
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState('');

  async function load(silent=false){
    if(!silent)setLoading(true);
    try{
      const orgs=await api<{organizations:Org[]}>('/organizations');
      const selected=orgs.organizations[0];
      if(!selected)throw new Error('No workspace found');
      const [domainData,appData]=await Promise.all([
        api<{domains:Domain[]}>(`/organizations/${selected.id}/domains`),
        api<{applications:Application[]}>(`/organizations/${selected.id}/applications`)
      ]);
      setOrg(selected);setDomains(domainData.domains);setApplications(appData.applications);setError('');
      setForm(current=>{
        if(current.applicationId||!appData.applications.length)return current;
        const app=appData.applications[0];
        return {...current,applicationId:app.id,targetPort:app.host_port?String(app.host_port):''};
      });
    }catch(e){setError(e instanceof Error?e.message:'Unable to load domains')}
    finally{if(!silent)setLoading(false)}
  }

  useEffect(()=>{void load();const timer=setInterval(()=>void load(true),30000);return()=>clearInterval(timer)},[]);

  function chooseApplication(applicationId:string){
    const application=applications.find(item=>item.id===applicationId);
    setForm(current=>({...current,applicationId,targetPort:application?.host_port?String(application.host_port):''}));
  }

  async function createDomain(event:React.FormEvent){
    event.preventDefault();
    if(!org||!form.applicationId)return;
    setBusy('create');setError('');
    try{
      await api(`/organizations/${org.id}/domains`,{
        method:'POST',
        body:JSON.stringify({
          applicationId:form.applicationId,
          hostname:form.hostname.trim(),
          proxyType:form.proxyType,
          targetPort:form.targetPort?Number(form.targetPort):undefined,
          enabled:form.enabled
        })
      });
      setShowCreate(false);
      setForm(current=>({...current,hostname:''}));
      await load(true);
    }catch(e){setError(e instanceof Error?e.message:'Unable to attach domain')}
    finally{setBusy(null)}
  }

  async function toggle(domain:Domain){
    setBusy(`toggle:${domain.id}`);setError('');
    try{
      await api(`/domains/${domain.id}`,{method:'PATCH',body:JSON.stringify({enabled:!domain.enabled})});
      setDomains(items=>items.map(item=>item.id===domain.id?{...item,enabled:!item.enabled}:item));
    }catch(e){setError(e instanceof Error?e.message:'Unable to update domain')}
    finally{setBusy(null)}
  }

  async function check(domain:Domain){
    setBusy(`check:${domain.id}`);setError('');
    try{
      await api(`/domains/${domain.id}/check`,{method:'POST'});
      await load(true);
    }catch(e){setError(e instanceof Error?e.message:'Unable to run TLS check')}
    finally{setBusy(null)}
  }

  async function remove(domain:Domain){
    if(!confirm(`Detach ${domain.hostname} from CloudDeck? This removes monitoring metadata but does not edit your proxy yet.`))return;
    setBusy(`delete:${domain.id}`);setError('');
    try{
      await api(`/domains/${domain.id}`,{method:'DELETE'});
      setDomains(items=>items.filter(item=>item.id!==domain.id));
    }catch(e){setError(e instanceof Error?e.message:'Unable to delete domain')}
    finally{setBusy(null)}
  }

  const summary=useMemo(()=>({
    valid:domains.filter(item=>item.https_status==='valid').length,
    warning:domains.filter(item=>{
      const days=daysLeft(item.certificate_expires_at);
      return item.alert_id||days!==null&&days<=14;
    }).length,
    unknown:domains.filter(item=>item.https_status==='unknown'||item.https_status==='unreachable'||item.https_status==='invalid').length
  }),[domains]);

  return <div className="deploy-page ops-page">
    <header className="deploy-topbar">
      <button onClick={()=>router.push('/dashboard')}><ArrowLeft size={16}/> Dashboard</button>
      <span><Activity size={18}/> clouddeck.</span>
      <div>{org?.name??'Workspace'} · Domains</div>
    </header>

    <main className="deploy-content">
      <section className="deploy-hero">
        <div><span className="eyebrow">INFRASTRUCTURE / DOMAINS</span><h1>Domains & TLS</h1><p>Attach hostnames to applications, track proxy targets, and monitor public TLS certificates.</p></div>
        <div className="deploy-hero-actions"><button className="deploy-refresh" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/> Refresh</button><button className="primary" onClick={()=>setShowCreate(value=>!value)}><Plus size={15}/> Add domain</button></div>
      </section>

      {error&&<div className="notice" role="status">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}

      <section className="deploy-stats domain-stats">
        <div><Globe2 size={18}/><span>Total domains</span><strong>{domains.length}</strong></div>
        <div><ShieldCheck size={18}/><span>TLS valid</span><strong>{summary.valid}</strong></div>
        <div><TriangleAlert size={18}/><span>Expiry warnings</span><strong>{summary.warning}</strong></div>
        <div><Clock3 size={18}/><span>Needs check</span><strong>{summary.unknown}</strong></div>
      </section>

      {showCreate&&<form className="deploy-section domain-create" onSubmit={createDomain}>
        <div className="deploy-section-head"><div><h2>Attach a domain</h2><p>CloudDeck monitors TLS now. Proxy automation is enabled separately so the unprivileged agent never receives blanket root access.</p></div></div>
        <div className="domain-form-grid">
          <label>Application<select required value={form.applicationId} onChange={e=>chooseApplication(e.target.value)}><option value="">Choose application</option>{applications.map(item=><option key={item.id} value={item.id}>{item.name} · {item.server_name??'server'}</option>)}</select></label>
          <label>Hostname<input required value={form.hostname} onChange={e=>setForm({...form,hostname:e.target.value})} placeholder="api.example.com"/></label>
          <label>Proxy type<select value={form.proxyType} onChange={e=>setForm({...form,proxyType:e.target.value as Form['proxyType']})}><option value="caddy">Caddy</option><option value="nginx">Nginx</option></select></label>
          <label>Target port<input required type="number" min={1} max={65535} value={form.targetPort} onChange={e=>setForm({...form,targetPort:e.target.value})} placeholder="4000"/></label>
        </div>
        <div className="domain-form-actions"><button type="button" onClick={()=>setShowCreate(false)}>Cancel</button><button className="primary" disabled={busy==='create'||!applications.length}>{busy==='create'?'Attaching…':'Attach domain'}</button></div>
      </form>}

      <section className="deploy-section">
        <div className="deploy-section-head"><div><h2>Attached domains</h2><p>Certificate checks run every six hours and can also be triggered manually.</p></div><span>{domains.length} configured</span></div>
        <div className="domain-list">
          {domains.map(domain=>{
            const days=daysLeft(domain.certificate_expires_at);
            const tlsClass=domain.https_status==='valid'&&(days===null||days>14)?'healthy':domain.https_status==='unknown'?'pending':'warning';
            return <article className="domain-row" key={domain.id}>
              <span className="domain-icon"><Globe2 size={18}/></span>
              <div className="domain-copy">
                <strong>{domain.hostname}</strong>
                <small>{domain.application_name} · {domain.server_name??'server'} · 127.0.0.1:{domain.target_port}</small>
                <em>{domain.proxy_type.toUpperCase()} · {domain.enabled?'Monitoring enabled':'Monitoring paused'}</em>
              </div>
              <div className="domain-tls">
                <span className={`health-state ${tlsClass}`}>{domain.https_status}</span>
                <strong>{days===null?'No certificate':days<0?`Expired ${Math.abs(days)}d ago`:`${days}d remaining`}</strong>
                <small>{domain.certificate_issuer??domain.tls_error??'Awaiting TLS probe'}</small>
              </div>
              <div className="domain-seen"><Clock3 size={13}/><span>{when(domain.last_tls_checked_at)}</span></div>
              <div className="domain-actions">
                <button title="Check TLS now" onClick={()=>void check(domain)} disabled={busy===`check:${domain.id}`}><RefreshCw size={15}/></button>
                <button title={domain.enabled?'Pause monitoring':'Resume monitoring'} onClick={()=>void toggle(domain)} disabled={busy===`toggle:${domain.id}`}>{domain.enabled?<Pause size={15}/>:<Play size={15}/>}</button>
                <button className="danger" title="Detach domain" onClick={()=>void remove(domain)} disabled={busy===`delete:${domain.id}`}><Trash2 size={15}/></button>
              </div>
            </article>
          })}
          {!domains.length&&!loading&&<div className="deployment-empty">No domains attached yet.</div>}
        </div>
      </section>

      <section className="domain-security-note">
        <Server size={17}/><div><strong>Proxy automation stays least-privilege</strong><span>This release records the intended Caddy/Nginx target and monitors TLS. The next agent integration uses a constrained privileged helper rather than weakening the agent service sandbox.</span></div>
      </section>
    </main>
  </div>
}
