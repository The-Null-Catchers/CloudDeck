import {randomUUID} from 'node:crypto';
import type WebSocket from 'ws';
import type {AgentAction} from '@clouddeck/shared';
import {Redis} from 'ioredis';
import {z} from 'zod';

export const containerId = z.string().regex(/^[a-f0-9]{12,64}$/i,'Use a Docker container ID');
export const agentResult = z.discriminatedUnion('success',[
  z.object({type:z.literal('command.result'),requestId:z.uuid(),success:z.literal(true),data:z.unknown()}),
  z.object({type:z.literal('command.result'),requestId:z.uuid(),success:z.literal(false),error:z.string().max(200)})
]);
type Pending={resolve:(value:unknown)=>void;reject:(reason:Error)=>void;timer:ReturnType<typeof setTimeout>};
type Connection={socket:WebSocket;pending:Map<string,Pending>;leaseTimer?:ReturnType<typeof setInterval>};
const active=new Map<string,Connection>();

const instanceId=(process.env.CLOUDDECK_INSTANCE_ID?.trim()||randomUUID()).slice(0,128);
const agentOwnerTtlSeconds=120;
const agentOwnerRefreshMs=30_000;
let routerRedis:Redis|null=null;
let routerSubscriber:Redis|null=null;
let routerReady:Promise<boolean>|null=null;
const remotePending=new Map<string,Pending>();

const routedCommand=z.object({
  type:z.literal('agent.command'),
  originInstanceId:z.string().min(1).max(128),
  serverId:z.uuid(),
  requestId:z.uuid(),
  action:z.string().min(1).max(100),
  payload:z.record(z.string(),z.unknown()),
  timeoutMs:z.number().int().min(1000).max(30*60_000)
}).strict();
const routedReply=z.discriminatedUnion('success',[
  z.object({type:z.literal('agent.command.reply'),requestId:z.uuid(),success:z.literal(true),data:z.unknown()}).strict(),
  z.object({type:z.literal('agent.command.reply'),requestId:z.uuid(),success:z.literal(false),error:z.string().max(200)}).strict()
]);

function ownerKey(serverId:string){return `clouddeck:agent-owner:${serverId}`;}
function commandChannel(targetInstanceId:string){return `clouddeck:agent-command:${targetInstanceId}`;}
function replyChannel(targetInstanceId:string){return `clouddeck:agent-reply:${targetInstanceId}`;}
function boundedTimeout(timeoutMs:number){return Math.max(1_000,Math.min(30*60_000,Math.trunc(timeoutMs)));}
function distributedRedisUrl(){
  if(process.env.NODE_ENV==='test'&&process.env.CLOUDDECK_TEST_DISTRIBUTED_ROUTING!=='1')return null;
  const value=process.env.REDIS_URL?.trim();
  if(!value)return null;
  const parsed=new URL(value);
  if(parsed.protocol!=='redis:'&&parsed.protocol!=='rediss:')throw new Error('REDIS_URL must use redis:// or rediss://');
  return value;
}
function redisOptions(){return {maxRetriesPerRequest:1,enableOfflineQueue:false,connectTimeout:2000,lazyConnect:true} as const;}

async function ensureRouter():Promise<boolean>{
  if(routerReady)return routerReady;
  routerReady=(async()=>{
    const url=distributedRedisUrl();
    if(!url)return false;
    const publisher=new Redis(url,redisOptions());
    const subscriber=new Redis(url,redisOptions());
    publisher.on('error',()=>{});
    subscriber.on('error',()=>{});
    await Promise.all([publisher.connect(),subscriber.connect()]);
    routerRedis=publisher;
    routerSubscriber=subscriber;
    subscriber.on('message',(channel,message)=>{
      if(channel===commandChannel(instanceId))void handleRoutedCommand(message);
      else if(channel===replyChannel(instanceId))handleRoutedReply(message);
    });
    await subscriber.subscribe(commandChannel(instanceId),replyChannel(instanceId));
    return true;
  })().catch(error=>{
    routerReady=null;
    routerRedis?.disconnect();
    routerSubscriber?.disconnect();
    routerRedis=null;
    routerSubscriber=null;
    throw error;
  });
  return routerReady;
}

async function claimOwnerLease(serverId:string){
  if(!await ensureRouter())return true;
  const redis=routerRedis;
  if(!redis)throw new Error('Agent router unavailable');
  const claimed=await redis.set(ownerKey(serverId),instanceId,'EX',agentOwnerTtlSeconds,'NX');
  if(claimed==='OK')return true;
  const owner=await redis.get(ownerKey(serverId));
  if(owner!==instanceId)return false;
  await redis.expire(ownerKey(serverId),agentOwnerTtlSeconds);
  return true;
}

async function refreshOwnerLease(serverId:string){
  const redis=routerRedis;
  if(!redis)return;
  await redis.eval(
    `if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('expire',KEYS[1],ARGV[2]) else return 0 end`,
    1,ownerKey(serverId),instanceId,String(agentOwnerTtlSeconds)
  );
}

async function releaseOwnerLease(serverId:string){
  const redis=routerRedis;
  if(!redis)return;
  try{
    await redis.eval(
      `if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end`,
      1,ownerKey(serverId),instanceId
    );
  }catch{void 0;}
}

export async function attachAgent(serverId:string,socket:WebSocket):Promise<boolean> {
  if(active.has(serverId)) return false;
  if(!await claimOwnerLease(serverId))return false;
  if(active.has(serverId))return false;
  const connection:Connection={socket,pending:new Map()};
  if(routerRedis){
    connection.leaseTimer=setInterval(()=>void refreshOwnerLease(serverId).catch(()=>{}),agentOwnerRefreshMs);
    connection.leaseTimer.unref();
  }
  active.set(serverId,connection);
  return true;
}
export function isAgentConnected(serverId:string){
  const connection=active.get(serverId);
  return Boolean(connection && connection.socket.readyState===1);
}
export function detachAgent(serverId:string,socket:WebSocket) {
  const connection=active.get(serverId);
  if(!connection || connection.socket!==socket)return;
  if(connection.leaseTimer)clearInterval(connection.leaseTimer);
  for(const entry of connection.pending.values()){clearTimeout(entry.timer);entry.reject(new Error('Agent disconnected'));}
  active.delete(serverId);
  void releaseOwnerLease(serverId);
}
export function resolveAgentResult(serverId:string,message:unknown):boolean {
  const parsed=agentResult.safeParse(message);
  if(!parsed.success)return false;
  const connection=active.get(serverId);
  const entry=connection?.pending.get(parsed.data.requestId);
  if(!entry)return false;
  connection?.pending.delete(parsed.data.requestId);
  clearTimeout(entry.timer);
  if(parsed.data.success)entry.resolve(parsed.data.data);
  else entry.reject(new Error(parsed.data.error));
  return true;
}

function sendLocalAgentCommand(serverId:string,action:AgentAction,payload:object,timeoutMs:number,requestId:string=randomUUID()):Promise<unknown>{
  const connection=active.get(serverId);
  if(!connection || connection.socket.readyState!==1)throw Object.assign(new Error('Agent not connected'),{statusCode:503});
  return new Promise((resolve,reject)=>{
    const timeout=boundedTimeout(timeoutMs);
    const timer=setTimeout(()=>{connection.pending.delete(requestId);reject(Object.assign(new Error('Agent command timed out'),{statusCode:504}));},timeout);
    connection.pending.set(requestId,{resolve,reject,timer});
    connection.socket.send(JSON.stringify({type:'command',requestId,action,payload}),error=>{
      if(error){clearTimeout(timer);connection.pending.delete(requestId);reject(error);}
    });
  });
}

async function publishRoutedReply(originInstanceId:string,reply:unknown){
  if(!routerRedis)return;
  await routerRedis.publish(replyChannel(originInstanceId),JSON.stringify(reply));
}

async function handleRoutedCommand(raw:string){
  let value:unknown;
  try{value=JSON.parse(raw);}catch{return;}
  const parsed=routedCommand.safeParse(value);
  if(!parsed.success)return;
  const message=parsed.data;
  const connection=active.get(message.serverId);
  if(!connection||connection.socket.readyState!==1){
    await publishRoutedReply(message.originInstanceId,{type:'agent.command.reply',requestId:message.requestId,success:false,error:'Agent not connected'}).catch(()=>{});
    return;
  }
  try{
    const data=await sendLocalAgentCommand(message.serverId,message.action as AgentAction,message.payload,message.timeoutMs,message.requestId);
    await publishRoutedReply(message.originInstanceId,{type:'agent.command.reply',requestId:message.requestId,success:true,data});
  }catch(error){
    const text=error instanceof Error?error.message:'Agent command failed';
    await publishRoutedReply(message.originInstanceId,{type:'agent.command.reply',requestId:message.requestId,success:false,error:text.slice(0,200)}).catch(()=>{});
  }
}

function handleRoutedReply(raw:string){
  let value:unknown;
  try{value=JSON.parse(raw);}catch{return;}
  const parsed=routedReply.safeParse(value);
  if(!parsed.success)return;
  const entry=remotePending.get(parsed.data.requestId);
  if(!entry)return;
  remotePending.delete(parsed.data.requestId);
  clearTimeout(entry.timer);
  if(parsed.data.success)entry.resolve(parsed.data.data);
  else entry.reject(Object.assign(new Error(parsed.data.error),{statusCode:parsed.data.error==='Agent not connected'?503:502}));
}

export async function sendAgentCommand(serverId:string,action:AgentAction,payload:object={},timeoutMs=15_000):Promise<unknown> {
  if(isAgentConnected(serverId))return sendLocalAgentCommand(serverId,action,payload,timeoutMs);
  if(!await ensureRouter())throw Object.assign(new Error('Agent not connected'),{statusCode:503});
  const redis=routerRedis;
  if(!redis)throw Object.assign(new Error('Agent not connected'),{statusCode:503});
  const owner=await redis.get(ownerKey(serverId));
  if(!owner)throw Object.assign(new Error('Agent not connected'),{statusCode:503});
  if(owner===instanceId){
    await releaseOwnerLease(serverId);
    throw Object.assign(new Error('Agent not connected'),{statusCode:503});
  }
  const requestId=randomUUID();
  const timeout=boundedTimeout(timeoutMs);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{remotePending.delete(requestId);reject(Object.assign(new Error('Agent command timed out'),{statusCode:504}));},timeout);
    remotePending.set(requestId,{resolve,reject,timer});
    const envelope={type:'agent.command',originInstanceId:instanceId,serverId,requestId,action,payload,timeoutMs:timeout};
    void redis.publish(commandChannel(owner),JSON.stringify(envelope)).then(subscribers=>{
      if(subscribers>0)return;
      clearTimeout(timer);
      remotePending.delete(requestId);
      reject(Object.assign(new Error('Agent route unavailable'),{statusCode:503}));
    }).catch(error=>{
      clearTimeout(timer);
      remotePending.delete(requestId);
      reject(error);
    });
  });
}

type StreamHandler=(message:{subscriptionId:string;line?:string;error?:string;done?:boolean})=>void;
const streams=new Map<string,Map<string,StreamHandler>>();
export function sendAgentEnvelope(serverId:string,envelope:object){
  const connection=active.get(serverId);
  if(!connection || connection.socket.readyState!==1)throw Object.assign(new Error('Agent not connected'),{statusCode:503});
  connection.socket.send(JSON.stringify(envelope));
}
export function registerAgentStream(serverId:string,subscriptionId:string,handler:StreamHandler){
  let serverStreams=streams.get(serverId);if(!serverStreams){serverStreams=new Map();streams.set(serverId,serverStreams);}
  serverStreams.set(subscriptionId,handler);
}
export function unregisterAgentStream(serverId:string,subscriptionId:string){
  const serverStreams=streams.get(serverId);serverStreams?.delete(subscriptionId);if(serverStreams?.size===0)streams.delete(serverId);
}
export function resolveAgentStream(serverId:string,message:unknown):boolean{
  const parsed=z.object({type:z.literal('stream.data'),subscriptionId:z.uuid(),line:z.string().max(4000).optional(),error:z.string().max(200).optional(),done:z.boolean().optional()}).safeParse(message);
  if(!parsed.success)return false;
  const handler=streams.get(serverId)?.get(parsed.data.subscriptionId);if(!handler)return false;
  handler(parsed.data);if(parsed.data.done||parsed.data.error)unregisterAgentStream(serverId,parsed.data.subscriptionId);
  return true;
}


export type DeploymentProgressStage='cloning'|'building'|'deploying'|'health-checking';
type DeploymentProgressMessage={deploymentId:string;stage:DeploymentProgressStage;message?:string};
type DeploymentProgressHandler=(message:DeploymentProgressMessage)=>void|Promise<void>;
const deploymentProgressHandlers=new Map<string,DeploymentProgressHandler>();

export function registerDeploymentProgress(deploymentId:string,handler:DeploymentProgressHandler){
  if(deploymentProgressHandlers.has(deploymentId))throw new Error('Deployment progress handler already registered');
  deploymentProgressHandlers.set(deploymentId,handler);
}
export function unregisterDeploymentProgress(deploymentId:string){
  deploymentProgressHandlers.delete(deploymentId);
}
export function resolveDeploymentProgress(message:unknown):boolean{
  const parsed=z.object({
    type:z.literal('deployment.progress'),
    deploymentId:z.uuid(),
    stage:z.enum(['cloning','building','deploying','health-checking']),
    message:z.string().max(500).optional()
  }).strict().safeParse(message);
  if(!parsed.success)return false;
  const handler=deploymentProgressHandlers.get(parsed.data.deploymentId);
  if(!handler)return false;
  void Promise.resolve(handler(parsed.data)).catch(()=>{});
  return true;
}


export type DeploymentLogStage='cloning'|'building'|'deploying'|'health-checking';
export type DeploymentLogStream='system'|'build'|'stdout'|'stderr';
type DeploymentLogMessage={
  deploymentId:string;
  stage:DeploymentLogStage;
  stream:DeploymentLogStream;
  line:string;
};
type DeploymentLogHandler=(message:DeploymentLogMessage)=>void|Promise<void>;
const deploymentLogHandlers=new Map<string,DeploymentLogHandler>();

export function registerDeploymentLogHandler(deploymentId:string,handler:DeploymentLogHandler){
  if(deploymentLogHandlers.has(deploymentId))throw new Error('Deployment log handler already registered');
  deploymentLogHandlers.set(deploymentId,handler);
}
export function unregisterDeploymentLogHandler(deploymentId:string){
  deploymentLogHandlers.delete(deploymentId);
}
export function resolveDeploymentLog(message:unknown):boolean{
  const parsed=z.object({
    type:z.literal('deployment.log'),
    deploymentId:z.uuid(),
    stage:z.enum(['cloning','building','deploying','health-checking']),
    stream:z.enum(['system','build','stdout','stderr']),
    line:z.string().min(1).max(4000)
  }).strict().safeParse(message);
  if(!parsed.success)return false;
  const handler=deploymentLogHandlers.get(parsed.data.deploymentId);
  if(handler)void Promise.resolve(handler(parsed.data)).catch(()=>{});
  return true;
}

export async function closeAgentRouter(){
  for(const connection of active.values())if(connection.leaseTimer)clearInterval(connection.leaseTimer);
  for(const entry of remotePending.values()){clearTimeout(entry.timer);entry.reject(new Error('Agent router shutting down'));}
  remotePending.clear();
  const subscriber=routerSubscriber;
  const publisher=routerRedis;
  routerSubscriber=null;
  routerRedis=null;
  routerReady=null;
  if(subscriber){try{await subscriber.quit();}catch{subscriber.disconnect();}}
  if(publisher){try{await publisher.quit();}catch{publisher.disconnect();}}
}
