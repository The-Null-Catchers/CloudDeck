const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
let accessToken: string | null = null;
export function setAccessToken(value:string|null) {accessToken=value;}
export async function refresh() {
  const response=await fetch(`${base}/api/v1/auth/refresh`,{method:'POST',credentials:'include'});
  if (!response.ok) return false;
  accessToken=(await response.json()).accessToken;
  return true;
}
export async function api<T>(path:string, init:RequestInit={}):Promise<T> {
  if (!accessToken && !await refresh()) throw new Error('Sign in required');
  let response=await fetch(`${base}/api/v1${path}`,{...init,credentials:'include',headers:{'Content-Type':'application/json',Authorization:`Bearer ${accessToken}`,...init.headers}});
  if (response.status===401 && await refresh()) response=await fetch(`${base}/api/v1${path}`,{...init,credentials:'include',headers:{'Content-Type':'application/json',Authorization:`Bearer ${accessToken}`,...init.headers}});
  if (!response.ok) throw new Error((await response.json()).error?.message ?? 'Request failed');
  return response.json();
}
export async function login(email:string,password:string) {
  const response=await fetch(`${base}/api/v1/auth/login`,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
  if (!response.ok) throw new Error((await response.json()).error?.message ?? 'Login failed');
  accessToken=(await response.json()).accessToken;
}
export async function register(email:string,password:string) {
  const response=await fetch(`${base}/api/v1/auth/register`,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
  if (!response.ok) throw new Error((await response.json()).error?.message ?? 'Registration failed');
  accessToken=(await response.json()).accessToken;
}

export type LogStreamEvent={type:'ready'|'log';subscriptionId:string;line?:string;error?:string;done?:boolean};
export async function openLogStream(serverId:string,source:'docker'|'systemd',target:string,onEvent:(event:LogStreamEvent)=>void,tail=100){
  const result=await api<{ticket:string;expiresInSeconds:number}>('/servers/'+serverId+'/logs/ticket',{method:'POST',body:JSON.stringify({source,target,tail})});
  const endpoint=new URL('/api/v1/logs/stream',base);
  endpoint.protocol=endpoint.protocol==='https:'?'wss:':'ws:';
  endpoint.searchParams.set('ticket',result.ticket);
  const socket=new WebSocket(endpoint.toString());
  socket.onmessage=event=>{
    try{onEvent(JSON.parse(event.data) as LogStreamEvent)}catch{socket.close(1007,'Invalid stream payload')}
  };
  return socket;
}
