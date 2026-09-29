import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.js';
import {authenticate,membership,audit,digest,randomToken} from './security.js';
import {registerAgentTerminal,sendAgentEnvelope,unregisterAgentTerminal} from './commands.js';

const params=z.object({serverId:z.uuid()});
const dimensions=z.object({cols:z.number().int().min(40).max(300).default(120),rows:z.number().int().min(10).max(120).default(36)}).strict();
type Ticket={serverId:string;userId:string;organizationId:string;cols:number;rows:number;expiresAt:number;ip:string};
const tickets=new Map<string,Ticket>();
const userSessions=new Map<string,number>();

function cleanupTickets(){
  const now=Date.now();
  for(const [key,value] of tickets){if(value.expiresAt<=now)tickets.delete(key);}
}

export async function terminalRoutes(app:FastifyInstance){
  app.post('/servers/:serverId/terminal/ticket',async request=>{
    const {userId}=await authenticate(request);
    const {serverId}=params.parse(request.params);
    const {cols,rows}=dimensions.parse(request.body??{});
    const server=await pool.query('SELECT organization_id FROM servers WHERE id=$1',[serverId]);
    if(!server.rowCount)throw Object.assign(new Error('Server not found'),{statusCode:404});
    const organizationId=server.rows[0].organization_id as string;
    await membership(userId,organizationId,'terminal.open');
    if((userSessions.get(userId)??0)>=2)throw Object.assign(new Error('Terminal session limit reached'),{statusCode:429});
    cleanupTickets();
    const token=randomToken();
    tickets.set(digest(token),{serverId,userId,organizationId,cols,rows,expiresAt:Date.now()+30_000,ip:request.ip});
    await audit(organizationId,userId,'terminal.ticket.issued','server',serverId,request.ip,{cols,rows});
    return {ticket:token,expiresInSeconds:30};
  });

  app.get('/terminal/connect',{websocket:true},(socket,request)=>{
    const allowedOrigin=process.env.APP_ORIGIN??'http://localhost:3000';
    if(request.headers.origin!==allowedOrigin){socket.close(1008,'Origin denied');return;}
    cleanupTickets();
    const parsed=z.object({ticket:z.string().min(20)}).safeParse(request.query);
    if(!parsed.success){socket.close(1008,'Invalid ticket');return;}
    const key=digest(parsed.data.ticket);
    const ticket=tickets.get(key);
    tickets.delete(key);
    if(!ticket||ticket.expiresAt<=Date.now()){socket.close(1008,'Expired ticket');return;}
    if((userSessions.get(ticket.userId)??0)>=2){socket.close(1008,'Session limit reached');return;}

    const sessionId=randomUUID();
    userSessions.set(ticket.userId,(userSessions.get(ticket.userId)??0)+1);
    let closed=false;
    const closeSession=(reason:string)=>{
      if(closed)return;closed=true;
      clearTimeout(timeout);
      unregisterAgentTerminal(ticket.serverId,sessionId);
      try{sendAgentEnvelope(ticket.serverId,{type:'terminal.close',sessionId});}catch{void 0;}
      const remaining=Math.max(0,(userSessions.get(ticket.userId)??1)-1);
      if(remaining)userSessions.set(ticket.userId,remaining);else userSessions.delete(ticket.userId);
      void audit(ticket.organizationId,ticket.userId,'terminal.session.closed','server',ticket.serverId,ticket.ip,{sessionId,reason});
    };
    const timeout=setTimeout(()=>{closeSession('timeout');socket.close(1000,'Session expired');},30*60_000);

    try{
      registerAgentTerminal(ticket.serverId,sessionId,message=>{
        if(socket.readyState!==1)return;
        if(message.data)socket.send(JSON.stringify({type:'data',data:message.data}));
        if(message.error)socket.send(JSON.stringify({type:'error',message:message.error}));
        if(message.closed){
          socket.send(JSON.stringify({type:'exit',exitCode:message.exitCode??-1}));
          closeSession('agent-exit');
          socket.close(1000,'Terminal exited');
        }
      });
      sendAgentEnvelope(ticket.serverId,{type:'terminal.open',sessionId,cols:ticket.cols,rows:ticket.rows});
      socket.send(JSON.stringify({type:'ready',sessionId}));
      void audit(ticket.organizationId,ticket.userId,'terminal.session.opened','server',ticket.serverId,ticket.ip,{sessionId,cols:ticket.cols,rows:ticket.rows});
    }catch{
      closeSession('agent-unavailable');
      socket.close(1011,'Agent unavailable');
      return;
    }

    socket.on('message',raw=>{
      if(raw.length>8192){socket.close(1009,'Message too large');return;}
      let value:unknown;try{value=JSON.parse(raw.toString())}catch{socket.close(1007,'Invalid JSON');return;}
      const input=z.object({type:z.literal('input'),data:z.string().min(1).max(4096)}).safeParse(value);
      if(input.success){try{sendAgentEnvelope(ticket.serverId,{type:'terminal.input',sessionId,data:input.data.data})}catch{socket.close(1011,'Agent unavailable')}return;}
      const resize=z.object({type:z.literal('resize'),cols:z.number().int().min(40).max(300),rows:z.number().int().min(10).max(120)}).safeParse(value);
      if(resize.success){try{sendAgentEnvelope(ticket.serverId,{type:'terminal.resize',sessionId,cols:resize.data.cols,rows:resize.data.rows})}catch{socket.close(1011,'Agent unavailable')}return;}
      const close=z.object({type:z.literal('close')}).safeParse(value);
      if(close.success){closeSession('client-close');socket.close(1000,'Closed');return;}
      socket.close(1007,'Invalid terminal message');
    });
    socket.on('close',()=>closeSession('socket-close'));
    socket.on('error',()=>closeSession('socket-error'));
  });
}
