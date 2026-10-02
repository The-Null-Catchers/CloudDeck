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
export type LoginResult=
  | {twoFactorRequired:false}
  | {twoFactorRequired:true;challengeToken:string;expiresIn:number};

export async function login(email:string,password:string):Promise<LoginResult> {
  const response=await fetch(`${base}/api/v1/auth/login`,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
  const body=await response.json();
  if (!response.ok && response.status!==202) throw new Error(body.error?.message ?? 'Login failed');
  if(response.status===202){
    return {twoFactorRequired:true,challengeToken:body.challengeToken,expiresIn:body.expiresIn};
  }
  accessToken=body.accessToken;
  return {twoFactorRequired:false};
}

export async function completeTwoFactorLogin(challengeToken:string,code:string){
  const response=await fetch(`${base}/api/v1/auth/2fa/complete`,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({challengeToken,code})});
  const body=await response.json();
  if(!response.ok)throw new Error(body.error?.message??'Two-factor verification failed');
  accessToken=body.accessToken;
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


export type TerminalStreamEvent=
  | {type:'ready';sessionId:string;timeoutSeconds:number}
  | {type:'data';data:string}
  | {type:'exit';exitCode?:number;error?:string};

export async function openTerminalSession(serverId:string,onEvent:(event:TerminalStreamEvent)=>void){
  const result=await api<{ticket:string;expiresInSeconds:number}>('/servers/'+serverId+'/terminal/ticket',{method:'POST'});
  const endpoint=new URL('/api/v1/terminal/connect',base);
  endpoint.protocol=endpoint.protocol==='https:'?'wss:':'ws:';
  endpoint.searchParams.set('ticket',result.ticket);
  const socket=new WebSocket(endpoint.toString());
  socket.onmessage=event=>{
    try{onEvent(JSON.parse(event.data) as TerminalStreamEvent)}
    catch{socket.close(1007,'Invalid terminal payload')}
  };
  return socket;
}


export type DeploymentLogRow={
  id:number;
  stage:'cloning'|'building'|'deploying'|'health-checking';
  stream:'system'|'build'|'stdout'|'stderr';
  line:string;
  createdAt?:string;
  created_at?:string;
};
export type DeploymentLogStreamEvent=
  | {type:'ready';deploymentId:string;afterId:number}
  | {type:'log';id:number;stage:DeploymentLogRow['stage'];stream:DeploymentLogRow['stream'];line:string;createdAt:string}
  | {type:'done';state:string;afterId:number};

export async function openDeploymentLogStream(
  deploymentId:string,
  afterId:number,
  onEvent:(event:DeploymentLogStreamEvent)=>void
){
  const ticket=await api<{ticket:string;afterId:number;expiresInSeconds:number}>(
    '/deployments/'+deploymentId+'/logs/ticket',
    {method:'POST',body:JSON.stringify({afterId})}
  );
  const endpoint=new URL('/api/v1/deployment-logs/stream',base);
  endpoint.protocol=endpoint.protocol==='https:'?'wss:':'ws:';
  endpoint.searchParams.set('ticket',ticket.ticket);
  endpoint.searchParams.set('afterId',String(afterId));
  const socket=new WebSocket(endpoint.toString());
  socket.onmessage=event=>{
    try{onEvent(JSON.parse(event.data) as DeploymentLogStreamEvent)}
    catch{socket.close(1007,'Invalid deployment log payload')}
  };
  return socket;
}
