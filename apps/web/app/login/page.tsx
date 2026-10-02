'use client';
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import Link from 'next/link';
import {Activity,ArrowLeft,ArrowRight,ShieldCheck} from 'lucide-react';
import {completeTwoFactorLogin,login,register} from '@/lib/api';

export default function Login(){
  const router=useRouter();
  const [mode,setMode]=useState<'login'|'register'>('login');
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [challenge,setChallenge]=useState('');
  const [code,setCode]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);

  function resetMode(next:'login'|'register'){
    setMode(next);setChallenge('');setCode('');setError('');
  }

  async function submit(e:React.FormEvent){
    e.preventDefault();setBusy(true);setError('');
    try{
      if(challenge){
        await completeTwoFactorLogin(challenge,code);
        router.push('/dashboard');
        return;
      }
      if(mode==='register'){
        await register(email,password);
        router.push('/dashboard');
        return;
      }
      const result=await login(email,password);
      if(result.twoFactorRequired){
        setChallenge(result.challengeToken);
        setCode('');
        return;
      }
      router.push('/dashboard');
    }catch(err){
      setError(err instanceof Error?err.message:'Try again');
    }finally{setBusy(false)}
  }

  return <main className="auth-shell"><div className="auth-card">
    <div className="brand"><span className="brand-icon"><Activity size={21}/></span>clouddeck<span className="brand-dot">.</span></div>
    <div className="eyebrow">YOUR INFRASTRUCTURE, IN FOCUS</div>
    <h1>{challenge?'Two-factor verification':mode==='login'?'Welcome back':'Create your workspace'}</h1>
    <p className="muted">{challenge?'Enter the 6-digit authenticator code or one unused recovery code.':'Keep your servers and operations in one place.'}</p>
    <form onSubmit={submit}>
      {!challenge&&<>
        <label>Email address<input type="email" autoComplete="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@company.com"/></label>
        <label>Password<input type="password" autoComplete={mode==='login'?'current-password':'new-password'} minLength={12} required value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 12 characters"/></label>
      </>}
      {challenge&&<label>Authenticator or recovery code<input autoFocus inputMode="numeric" autoComplete="one-time-code" minLength={6} maxLength={32} required value={code} onChange={e=>setCode(e.target.value)} placeholder="123456"/></label>}
      {error&&<p className="form-error" role="alert">{error}</p>}
      <button className="primary full" disabled={busy||Boolean(challenge&&!code.trim())}>{busy?'Please wait…':challenge?'Verify and sign in':mode==='login'?'Sign in':'Create account'} <ArrowRight size={16}/></button>
    </form>
    {challenge?<p className="auth-toggle"><button onClick={()=>{setChallenge('');setCode('');setError('')}}><ArrowLeft size={14}/> Back to password</button></p>:<>
      {mode==='login'&&<p className="auth-toggle"><Link href="/forgot-password">Forgot password?</Link></p>}
      <p className="auth-toggle">{mode==='login'?'New to CloudDeck?':'Already have an account?'} <button onClick={()=>resetMode(mode==='login'?'register':'login')}>{mode==='login'?'Create account':'Sign in'}</button></p>
    </>}
    <div className="auth-foot"><ShieldCheck size={15}/> Secured with encrypted sessions, optional TOTP, and role based access</div>
  </div></main>
}
