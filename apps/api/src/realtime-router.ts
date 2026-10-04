import {randomUUID} from 'node:crypto';
import {Redis} from 'ioredis';
import {z} from 'zod';
import {agentRouterInstanceId,resolveAgentOwnerInstance,sendAgentEnvelope} from './commands.js';

const controlPrefix='clouddeck:agent-realtime-control:';
const routePrefix='clouddeck:agent-realtime:';
const uuid=z.uuid();
const routeEnvelope=z.discriminatedUnion('type',[
  z.object({type:z.literal('stream.subscribe'),subscriptionId:uuid,source:z.enum(['docker','systemd']),target:z.string().min(1).max(255),tail:z.number().int().min(0).max(500)}).strict(),
  z.object({type:z.literal('stream.unsubscribe'),subscriptionId:uuid}).strict(),
  z.object({type:z.literal('terminal.open'),sessionId:uuid,cols:z.number().int().min(20).max(500),rows:z.number().int().min(5).max(200)}).strict(),
  z.object({type:z.literal('terminal.input'),sessionId:uuid,data:z.string().max(8192)}).strict(),
  z.object({type:z.literal('terminal.resize'),sessionId:uuid,cols:z.number().int().min(20).max(500),rows:z.number().int().min(5).max(200)}).strict(),
  z.object({type:z.literal('terminal.close'),sessionId:uuid}).strict()
]);
const controlMessage=z.object({
  type:z.literal('agent.realtime.control'),
  requestId:uuid,
  routeId:uuid,
  serverId:uuid,
  requireAck:z.boolean(),
  envelope:routeEnvelope
}).strict();
const ackMessage=z.object({type:z.literal('agent.realtime.ack'),requestId:uuid}).strict();
const streamData=z.object({
  type:z.literal('agent.realtime.stream'),
  serverId:uuid,
  subscriptionId:uuid,
  line:z.string().max(4000).optional(),
  error:z.string().max(200).optional(),
  done:z.boolean().optional()
}).strict();
const terminalData=z.discriminatedUnion('type',[
  z.object({type:z.literal('agent.realtime.terminal.data'),serverId:uuid,sessionId:uuid,data:z.string().max(8192)}).strict(),
  z.object({type:z.literal('agent.realtime.terminal.exit'),serverId:uuid,sessionId:uuid,exitCode:z.number().int().min(-1).max(255).optional(),error:z.string().max(200).optional()}).strict()
]);

type RouteMessage=z.infer<typeof streamData>|z.infer<typeof terminalData>;
type RouteHandler=(message:RouteMessage)=>void;
type PendingAck={routeId:string;resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
type RemoteRoute={routeId:string;expiresAt:number};
type OutboundRoute={routeId:string;ownerInstanceId:string};

const streamRouteTtlMs=2*60*60_000;
const terminalRouteTtlMs=35*60_000;
const routeSweepMs=60_000;
let publisher:Redis|null=null;
let subscriber:Redis|null=null;
let ready:Promise<boolean>|null=null;
let cleanupTimer:ReturnType<typeof setInterval>|null=null;
const handlers=new Map<string,RouteHandler>();
const pendingAcks=new Map<string,PendingAck>();
const remoteStreams=new Map<string,RemoteRoute>();
const remoteTerminals=new Map<string,RemoteRoute>();
const outboundStreams=new Map<string,OutboundRoute>();
const outboundTerminals=new Map<string,OutboundRoute>();

function redisUrl(){
  if(process.env.NODE_ENV==='test'&&process.env.CLOUDDECK_TEST_DISTRIBUTED_ROUTING!=='1')return null;
  const value=process.env.REDIS_URL?.trim();
  if(!value)return null;
  const parsed=new URL(value);
  if(parsed.protocol!=='redis:'&&parsed.protocol!=='rediss:')throw new Error('REDIS_URL must use redis:// or rediss://');
  return value;
}
function redisOptions(){return {maxRetriesPerRequest:1,enableOfflineQueue:false,connectTimeout:2000,lazyConnect:true} as const;}
function controlChannel(instanceId:string){return controlPrefix+instanceId;}
function routeChannel(routeId:string){return routePrefix+routeId;}
function streamKey(serverId:string,subscriptionId:string){return `${serverId}:${subscriptionId}`;}
function terminalKey(serverId:string,sessionId:string){return `${serverId}:${sessionId}`;}
function route(routeId:string,ttlMs:number):RemoteRoute{return {routeId,expiresAt:Date.now()+ttlMs};}
function cleanupStaleRoutes(now=Date.now()){
  for(const [key,value] of remoteStreams)if(value.expiresAt<=now)remoteStreams.delete(key);
  for(const [key,value] of remoteTerminals)if(value.expiresAt<=now)remoteTerminals.delete(key);
}
function ensureCleanupTimer(){
  if(cleanupTimer)return;
  cleanupTimer=setInterval(cleanupStaleRoutes,routeSweepMs);
  cleanupTimer.unref();
}
function rememberOutbound(serverId:string,routeId:string,envelope:z.infer<typeof routeEnvelope>,ownerInstanceId:string){
  if(envelope.type==='stream.subscribe')outboundStreams.set(streamKey(serverId,envelope.subscriptionId),{routeId,ownerInstanceId});
  else if(envelope.type==='stream.unsubscribe')outboundStreams.delete(streamKey(serverId,envelope.subscriptionId));
  else if(envelope.type==='terminal.open')outboundTerminals.set(terminalKey(serverId,envelope.sessionId),{routeId,ownerInstanceId});
  else if(envelope.type==='terminal.close')outboundTerminals.delete(terminalKey(serverId,envelope.sessionId));
}
function cachedOwner(serverId:string,envelope:z.infer<typeof routeEnvelope>){
  if(envelope.type==='stream.unsubscribe')return outboundStreams.get(streamKey(serverId,envelope.subscriptionId));
  if(envelope.type==='terminal.input'||envelope.type==='terminal.resize'||envelope.type==='terminal.close')return outboundTerminals.get(terminalKey(serverId,envelope.sessionId));
  return undefined;
}

async function handleControl(raw:string){
  cleanupStaleRoutes();
  let value:unknown;try{value=JSON.parse(raw);}catch{return;}
  const parsed=controlMessage.safeParse(value);if(!parsed.success)return;
  const {requestId,routeId,serverId,requireAck,envelope}=parsed.data;
  try{sendAgentEnvelope(serverId,envelope);}catch{return;}
  if(envelope.type==='stream.subscribe')remoteStreams.set(streamKey(serverId,envelope.subscriptionId),route(routeId,streamRouteTtlMs));
  else if(envelope.type==='stream.unsubscribe')remoteStreams.delete(streamKey(serverId,envelope.subscriptionId));
  else if(envelope.type==='terminal.open')remoteTerminals.set(terminalKey(serverId,envelope.sessionId),route(routeId,terminalRouteTtlMs));
  else if(envelope.type==='terminal.close')remoteTerminals.delete(terminalKey(serverId,envelope.sessionId));
  else if(envelope.type==='terminal.input'||envelope.type==='terminal.resize'){
    const key=terminalKey(serverId,envelope.sessionId);const existing=remoteTerminals.get(key);
    if(existing&&existing.routeId===routeId)existing.expiresAt=Date.now()+terminalRouteTtlMs;
  }
  if(requireAck)await publisher?.publish(routeChannel(routeId),JSON.stringify({type:'agent.realtime.ack',requestId}));
}

function handleRoute(channel:string,raw:string){
  if(!channel.startsWith(routePrefix))return;
  const routeId=channel.slice(routePrefix.length);
  let value:unknown;try{value=JSON.parse(raw);}catch{return;}
  const ack=ackMessage.safeParse(value);
  if(ack.success){
    const pending=pendingAcks.get(ack.data.requestId);
    if(pending&&pending.routeId===routeId){clearTimeout(pending.timer);pendingAcks.delete(ack.data.requestId);pending.resolve();}
    return;
  }
  const stream=streamData.safeParse(value);
  if(stream.success){handlers.get(routeId)?.(stream.data);return;}
  const terminal=terminalData.safeParse(value);
  if(terminal.success)handlers.get(routeId)?.(terminal.data);
}

async function ensureRouter(){
  if(ready)return ready;
  ready=(async()=>{
    const url=redisUrl();if(!url)return false;
    const pub=new Redis(url,redisOptions());const sub=new Redis(url,redisOptions());
    pub.on('error',()=>{});sub.on('error',()=>{});
    await Promise.all([pub.connect(),sub.connect()]);
    publisher=pub;subscriber=sub;
    const ownControlChannel=controlChannel(agentRouterInstanceId());
    sub.on('message',(channel,message)=>{if(channel===ownControlChannel)void handleControl(message);else handleRoute(channel,message);});
    await sub.subscribe(ownControlChannel);
    ensureCleanupTimer();
    return true;
  })().catch(error=>{
    ready=null;publisher?.disconnect();subscriber?.disconnect();publisher=null;subscriber=null;throw error;
  });
  return ready;
}

export function startRealtimeRouter(){void ensureRouter().catch(()=>{});}

export async function registerRealtimeRoute(routeId:string,handler:RouteHandler){
  uuid.parse(routeId);handlers.set(routeId,handler);
  if(await ensureRouter())await subscriber?.subscribe(routeChannel(routeId));
}
export async function unregisterRealtimeRoute(routeId:string){
  handlers.delete(routeId);
  for(const [key,value] of outboundStreams)if(value.routeId===routeId)outboundStreams.delete(key);
  for(const [key,value] of outboundTerminals)if(value.routeId===routeId)outboundTerminals.delete(key);
  if(subscriber)await subscriber.unsubscribe(routeChannel(routeId)).catch(()=>0);
}

export async function routeAgentRealtimeEnvelope(serverId:string,routeId:string,envelope:unknown){
  uuid.parse(serverId);uuid.parse(routeId);const parsed=routeEnvelope.parse(envelope);
  try{
    sendAgentEnvelope(serverId,parsed);
    rememberOutbound(serverId,routeId,parsed,agentRouterInstanceId());
    return 'local' as const;
  }catch(error){
    if(!(error instanceof Error)||!error.message.includes('Agent not connected'))throw error;
  }
  if(!await ensureRouter()||!publisher)throw Object.assign(new Error('Agent not connected'),{statusCode:503});
  const cached=cachedOwner(serverId,parsed);
  const owner=cached?.ownerInstanceId??await resolveAgentOwnerInstance(serverId);
  if(!owner||owner===agentRouterInstanceId())throw Object.assign(new Error('Agent not connected'),{statusCode:503});
  const requestId=randomUUID();
  const requireAck=parsed.type==='stream.subscribe'||parsed.type==='terminal.open';
  const message={type:'agent.realtime.control',requestId,routeId,serverId,requireAck,envelope:parsed};
  if(!requireAck){
    const count=await publisher.publish(controlChannel(owner),JSON.stringify(message));
    if(count<1)throw Object.assign(new Error('Agent route unavailable'),{statusCode:503});
    rememberOutbound(serverId,routeId,parsed,owner);
    return 'remote' as const;
  }
  return new Promise<'remote'>((resolve,reject)=>{
    const timer=setTimeout(()=>{pendingAcks.delete(requestId);reject(Object.assign(new Error('Agent route unavailable'),{statusCode:503}));},2500);
    pendingAcks.set(requestId,{routeId,resolve:()=>{rememberOutbound(serverId,routeId,parsed,owner);resolve('remote');},reject,timer});
    void publisher!.publish(controlChannel(owner),JSON.stringify(message)).then(count=>{
      if(count>0)return;
      clearTimeout(timer);pendingAcks.delete(requestId);reject(Object.assign(new Error('Agent route unavailable'),{statusCode:503}));
    }).catch(error=>{clearTimeout(timer);pendingAcks.delete(requestId);reject(error);});
  });
}

export function forwardRemoteStream(serverId:string,message:unknown){
  cleanupStaleRoutes();
  const parsed=z.object({type:z.literal('stream.data'),subscriptionId:uuid,line:z.string().max(4000).optional(),error:z.string().max(200).optional(),done:z.boolean().optional()}).strict().safeParse(message);
  if(!parsed.success)return false;
  const key=streamKey(serverId,parsed.data.subscriptionId);const remote=remoteStreams.get(key);if(!remote)return false;
  if(parsed.data.done||parsed.data.error)remoteStreams.delete(key);else remote.expiresAt=Date.now()+streamRouteTtlMs;
  const output={type:'agent.realtime.stream' as const,serverId,subscriptionId:parsed.data.subscriptionId,line:parsed.data.line,error:parsed.data.error,done:parsed.data.done};
  void ensureRouter().then(ok=>ok?publisher?.publish(routeChannel(remote.routeId),JSON.stringify(output)):undefined).catch(()=>{});
  return true;
}

export function forwardRemoteTerminal(serverId:string,message:unknown){
  cleanupStaleRoutes();
  const parsed=z.discriminatedUnion('type',[
    z.object({type:z.literal('terminal.data'),sessionId:uuid,data:z.string().max(8192)}).strict(),
    z.object({type:z.literal('terminal.exit'),sessionId:uuid,exitCode:z.number().int().min(-1).max(255).optional(),error:z.string().max(200).optional()}).strict()
  ]).safeParse(message);
  if(!parsed.success)return false;
  const key=terminalKey(serverId,parsed.data.sessionId);const remote=remoteTerminals.get(key);if(!remote)return false;
  if(parsed.data.type==='terminal.exit')remoteTerminals.delete(key);else remote.expiresAt=Date.now()+terminalRouteTtlMs;
  const output=parsed.data.type==='terminal.data'
    ?{type:'agent.realtime.terminal.data',serverId,sessionId:parsed.data.sessionId,data:parsed.data.data}
    :{type:'agent.realtime.terminal.exit',serverId,sessionId:parsed.data.sessionId,exitCode:parsed.data.exitCode,error:parsed.data.error};
  void ensureRouter().then(ok=>ok?publisher?.publish(routeChannel(remote.routeId),JSON.stringify(output)):undefined).catch(()=>{});
  return true;
}

export async function closeRealtimeRouter(){
  for(const pending of pendingAcks.values()){clearTimeout(pending.timer);pending.reject(new Error('Realtime router shutting down'));}
  pendingAcks.clear();handlers.clear();remoteStreams.clear();remoteTerminals.clear();outboundStreams.clear();outboundTerminals.clear();
  if(cleanupTimer){clearInterval(cleanupTimer);cleanupTimer=null;}
  const sub=subscriber;const pub=publisher;subscriber=null;publisher=null;ready=null;
  if(sub){try{await sub.quit();}catch{sub.disconnect();}}
  if(pub){try{await pub.quit();}catch{pub.disconnect();}}
}
