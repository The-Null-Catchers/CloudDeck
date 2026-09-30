'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import {
  Activity,ArrowLeft,Bell,Check,CheckCircle2,Clock3,RefreshCw,ShieldAlert,TriangleAlert
} from 'lucide-react';
import {api} from '@/lib/api';

type NotificationRow={
  id:string;type:string;title:string;read_at:string|null;created_at:string;alert_id:string|null;
};

function when(value:string){return new Date(value).toLocaleString()}
function iconFor(type:string){
  if(type.includes('critical')||type.includes('failed'))return <TriangleAlert size={18}/>;
  if(type.includes('security'))return <ShieldAlert size={18}/>;
  return <Bell size={18}/>;
}

export default function NotificationsPage(){
  const router=useRouter();
  const [items,setItems]=useState<NotificationRow[]>([]);
  const [filter,setFilter]=useState<'all'|'unread'>('all');
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState('');

  async function load(silent=false){
    if(!silent)setLoading(true);
    try{
      const data=await api<{notifications:NotificationRow[]}>('/notifications');
      setItems(data.notifications);setError('');
    }catch(e){setError(e instanceof Error?e.message:'Unable to load notifications')}
    finally{if(!silent)setLoading(false)}
  }

  useEffect(()=>{void load();const timer=setInterval(()=>void load(true),15000);return()=>clearInterval(timer)},[]);

  async function markRead(id:string){
    setBusy(id);
    try{
      await api(`/notifications/${id}/read`,{method:'POST'});
      setItems(rows=>rows.map(row=>row.id===id?{...row,read_at:new Date().toISOString()}:row));
    }catch(e){setError(e instanceof Error?e.message:'Unable to mark notification read')}
    finally{setBusy(null)}
  }

  const visible=useMemo(()=>filter==='all'?items:items.filter(item=>!item.read_at),[items,filter]);
  const unread=items.filter(item=>!item.read_at).length;

  return <div className="deploy-page ops-page">
    <header className="deploy-topbar">
      <button onClick={()=>router.push('/dashboard')}><ArrowLeft size={16}/> Dashboard</button>
      <span><Activity size={18}/> clouddeck.</span>
      <div>Notification center</div>
    </header>

    <main className="deploy-content">
      <section className="deploy-hero">
        <div><span className="eyebrow">WORKSPACE / NOTIFICATIONS</span><h1>Stay on top of changes</h1><p>Operational events, incident updates, deployment notices, and security activity in one place.</p></div>
        <div className="deploy-hero-actions"><button className="deploy-refresh" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/> Refresh</button></div>
      </section>

      {error&&<div className="notice" role="status">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}

      <section className="deploy-stats notification-stats">
        <div><Bell size={18}/><span>Total</span><strong>{items.length}</strong></div>
        <div><TriangleAlert size={18}/><span>Unread</span><strong>{unread}</strong></div>
        <div><CheckCircle2 size={18}/><span>Read</span><strong>{items.length-unread}</strong></div>
      </section>

      <section className="deploy-section">
        <div className="deploy-section-head alert-head">
          <div><h2>Notifications</h2><p>Newest activity appears first.</p></div>
          <div className="alert-filters">
            {(['all','unread'] as const).map(value=><button key={value} className={filter===value?'active':''} onClick={()=>setFilter(value)}>{value}</button>)}
          </div>
        </div>

        <div className="notification-list">
          {visible.map(item=><article className={`notification-row ${item.read_at?'read':'unread'}`} key={item.id}>
            <span className="notification-icon">{iconFor(item.type)}</span>
            <div className="notification-copy">
              <div><strong>{item.title}</strong>{!item.read_at&&<span>NEW</span>}</div>
              <p>{item.type.replaceAll('_',' ').replaceAll('.',' ')}</p>
              <small><Clock3 size={12}/>{when(item.created_at)}</small>
            </div>
            <div className="notification-actions">
              {item.alert_id&&<button onClick={()=>router.push('/alerts')}>Open alert</button>}
              {!item.read_at&&<button className="primary" onClick={()=>void markRead(item.id)} disabled={busy===item.id}><Check size={14}/>{busy===item.id?'Saving…':'Mark read'}</button>}
            </div>
          </article>)}
          {!visible.length&&!loading&&<div className="deployment-empty">No notifications here.</div>}
        </div>
      </section>
    </main>
  </div>
}
