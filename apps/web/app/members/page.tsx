'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import {Activity,ArrowLeft,Check,Clock3,Mail,RefreshCw,Shield,Trash2,UserPlus,Users} from 'lucide-react';
import {api} from '@/lib/api';

type Org={id:string;name:string;role:'owner'|'admin'|'operator'|'viewer'};
type Role='owner'|'admin'|'operator'|'viewer';
type Member={id:string;email:string;email_verified_at:string|null;role:Role;is_current:boolean};
type Invitation={id:string;email:string;role:'admin'|'operator'|'viewer';expires_at:string;accepted_at:string|null;revoked_at:string|null;created_at:string;invited_by_email:string|null};

const editableRoles=['admin','operator','viewer'] as const;
function inviteState(invite:Invitation){if(invite.accepted_at)return 'accepted';if(invite.revoked_at)return 'revoked';if(new Date(invite.expires_at).getTime()<Date.now())return 'expired';return 'pending'}

export default function MembersPage(){
  const router=useRouter();
  const [org,setOrg]=useState<Org|null>(null);
  const [members,setMembers]=useState<Member[]>([]);
  const [invites,setInvites]=useState<Invitation[]>([]);
  const [email,setEmail]=useState('');
  const [role,setRole]=useState<'admin'|'operator'|'viewer'>('viewer');
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const canManage=org?.role==='owner'||org?.role==='admin';

  async function load(){
    setLoading(true);setError('');
    try{
      const orgs=await api<{organizations:Org[]}>('/organizations');
      const selected=orgs.organizations[0];
      if(!selected)throw new Error('No workspace found');
      setOrg(selected);
      const memberData=await api<{members:Member[]}>(`/organizations/${selected.id}/members`);
      setMembers(memberData.members);
      if(selected.role==='owner'||selected.role==='admin'){
        const inviteData=await api<{invitations:Invitation[]}>(`/organizations/${selected.id}/invitations`);
        setInvites(inviteData.invitations);
      }else setInvites([]);
    }catch(e){setError(e instanceof Error?e.message:'Unable to load members')}
    finally{setLoading(false)}
  }
  useEffect(()=>{void load()},[]);

  async function invite(){
    if(!org||!email.trim())return;
    setBusy('invite');setError('');
    try{
      await api(`/organizations/${org.id}/invitations`,{method:'POST',body:JSON.stringify({email:email.trim(),role})});
      setEmail('');await load();
    }catch(e){setError(e instanceof Error?e.message:'Unable to send invitation')}
    finally{setBusy('')}
  }

  async function updateRole(member:Member,next:'admin'|'operator'|'viewer'){
    if(!org||member.role===next)return;
    setBusy(member.id);setError('');
    try{
      await api(`/organizations/${org.id}/members/${member.id}`,{method:'PATCH',body:JSON.stringify({role:next})});
      setMembers(items=>items.map(item=>item.id===member.id?{...item,role:next}:item));
    }catch(e){setError(e instanceof Error?e.message:'Unable to update member')}
    finally{setBusy('')}
  }

  async function removeMember(member:Member){
    if(!org||!confirm(`Remove ${member.email} from this workspace?`))return;
    setBusy(member.id);setError('');
    try{await api(`/organizations/${org.id}/members/${member.id}`,{method:'DELETE'});setMembers(items=>items.filter(item=>item.id!==member.id))}
    catch(e){setError(e instanceof Error?e.message:'Unable to remove member')}
    finally{setBusy('')}
  }

  async function revoke(invite:Invitation){
    if(!org)return;setBusy(invite.id);setError('');
    try{await api(`/organizations/${org.id}/invitations/${invite.id}`,{method:'DELETE'});await load()}
    catch(e){setError(e instanceof Error?e.message:'Unable to revoke invitation')}
    finally{setBusy('')}
  }

  const activeInvites=useMemo(()=>invites.filter(item=>inviteState(item)==='pending'),[invites]);

  return <div className="deploy-page ops-page">
    <header className="deploy-topbar"><button onClick={()=>router.push('/dashboard')}><ArrowLeft size={16}/> Dashboard</button><span><Activity size={18}/> clouddeck.</span><div>{org?.name??'Workspace'} · Members</div></header>
    <main className="deploy-content">
      <section className="deploy-hero"><div><span className="eyebrow">ORGANIZATION / MEMBERS</span><h1>Workspace access</h1><p>Invite teammates, assign least-privilege roles, and remove access when it is no longer needed.</p></div><div className="deploy-hero-actions"><button className="deploy-refresh" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/> Refresh</button></div></section>
      {error&&<div className="notice" role="status">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}
      <section className="deploy-stats"><div><Users size={18}/><span>Members</span><strong>{members.length}</strong></div><div><Mail size={18}/><span>Pending invites</span><strong>{activeInvites.length}</strong></div><div><Shield size={18}/><span>Your role</span><strong style={{fontSize:18,textTransform:'capitalize'}}>{org?.role??'—'}</strong></div></section>

      {canManage&&<section className="deploy-section"><div className="deploy-section-head"><div><h2>Invite teammate</h2><p>Invitations expire after 7 days and can only be accepted by the invited email address.</p></div></div><div style={{display:'grid',gridTemplateColumns:'minmax(220px,1fr) 160px auto',gap:12,padding:18}}><input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="teammate@example.com" aria-label="Invite email"/><select value={role} onChange={e=>setRole(e.target.value as typeof role)} aria-label="Invite role"><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option></select><button className="primary" onClick={()=>void invite()} disabled={busy==='invite'||!email.trim()}><UserPlus size={15}/>{busy==='invite'?'Sending…':'Send invite'}</button></div></section>}

      <section className="deploy-section"><div className="deploy-section-head"><div><h2>Current members</h2><p>Owners are protected from removal or demotion in this screen.</p></div></div><div className="alert-list">{members.map(member=><article className="alert-row" key={member.id}><span className="alert-icon"><Users size={18}/></span><div className="alert-copy"><div><strong>{member.email}</strong>{member.is_current&&<span className="health-state healthy">you</span>}</div><p>{member.email_verified_at?'Verified account':'Email verification pending'}</p></div><div className="alert-actions">{canManage&&member.role!=='owner'?<select value={member.role} disabled={busy===member.id} onChange={e=>void updateRole(member,e.target.value as 'admin'|'operator'|'viewer')}>{editableRoles.map(item=><option key={item} value={item}>{item}</option>)}</select>:<span className="health-state healthy" style={{textTransform:'capitalize'}}>{member.role}</span>}{canManage&&member.role!=='owner'&&<button onClick={()=>void removeMember(member)} disabled={busy===member.id}><Trash2 size={14}/> Remove</button>}</div></article>)}{!members.length&&!loading&&<div className="deployment-empty">No members found.</div>}</div></section>

      {canManage&&<section className="deploy-section"><div className="deploy-section-head"><div><h2>Invitation history</h2><p>Pending, accepted, revoked, and expired invitations.</p></div></div><div className="alert-list">{invites.map(invite=>{const state=inviteState(invite);return <article className="alert-row" key={invite.id}><span className="alert-icon">{state==='accepted'?<Check size={18}/>:<Clock3 size={18}/>}</span><div className="alert-copy"><div><strong>{invite.email}</strong><span className={`health-state ${state==='accepted'?'healthy':state==='pending'?'pending':'resolved'}`}>{state}</span></div><p>{invite.role} · invited by {invite.invited_by_email??'workspace administrator'}</p><small>Expires {new Date(invite.expires_at).toLocaleString()}</small></div><div className="alert-actions">{state==='pending'&&<button onClick={()=>void revoke(invite)} disabled={busy===invite.id}>Revoke</button>}</div></article>})}{!invites.length&&!loading&&<div className="deployment-empty">No invitations yet.</div>}</div></section>}
    </main>
  </div>
}
