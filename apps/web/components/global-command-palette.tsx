'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {Search,Server,Boxes,Activity,Rocket,Globe2,Command} from 'lucide-react';
import {api} from '@/lib/api';

type Org={id:string;name:string};
type SearchResult={kind:'server'|'service'|'container'|'deployment'|'domain';id:string;title:string;subtitle:string|null;href:string};
const icons={server:Server,service:Activity,container:Boxes,deployment:Rocket,domain:Globe2} as const;

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
  return <div className="command-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setOpen(false)}}>
    <div className="command-palette" role="dialog" aria-modal="true" aria-label="Global search">
      <div className="command-input"><Search size={18}/><input ref={inputRef} value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={onInputKey} placeholder="Search servers, services, containers, deployments, domains…" aria-label="Global search query"/><span><Command size={12}/> K</span></div>
      <div className="command-results">
        {query.trim().length<2&&<div className="command-empty">Type at least 2 characters to search this workspace.</div>}
        {query.trim().length>=2&&loading&&<div className="command-empty">Searching…</div>}
        {query.trim().length>=2&&!loading&&!results.length&&<div className="command-empty">No matching infrastructure found.</div>}
        {results.map((result,index)=>{const Icon=icons[result.kind];return <button key={`${result.kind}:${result.id}`} className={index===selected?'active':''} onMouseEnter={()=>setSelected(index)} onClick={()=>go(result)}><span className="command-result-icon"><Icon size={16}/></span><span><strong>{result.title}</strong><small>{result.subtitle??result.kind}</small></span><em>{result.kind}</em></button>})}
      </div>
      <div className="command-footer"><span>↑↓ Navigate</span><span>Enter Open</span><span>Esc Close</span></div>
    </div>
  </div>;
}
