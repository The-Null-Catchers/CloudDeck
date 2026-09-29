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
export function sendAgentCommand(serverId:string,action:AgentAction,payload:object={}):Promise<unknown> {
  const connection=active.get(serverId);
  if(!connection || connection.socket.readyState!==1)throw Object.assign(new Error('Agent not connected'),{statusCode:503});
  const requestId=randomUUID();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{connection.pending.delete(requestId);reject(Object.assign(new Error('Agent command timed out'),{statusCode:504}));},15_000);
    connection.pending.set(requestId,{resolve,reject,timer});
    connection.socket.send(JSON.stringify({type:'command',requestId,action,payload}),error=>{
      if(error){clearTimeout(timer);connection.pending.delete(requestId);reject(error);}
    });
  });
}
