'use client';

import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import {Activity,ArrowLeft,Copy,KeyRound,RefreshCw,ShieldCheck,ShieldOff} from 'lucide-react';
import {api} from '@/lib/api';

type Status={enabled:boolean;enabledAt:string|null;recoveryCodesRemaining:number};
type Setup={secret:string;otpauthUri:string};

export default function SecurityPage(){
  const router=useRouter();
  const [status,setStatus]=useState<Status|null>(null);
  const [setup,setSetup]=useState<Setup|null>(null);
  const [setupPassword,setSetupPassword]=useState('');
  const [code,setCode]=useState('');
  const [password,setPassword]=useState('');
  const [recoveryCodes,setRecoveryCodes]=useState<string[]>([]);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState('');

  async function load(){
    setBusy('load');
    try{setStatus(await api<Status>('/auth/2fa/status'));setError('')}
    catch(e){setError(e instanceof Error?e.message:'Unable to load security settings')}
    finally{setBusy(null)}
  }
  useEffect(()=>{void load()},[]);

  async function beginSetup(event:React.FormEvent){
    event.preventDefault();setBusy('setup');setError('');setRecoveryCodes([]);
    try{
      const result=await api<Setup>('/auth/2fa/setup',{method:'POST',body:JSON.stringify({password:setupPassword})});
      setSetup(result);setCode('');
    }catch(e){setError(e instanceof Error?e.message:'Unable to start two-factor setup')}
    finally{setBusy(null)}
  }

  async function enable(event:React.FormEvent){
    event.preventDefault();setBusy('enable');setError('');
    try{
      const result=await api<{enabled:true;recoveryCodes:string[]}>('/auth/2fa/enable',{method:'POST',body:JSON.stringify({code})});
      setRecoveryCodes(result.recoveryCodes);setSetup(null);setSetupPassword('');setCode('');await load();
    }catch(e){setError(e instanceof Error?e.message:'Unable to enable two-factor authentication')}
    finally{setBusy(null)}
  }

  async function regenerate(){
    if(!password||!code)return;
    if(!confirm('Replace all existing recovery codes? Any unused old code will stop working.'))return;
    setBusy('recovery');setError('');
    try{
      const result=await api<{recoveryCodes:string[]}>('/auth/2fa/recovery-codes',{method:'POST',body:JSON.stringify({password,code})});
      setRecoveryCodes(result.recoveryCodes);setPassword('');setCode('');await load();
    }catch(e){setError(e instanceof Error?e.message:'Unable to regenerate recovery codes')}
    finally{setBusy(null)}
  }

  async function disable(){
    if(!password||!code)return;
    if(!confirm('Disable two-factor authentication? Other active sessions will be revoked.'))return;
    setBusy('disable');setError('');
    try{
      await api('/auth/2fa/disable',{method:'POST',body:JSON.stringify({password,code})});
      setPassword('');setCode('');setRecoveryCodes([]);setSetup(null);await load();
    }catch(e){setError(e instanceof Error?e.message:'Unable to disable two-factor authentication')}
    finally{setBusy(null)}
  }

  async function copy(value:string){try{await navigator.clipboard.writeText(value)}catch{setError('Clipboard access is unavailable')}}

  return <div className="deploy-page ops-page">
    <header className="deploy-topbar">
      <button onClick={()=>router.push('/dashboard')}><ArrowLeft size={16}/> Dashboard</button>
      <span><Activity size={18}/> clouddeck.</span>
      <div>Account · Security</div>
    </header>
    <main className="deploy-content">
      <section className="deploy-hero">
        <div><span className="eyebrow">SETTINGS / SECURITY</span><h1>Two-factor authentication</h1><p>Protect password sign-in with a standards-based TOTP authenticator and one-time recovery codes.</p></div>
        <div className="deploy-hero-actions"><button className="deploy-refresh" onClick={()=>void load()} disabled={busy!==null}><RefreshCw size={15}/> Refresh</button></div>
      </section>
      {error&&<div className="notice" role="alert">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}

      <section className="deploy-stats">
        <div><ShieldCheck size={18}/><span>TOTP</span><strong>{status?.enabled?'On':'Off'}</strong></div>
        <div><KeyRound size={18}/><span>Recovery codes</span><strong>{status?.recoveryCodesRemaining??0}</strong></div>
        <div><ShieldCheck size={18}/><span>Challenge</span><strong>5 min</strong></div>
        <div><ShieldCheck size={18}/><span>Code window</span><strong>±30s</strong></div>
      </section>

      {!status?.enabled&&!setup&&<form className="deploy-section secret-form" onSubmit={beginSetup}>
        <div className="deploy-section-head"><div><h2>Enable authenticator app</h2><p>Re-enter your current password before CloudDeck generates an encrypted TOTP secret.</p></div></div>
        <div className="domain-form-grid"><label className="secret-wide">Current password<input required type="password" autoComplete="current-password" minLength={12} value={setupPassword} onChange={e=>setSetupPassword(e.target.value)}/></label></div>
        <div className="domain-form-actions"><button className="primary" disabled={busy!==null}>{busy==='setup'?'Preparing…':'Start setup'}</button></div>
      </form>}

      {setup&&<form className="deploy-section secret-form" onSubmit={enable}>
        <div className="deploy-section-head"><div><h2>Add CloudDeck to your authenticator</h2><p>Enter the secret manually or open the otpauth URI in a compatible authenticator, then verify one generated code.</p></div></div>
        <div className="pair-banner">
          <strong>Authenticator secret</strong>
          <code>{setup.secret}</code>
          <button type="button" onClick={()=>void copy(setup.secret)}><Copy size={14}/> Copy secret</button>
          <button type="button" onClick={()=>void copy(setup.otpauthUri)}><Copy size={14}/> Copy authenticator URI</button>
        </div>
        <div className="domain-form-grid">
          <label className="secret-wide">One-time code<input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={e=>setCode(e.target.value)} placeholder="123456"/></label>
        </div>
        <div className="domain-form-actions"><button type="button" onClick={()=>{setSetup(null);setCode('')}}>Cancel</button><button className="primary" disabled={busy!==null}>{busy==='enable'?'Verifying…':'Enable 2FA'}</button></div>
      </form>}

      {status?.enabled&&<section className="deploy-section secret-form">
        <div className="deploy-section-head"><div><h2>Manage two-factor authentication</h2><p>Recovery-code replacement and disabling both require your password plus a valid second factor.</p></div><span className="health-state healthy">enabled</span></div>
        <div className="domain-form-grid">
          <label>Current password<input type="password" autoComplete="current-password" minLength={12} value={password} onChange={e=>setPassword(e.target.value)}/></label>
          <label>Authenticator / recovery code<input autoComplete="one-time-code" minLength={6} maxLength={32} value={code} onChange={e=>setCode(e.target.value)}/></label>
        </div>
        <div className="domain-form-actions">
          <button type="button" onClick={()=>void regenerate()} disabled={busy!==null||!password||!code}><KeyRound size={14}/> {busy==='recovery'?'Replacing…':'Replace recovery codes'}</button>
          <button type="button" className="danger" onClick={()=>void disable()} disabled={busy!==null||!password||!code}><ShieldOff size={14}/> {busy==='disable'?'Disabling…':'Disable 2FA'}</button>
        </div>
      </section>}

      {recoveryCodes.length>0&&<section className="deploy-section">
        <div className="deploy-section-head"><div><h2>Save your recovery codes now</h2><p>Each code works once. CloudDeck stores only hashes and cannot show these codes again.</p></div><button onClick={()=>void copy(recoveryCodes.join('\n'))}><Copy size={14}/> Copy all</button></div>
        <div className="pair-banner"><code>{recoveryCodes.join('\n')}</code></div>
      </section>}

      <section className="domain-security-note">
        <ShieldCheck size={17}/><div><strong>Encrypted secret, hashed recovery codes</strong><span>The TOTP secret uses the same authenticated AES-256-GCM key boundary as CloudDeck secrets. Recovery codes are stored only as SHA-256 hashes and are consumed atomically.</span></div>
      </section>
    </main>
  </div>
}
