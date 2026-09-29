'use client';
import {Suspense,useState} from 'react';
import {useSearchParams} from 'next/navigation';
import Link from 'next/link';
function Reset(){const token=useSearchParams().get('token');const [password,setPassword]=useState('');const [message,setMessage]=useState('');return <main className="auth-shell"><div className="auth-card"><h1>Choose a new password</h1>{message?<p role="status">{message}</p>:<form onSubmit={async e=>{e.preventDefault();const response=await fetch(`${process.env.NEXT_PUBLIC_API_URL??'http://localhost:4000'}/api/v1/auth/reset-password`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,password})});setMessage(response.ok?'Password changed. All previous sessions were revoked.':'This link is invalid or expired.')}}><label>New password<input type="password" minLength={12} required value={password} onChange={e=>setPassword(e.target.value)}/></label><button className="primary full" disabled={!token}>Reset password</button></form>}<p><Link href="/login">Back to sign in</Link></p></div></main>}
export default function Page(){return <Suspense><Reset/></Suspense>}
