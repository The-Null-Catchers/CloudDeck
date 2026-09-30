'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import {Activity,ArrowLeft,KeyRound,Plus,RefreshCw,RotateCcw,ShieldCheck,Trash2} from 'lucide-react';
import {api} from '@/lib/api';

type Org={id:string;name:string;role:'owner'|'admin'|'operator'|'viewer'|string};
type SecretItem={
  id:string;organizationId:string;name:string;kind:'environment'|'api_key'|'deployment'|'backup'|'other';
  description:string|null;createdBy:string|null;createdAt:string;updatedAt:string;valueConfigured:boolean;
};
type Form={name:string;kind:SecretItem['kind'];description:string;value:string};

const emptyForm:Form={name:'',kind:'environment',description:'',value:''};

function when(value:string){return new Date(value).toLocaleString()}

export default function SecretsPage(){
  const router=useRouter();
  const [org,setOrg]=useState<Org|null>(null);
  const [secrets,setSecrets]=useState<SecretItem[]>([]);
  const [form,setForm]=useState<Form>(emptyForm);
  const [rotate,setRotate]=useState<SecretItem|null>(null);
  const [rotateValue,setRotateValue]=useState('');
  const [showCreate,setShowCreate]=useState(false);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState('');

  const canManage=org?.role==='owner'||org?.role==='admin';

  async function load(){
    setLoading(true);
    try{
      const orgs=await api<{organizations:Org[]}>('/organizations');
      const selected=orgs.organizations[0];
      if(!selected)throw new Error('No workspace found');
      const result=await api<{secrets:SecretItem[]}>(`/organizations/${selected.id}/secrets`);
      setOrg(selected);setSecrets(result.secrets);setError('');
    }catch(e){setError(e instanceof Error?e.message:'Unable to load secrets')}
    finally{setLoading(false)}
  }

  useEffect(()=>{void load()},[]);

  async function createSecret(event:React.FormEvent){
    event.preventDefault();
    if(!org||!canManage)return;
    setBusy('create');setError('');
    try{
      await api(`/organizations/${org.id}/secrets`,{
        method:'POST',
        body:JSON.stringify({
          name:form.name.trim(),
          kind:form.kind,
          description:form.description.trim()||null,
          value:form.value
        })
      });
      setForm(emptyForm);setShowCreate(false);await load();
    }catch(e){setError(e instanceof Error?e.message:'Unable to create secret')}
    finally{setBusy(null)}
  }

  async function rotateSecret(event:React.FormEvent){
    event.preventDefault();
    if(!rotate||!canManage)return;
    setBusy(`rotate:${rotate.id}`);setError('');
    try{
      await api(`/secrets/${rotate.id}`,{method:'PATCH',body:JSON.stringify({value:rotateValue})});
      setRotate(null);setRotateValue('');await load();
    }catch(e){setError(e instanceof Error?e.message:'Unable to rotate secret')}
    finally{setBusy(null)}
  }

  async function remove(secret:SecretItem){
    if(!canManage||!confirm(`Delete secret metadata for ${secret.name}? This cannot be undone.`))return;
    setBusy(`delete:${secret.id}`);setError('');
    try{
      await api(`/secrets/${secret.id}`,{method:'DELETE',body:JSON.stringify({confirm:true})});
      setSecrets(items=>items.filter(item=>item.id!==secret.id));
    }catch(e){setError(e instanceof Error?e.message:'Unable to delete secret')}
    finally{setBusy(null)}
  }

  const summary=useMemo(()=>({
    total:secrets.length,
    deployment:secrets.filter(item=>item.kind==='deployment').length,
    backup:secrets.filter(item=>item.kind==='backup').length,
    other:secrets.filter(item=>!['deployment','backup'].includes(item.kind)).length
  }),[secrets]);

  return <div className="deploy-page ops-page">
    <header className="deploy-topbar">
      <button onClick={()=>router.push('/dashboard')}><ArrowLeft size={16}/> Dashboard</button>
      <span><Activity size={18}/> clouddeck.</span>
      <div>{org?.name??'Workspace'} · Secrets</div>
    </header>

    <main className="deploy-content">
      <section className="deploy-hero">
        <div><span className="eyebrow">ORGANIZATION / SECRETS</span><h1>Encrypted secrets</h1><p>Store deployment, backup, API, and environment secrets without exposing plaintext in the dashboard.</p></div>
        <div className="deploy-hero-actions"><button className="deploy-refresh" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/> Refresh</button>{canManage&&<button className="primary" onClick={()=>setShowCreate(value=>!value)}><Plus size={15}/> Add secret</button>}</div>
      </section>

      {error&&<div className="notice" role="status">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}

      <section className="deploy-stats secret-stats">
        <div><KeyRound size={18}/><span>Total secrets</span><strong>{summary.total}</strong></div>
        <div><ShieldCheck size={18}/><span>Deployment</span><strong>{summary.deployment}</strong></div>
        <div><ShieldCheck size={18}/><span>Backup</span><strong>{summary.backup}</strong></div>
        <div><ShieldCheck size={18}/><span>Other</span><strong>{summary.other}</strong></div>
      </section>

      {showCreate&&canManage&&<form className="deploy-section secret-form" onSubmit={createSecret}>
        <div className="deploy-section-head"><div><h2>Add encrypted secret</h2><p>The plaintext value is sent only for encryption and is never returned by the API.</p></div></div>
        <div className="domain-form-grid">
          <label>Name<input required maxLength={120} value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="PROD_DATABASE_URL"/></label>
          <label>Kind<select value={form.kind} onChange={e=>setForm({...form,kind:e.target.value as SecretItem['kind']})}><option value="environment">Environment</option><option value="api_key">API key</option><option value="deployment">Deployment</option><option value="backup">Backup</option><option value="other">Other</option></select></label>
          <label className="secret-wide">Description<input maxLength={500} value={form.description} onChange={e=>setForm({...form,description:e.target.value})} placeholder="Production database connection"/></label>
          <label className="secret-wide">Secret value<input required type="password" autoComplete="new-password" value={form.value} onChange={e=>setForm({...form,value:e.target.value})} placeholder="Encrypted after submit"/></label>
        </div>
        <div className="domain-form-actions"><button type="button" onClick={()=>setShowCreate(false)}>Cancel</button><button className="primary" disabled={busy==='create'}>{busy==='create'?'Encrypting…':'Save secret'}</button></div>
      </form>}

      {rotate&&canManage&&<form className="deploy-section secret-form" onSubmit={rotateSecret}>
        <div className="deploy-section-head"><div><h2>Rotate {rotate.name}</h2><p>The previous ciphertext is replaced atomically after authenticated encryption succeeds.</p></div></div>
        <div className="domain-form-grid"><label className="secret-wide">New secret value<input required type="password" autoComplete="new-password" value={rotateValue} onChange={e=>setRotateValue(e.target.value)} placeholder="New value"/></label></div>
        <div className="domain-form-actions"><button type="button" onClick={()=>{setRotate(null);setRotateValue('')}}>Cancel</button><button className="primary" disabled={busy===`rotate:${rotate.id}`}>{busy===`rotate:${rotate.id}`?'Rotating…':'Rotate secret'}</button></div>
      </form>}

      <section className="deploy-section">
        <div className="deploy-section-head"><div><h2>Secret inventory</h2><p>Only metadata is visible. There is intentionally no plaintext reveal action.</p></div><span>{secrets.length} configured</span></div>
        <div className="secret-list">
          {secrets.map(secret=><article className="secret-row" key={secret.id}>
            <span className="secret-icon"><KeyRound size={17}/></span>
            <div className="secret-copy"><strong>{secret.name}</strong><small>{secret.description??'No description'}</small><em>{secret.kind.replace('_',' ')} · updated {when(secret.updatedAt)}</em></div>
            <span className="health-state healthy">encrypted</span>
            {canManage?<div className="domain-actions"><button title="Rotate secret" onClick={()=>{setRotate(secret);setRotateValue('')}}><RotateCcw size={15}/></button><button className="danger" title="Delete secret" onClick={()=>void remove(secret)} disabled={busy===`delete:${secret.id}`}><Trash2 size={15}/></button></div>:<span className="secret-readonly">Read-only metadata</span>}
          </article>)}
          {!secrets.length&&!loading&&<div className="deployment-empty">No secrets configured yet.</div>}
        </div>
      </section>

      <section className="domain-security-note">
        <ShieldCheck size={17}/><div><strong>Plaintext stays out of the UI</strong><span>CloudDeck stores authenticated ciphertext separately from metadata. Admins and owners can rotate or delete values; operators and viewers only see inventory metadata.</span></div>
      </section>
    </main>
  </div>
}
