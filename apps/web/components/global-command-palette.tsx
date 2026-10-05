'use client';
import {useEffect,useMemo,useRef,useState,type CSSProperties} from 'react';
import {useRouter} from 'next/navigation';
import {Search,Server,Boxes,Activity,Rocket,Globe2,Command} from 'lucide-react';
import {api} from '@/lib/api';

type Org={id:string;name:string};
type SearchResult={kind:'server'|'service'|'container'|'deployment'|'domain';id:string;title:string;subtitle:string|null;href:string};
const icons={server:Server,service:Activity,container:Boxes,deployment:Rocket,domain:Globe2} as const;
const s:Record<string,CSSProperties>={
  backdrop:{position:'fixed',inset:0,zIndex:200,background:'rgba(15,23,42,.55)',backdropFilter:'blur(3px)',display:'flex',justifyContent:'center',alignItems:'flex-start',padding:'12vh 18px 18px'},
  palette:{width:'min(680px,100%)',background:'#fff',border:'1px solid #dfe5ee',borderRadius:14,boxShadow:'0 28px 80px rgba(15,23,42,.28)',overflow:'hidden'},
  inputRow:{display:'flex',alignItems:'center',gap:12,padding:'16px 18px',borderBottom:'1px solid #e9edf3',color:'#8290a3'},
  input:{flex:1,border:0,outline:0,fontSize:15,color:'#15243b',background:'transparent'},
  shortcut:{display:'flex',alignItems:'center',gap:4,border:'1px solid #e2e7ef',borderRadius:6,padding:'4px 7px',fontSize:11,color:'#8a96a8'},
  results:{maxHeight:'430px',overflowY:'auto',padding:8},
  empty:{padding:'34px 18px',textAlign:'center',color:'#8a96a8',fontSize:13},
  row:{width:'100%',border:0,background:'transparent',display:'flex',alignItems:'center',gap:12,textAlign:'left',padding:'11px 12px',borderRadius:9,color:'#15243b'},
  rowActive:{background:'#eef2ff'},
  icon:{display:'grid',placeItems:'center',width:34,height:34,borderRadius:8,background:'#f0f3fb',color:'#4e68d8',flex:'none'},
  labels:{display:'flex',flexDirection:'column',gap:3,flex:1,minWidth:0},
  title:{fontSize:12,fontWeight:700,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'},
  subtitle:{fontSize:11,color:'#8c98a8',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'},
  kind:{fontStyle:'normal',fontSize:9,textTransform:'uppercase',letterSpacing:'.7px',color:'#9da7b4'},
  footer:{display:'flex',gap:18,padding:'10px 18px',borderTop:'1px solid #e9edf3',fontSize:10,color:'#9aa5b3'}
};

export function GlobalCommandPalette(){
  const router=useRouter();
  const inputRef=useRef<HTMLInputElement>(null);
  const [open,setOpen]=useState(false);
  const [query,setQuery]=useState('');
  const [orgId,setOrgId]=useState<string|null>(null);
  const [results,setResults]=useState<SearchResult[]>([]);
  const [loading,setLoading]=useState(false);
  const [selected,setSelected]=useState(0);

  useEffect(()=>{
    const openPalette=()=>setOpen(true);
    const onKey=(event:KeyboardEvent)=>{
      if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){
        event.preventDefault();setOpen(value=>!value);
      }else if(event.key==='Escape')setOpen(false);
    };
    window.addEventListener('keydown',onKey);
    window.addEventListener('clouddeck:open-search',openPalette);
    return()=>{window.removeEventListener('keydown',onKey);window.removeEventListener('clouddeck:open-search',openPalette)};
  },[]);

  useEffect(()=>{
    if(!open)return;
    inputRef.current?.focus();
    if(orgId)return;
    api<{organizations:Org[]}>('/organizations').then(data=>setOrgId(data.organizations[0]?.id??null)).catch(()=>setOrgId(null));
  },[open,orgId]);

  useEffect(()=>{
    if(!open||!orgId||query.trim().length<2){setResults([]);setSelected(0);return}
    const controller=new AbortController();
    const timer=window.setTimeout(async()=>{
      setLoading(true);
      try{
        const data=await api<{results:SearchResult[]}>(`/organizations/${orgId}/search?q=${encodeURIComponent(query.trim())}&limit=20`,{signal:controller.signal});
        setResults(data.results);setSelected(0);
      }catch(error){if((error as Error).name!=='AbortError')setResults([])}finally{setLoading(false)}
    },180);
    return()=>{controller.abort();window.clearTimeout(timer)};
  },[open,orgId,query]);

  const active=useMemo(()=>results[selected], [results,selected]);
  function go(result:SearchResult){setOpen(false);setQuery('');router.push(result.href)}
  function onInputKey(event:React.KeyboardEvent<HTMLInputElement>){
    if(event.key==='ArrowDown'){event.preventDefault();setSelected(value=>Math.min(value+1,results.length-1))}
    if(event.key==='ArrowUp'){event.preventDefault();setSelected(value=>Math.max(value-1,0))}
    if(event.key==='Enter'&&active){event.preventDefault();go(active)}
  }
  if(!open)return null;
  return <div style={s.backdrop} role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setOpen(false)}}>
    <div style={s.palette} role="dialog" aria-modal="true" aria-label="Global search">
      <div style={s.inputRow}><Search size={18}/><input ref={inputRef} style={s.input} value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={onInputKey} placeholder="Search servers, services, containers, deployments, domains…" aria-label="Global search query"/><span style={s.shortcut}><Command size={12}/> K</span></div>
      <div style={s.results}>
        {query.trim().length<2&&<div style={s.empty}>Type at least 2 characters to search this workspace.</div>}
        {query.trim().length>=2&&loading&&<div style={s.empty}>Searching…</div>}
        {query.trim().length>=2&&!loading&&!results.length&&<div style={s.empty}>No matching infrastructure found.</div>}
        {results.map((result,index)=>{const Icon=icons[result.kind];return <button key={`${result.kind}:${result.id}`} style={{...s.row,...(index===selected?s.rowActive:{})}} onMouseEnter={()=>setSelected(index)} onClick={()=>go(result)}><span style={s.icon}><Icon size={16}/></span><span style={s.labels}><strong style={s.title}>{result.title}</strong><small style={s.subtitle}>{result.subtitle??result.kind}</small></span><em style={s.kind}>{result.kind}</em></button>})}
      </div>
      <div style={s.footer}><span>↑↓ Navigate</span><span>Enter Open</span><span>Esc Close</span></div>
    </div>
  </div>;
}
