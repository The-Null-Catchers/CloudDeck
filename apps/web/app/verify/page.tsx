'use client';
import {useEffect,useState} from 'react';
import {useSearchParams} from 'next/navigation';
import Link from 'next/link';
import {Suspense} from 'react';
function Verify(){const query=useSearchParams();const [message,setMessage]=useState('Verifying your email…');useEffect(()=>{const token=query.get('token');if(!token){setMessage('Missing verification token');return}fetch(`${process.env.NEXT_PUBLIC_API_URL??'http://localhost:4000'}/api/v1/auth/verify-email`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})}).then(r=>setMessage(r.ok?'Email verified. You can sign in now.':'Link is invalid or expired.')).catch(()=>setMessage('Unable to reach CloudDeck.'));},[query]);return <main className="auth-shell"><div className="auth-card"><h1>Email verification</h1><p>{message}</p><Link href="/login">Continue to sign in</Link></div></main>}
export default function Page(){return <Suspense><Verify/></Suspense>}
