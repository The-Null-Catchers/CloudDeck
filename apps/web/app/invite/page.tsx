'use client';

import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import {Activity,ArrowRight,CheckCircle2,Mail,ShieldCheck} from 'lucide-react';
import {api} from '@/lib/api';

export default function InvitePage(){
  const router=useRouter();
  const [token,setToken]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [accepted,setAccepted]=useState(false);
  useEffect(()=>{setToken(new URLSearchParams(window.location.search).get('token')??'')},[]);

  async function accept(){
    if(!token)return;setBusy(true);setError('');
    try{
      const result=await api<{ok:boolean;organizationId:string}>('/invitations/accept',{method:'POST',body:JSON.stringify({token})});
      if(result.ok)setAccepted(true);
    }catch(e){setError(e instanceof Error?e.message:'Unable to accept invitation')}
    finally{setBusy(false)}
  }

  function signIn(){
    const returnTo=token?`/invite?token=${encodeURIComponent(token)}`:'/invite';
    router.push(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  return <main className="auth-shell"><div className="auth-card" style={{maxWidth:520}}><div className="brand"><span className="brand-icon"><Activity size={20}/></span>clouddeck<span className="brand-dot">.</span></div>{accepted?<><CheckCircle2 size={44}/><h1>Workspace joined</h1><p className="muted">Your CloudDeck account now has access to the invited workspace.</p><button className="primary full" onClick={()=>router.push('/dashboard')}>Open dashboard <ArrowRight size={16}/></button></>:<><Mail size={42}/><h1>Workspace invitation</h1><p className="muted">Sign in with the exact email address that received this invitation, then accept it. The server verifies the account email before granting access.</p><div className="notice" style={{textAlign:'left'}}><ShieldCheck size={16}/> Invitations are single-use, expire after 7 days, and never grant access to a different account.</div>{!token&&<p className="form-error" role="alert">This invitation link is missing its token.</p>}{error&&<p className="form-error" role="alert">{error}</p>}<button className="primary full" disabled={!token||busy} onClick={()=>void accept()}>{busy?'Accepting…':'Accept invitation'}</button><p className="auth-toggle"><button onClick={signIn}>Sign in to the invited account</button></p></>}</div></main>
}
