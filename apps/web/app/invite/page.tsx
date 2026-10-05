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

  return <div className="auth-page"><main className="auth-card" style={{maxWidth:520}}><div className="auth-brand"><span><Activity size={20}/></span>clouddeck.</div>{accepted?<><CheckCircle2 size={44}/><h1>Workspace joined</h1><p>Your CloudDeck account now has access to the invited workspace.</p><button className="primary" onClick={()=>router.push('/dashboard')}>Open dashboard <ArrowRight size={16}/></button></>:<><Mail size={42}/><h1>Workspace invitation</h1><p>Sign in with the exact email address that received this invitation, then accept it. The server verifies the account email before granting access.</p><div className="notice" style={{textAlign:'left'}}><ShieldCheck size={16}/> Invitations are single-use, expire after 7 days, and never grant access to a different account.</div>{!token&&<div className="notice" role="alert">This invitation link is missing its token.</div>}{error&&<div className="notice" role="alert">{error}</div>}<button className="primary" disabled={!token||busy} onClick={()=>void accept()}>{busy?'Accepting…':'Accept invitation'}</button><button onClick={()=>router.push('/login')}>Sign in to another account</button></>}</main></div>
}
