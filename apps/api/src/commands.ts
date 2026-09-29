import {randomUUID} from 'node:crypto';
import type WebSocket from 'ws';
import type {AgentAction} from '@clouddeck/shared';
import {z} from 'zod';

export const containerId = z.string().regex(/^[a-f0-9]{12,64}$/i,'Use a Docker container ID');
export const agentResult = z.discriminatedUnion('success',[
  z.object({type:z.literal('command.result'),requestId:z.uuid(),success:z.literal(true),data:z.unknown()}),
  z.object({type:z.literal('command.result'),requestId:z.uuid(),success:z.literal(false),error:z.string().max(200)})
]);
type Pending={resolve:(value:unknown)=>void;reject:(reason:Error)=>void;timer:ReturnType<typeof setTimeout>};
type Connection={socket:WebSocket;pending:Map<string,Pending>};
const active=new Map<string,Connection>();
export function attachAgent(serverId:string,socket:WebSocket):boolean {
  if(active.has(serverId)) return false;
  active.set(serverId,{socket,pending:new Map()});
  return true;
}
export function isAgentConnected(serverId:string){
  const connection=active.get(serverId);
  return Boolean(connection && connection.socket.readyState===1);
}
export function detachAgent(serverId:string,socket:WebSocket) {
  const connection=active.get(serverId);
  if(!connection || connection.socket!==socket)return;
  for(const entry of connection.pending.values()){clearTimeout(entry.timer);entry.reject(new Error('Agent disconnected'));}
  active.delete(serverId);
}
export function resolveAgentResult(serverId:string,message:unknown):boolean {
  const parsed=agentResult.safeParse(message);
  if(!parsed.success)return false;
  const entry=active.get(serverId)?.pending.get(parsed.data.requestId);
  if(!entry)return false;
  active.get(serverId)?.pending.delete(parsed.data.requestId);
  clearTimeout(entry.timer);
  if(parsed.data.success)entry.resolve(parsed.data.data);
  else entry.reject(new Error(parsed.data.error));
  return true;
}
export function sendAgentCommand(serverId:string,action:AgentAction,payload:object={},timeoutMs=15_000):Promise<unknown> {
  const connection=active.get(serverId);
  if(!connection || connection.socket.readyState!==1)throw Object.assign(new Error('Agent not connected'),{statusCode:503});
  const requestId=randomUUID();
  return new Promise((resolve,reject)=>{
    const timeout=Math.max(1_000,Math.min(30*60_000,Math.trunc(timeoutMs)));
    const timer=setTimeout(()=>{connection.pending.delete(requestId);reject(Object.assign(new Error('Agent command timed out'),{statusCode:504}));},timeout);
    connection.pending.set(requestId,{resolve,reject,timer});
    connection.socket.send(JSON.stringify({type:'command',requestId,action,payload}),error=>{
      if(error){clearTimeout(timer);connection.pending.delete(requestId);reject(error);}
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
