import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.js';
import {authenticate,membership,audit,digest,randomToken} from './security.js';
import {sendAgentEnvelope} from './commands.js';

const params=z.object({serverId:z.uuid()});
type Ticket={serverId:string;userId:string;organizationId:string;expiresAt:number};
type TerminalHandler=(message:{sessionId:string;data?:string;exitCode?:number;error?:string})=>void;
const tickets=new Map<string,Ticket>();
const terminals=new Map<string,TerminalHandler>();

function cleanupTickets(){
  const now=Date.now();
  for(const [key,value] of tickets){if(value.expiresAt<=now)tickets.delete(key);}
}

export function resolveAgentTerminal(serverId:string,message:unknown):boolean{
  const parsed=z.discriminatedUnion('type',[
    z.object({type:z.literal('terminal.data'),sessionId:z.uuid(),data:z.string().max(8192)}),
    z.object({type:z.literal('terminal.exit'),sessionId:z.uuid(),exitCode:z.number().int().min(-1).max(255).optional(),error:z.string().max(200).optional()})
  ]).safeParse(message);
  if(!parsed.success)return false;
  const handler=terminals.get(serverId+':'+parsed.data.sessionId);
  if(!handler)return false;
  handler(parsed.data);
  if(parsed.data.type==='terminal.exit')terminals.delete(serverId+':'+parsed.data.sessionId);
  return true;
}

export async function terminalRoutes(app:FastifyInstance){
  app.post('/servers/:serverId/terminal/ticket',async request=>{
    const {userId}=await authenticate(request);
    const {serverId}=params.parse(request.params);
    const server=await pool.query('SELECT organization_id FROM servers WHERE id=$1',[serverId]);
    if(!server.rowCount)throw Object.assign(new Error('Server not found'),{statusCode:404});
    const organizationId=server.rows[0].organization_id as string;
    await membership(userId,organizationId,'terminal.access');
    cleanupTickets();
    const token=randomToken();
    tickets.set(digest(token),{serverId,userId,organizationId,expiresAt:Date.now()+30_000});
    await audit(organizationId,userId,'terminal.ticket.created','server',serverId,request.ip);
    return {ticket:token,expiresInSeconds:30};
  });

  app.get('/terminal/connect',{websocket:true},(socket,request)=>{
    cleanupTickets();
    const parsed=z.object({ticket:z.string().min(20)}).safeParse(request.query);
    if(!parsed.success){socket.close(1008,'Invalid ticket');return;}
    const key=digest(parsed.data.ticket);
    const ticket=tickets.get(key);
    tickets.delete(key);
    if(!ticket||ticket.expiresAt<=Date.now()){socket.close(1008,'Expired ticket');return;}

    const sessionId=randomUUID();
    const terminalKey=ticket.serverId+':'+sessionId;
    let closed=false;
    let persisted=false;
    let pendingReason='client_closed';
    let timeout:ReturnType<typeof setTimeout>;
    const finish=async(reason:string)=>{
      if(closed)return;
      closed=true;
      pendingReason=reason;
      clearTimeout(timeout);
      terminals.delete(terminalKey);
      try{sendAgentEnvelope(ticket.serverId,{type:'terminal.close',sessionId});}catch{}
      if(persisted)await pool.query('UPDATE terminal_sessions SET ended_at=now(),close_reason=$2 WHERE id=$1 AND ended_at IS NULL',[sessionId,reason]).catch(()=>undefined);
      await audit(ticket.organizationId,ticket.userId,'terminal.session.closed','server',ticket.serverId,request.ip,{sessionId,reason}).catch(()=>undefined);
      if(socket.readyState===1)socket.close(1000,'Terminal closed');
    };
    timeout=setTimeout(()=>{void finish('timeout');},30*60_000);

    terminals.set(terminalKey,message=>{
      if(socket.readyState!==1)return;
      socket.send(JSON.stringify(message.data!==undefined?{type:'data',data:message.data}:{type:'exit',exitCode:message.exitCode,error:message.error}));
      if(message.data===undefined)void finish(message.error?'agent_error':'process_exit');
    });
    socket.on('close',()=>{void finish('client_closed');});
    socket.on('error',()=>{void finish('client_error');});
    socket.on('message',(raw:Buffer)=>{
      if(raw.length>8192){socket.close(1009,'Message too large');return;}
      let value:unknown;try{value=JSON.parse(raw.toString());}catch{socket.close(1007,'Invalid JSON');return;}
      const input=z.discriminatedUnion('type',[
        z.object({type:z.literal('input'),data:z.string().max(4096)}),
        z.object({type:z.literal('resize'),cols:z.number().int().min(20).max(500),rows:z.number().int().min(5).max(200)}),
        z.object({type:z.literal('close')})
      ]).safeParse(value);
      if(!input.success){socket.close(1007,'Invalid terminal message');return;}
      try{
        if(input.data.type==='input'){
          sendAgentEnvelope(ticket.serverId,{type:'terminal.input',sessionId,data:Buffer.from(input.data.data).toString('base64')});
        }else if(input.data.type==='resize'){
          sendAgentEnvelope(ticket.serverId,{type:'terminal.resize',sessionId,cols:input.data.cols,rows:input.data.rows});
        }else void finish('client_closed');
      }catch{void finish('agent_unavailable');}
    });

    void pool.query('INSERT INTO terminal_sessions(id,organization_id,server_id,user_id) VALUES($1,$2,$3,$4)',[sessionId,ticket.organizationId,ticket.serverId,ticket.userId])
      .then(async()=>{
        persisted=true;
        if(closed){
          await pool.query('UPDATE terminal_sessions SET ended_at=now(),close_reason=$2 WHERE id=$1 AND ended_at IS NULL',[sessionId,pendingReason]);
          return;
        }
        await audit(ticket.organizationId,ticket.userId,'terminal.session.opened','server',ticket.serverId,request.ip,{sessionId});
        sendAgentEnvelope(ticket.serverId,{type:'terminal.open',sessionId,cols:120,rows:36});
        socket.send(JSON.stringify({type:'ready',sessionId,timeoutSeconds:1800}));
      })
      .catch(async()=>{
        terminals.delete(terminalKey);
        if(persisted)await pool.query("UPDATE terminal_sessions SET ended_at=now(),close_reason='open_failed' WHERE id=$1 AND ended_at IS NULL",[sessionId]).catch(()=>undefined);
        socket.close(1011,'Terminal unavailable');
      });
  });
}
