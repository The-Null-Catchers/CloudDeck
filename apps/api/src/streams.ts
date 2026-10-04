import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.js';
import {authenticate,membership,audit,digest,randomToken} from './security.js';
import {containerId,registerAgentStream,unregisterAgentStream} from './commands.js';
import {registerRealtimeRoute,routeAgentRealtimeEnvelope,unregisterRealtimeRoute} from './realtime-router.js';

const params=z.object({serverId:z.uuid()});
const serviceName=z.string().regex(/^[A-Za-z0-9@_.:-]+\.service$/);
const ticketRequest=z.discriminatedUnion('source',[
  z.object({source:z.literal('docker'),target:containerId,tail:z.number().int().min(0).max(500).default(100)}).strict(),
  z.object({source:z.literal('systemd'),target:serviceName,tail:z.number().int().min(0).max(500).default(100)}).strict()
]);
type Ticket={serverId:string;source:'docker'|'systemd';target:string;tail:number;userId:string;organizationId:string;expiresAt:number};
const tickets=new Map<string,Ticket>();

function cleanupTickets(){
  const now=Date.now();
  for(const [key,value] of tickets){if(value.expiresAt<=now)tickets.delete(key);}
}

export async function streamRoutes(app:FastifyInstance){
  app.post('/servers/:serverId/logs/ticket',async request=>{
    const {userId}=await authenticate(request);
    const {serverId}=params.parse(request.params);
    const body=ticketRequest.parse(request.body);
    const server=await pool.query('SELECT organization_id FROM servers WHERE id=$1',[serverId]);
    if(!server.rowCount)throw Object.assign(new Error('Server not found'),{statusCode:404});
    const organizationId=server.rows[0].organization_id as string;
    await membership(userId,organizationId,'server.read');
    cleanupTickets();
    const token=randomToken();
    tickets.set(digest(token),{serverId,source:body.source,target:body.target,tail:body.tail,userId,organizationId,expiresAt:Date.now()+30_000});
    await audit(organizationId,userId,'logs.stream.ticket','server',serverId,request.ip,{source:body.source,target:body.target});
    return {ticket:token,expiresInSeconds:30};
  });

  app.get('/logs/stream',{websocket:true},(socket,request)=>{
    cleanupTickets();
    const parsed=z.object({ticket:z.string().min(20)}).safeParse(request.query);
    if(!parsed.success){socket.close(1008,'Invalid ticket');return;}
    const key=digest(parsed.data.ticket);
    const ticket=tickets.get(key);
    tickets.delete(key);
    if(!ticket || ticket.expiresAt<=Date.now()){socket.close(1008,'Expired ticket');return;}
    const subscriptionId=randomUUID();
    let closed=false;
    const deliver=(message:{line?:string;error?:string;done?:boolean})=>{
      if(socket.readyState!==1)return;
      socket.send(JSON.stringify({type:'log',subscriptionId,line:message.line,error:message.error,done:message.done}));
      if(message.done||message.error)void closeStream();
    };
    const closeStream=async()=>{
      if(closed)return;closed=true;
      unregisterAgentStream(ticket.serverId,subscriptionId);
      await routeAgentRealtimeEnvelope(ticket.serverId,subscriptionId,{type:'stream.unsubscribe',subscriptionId}).catch(()=>{});
      await unregisterRealtimeRoute(subscriptionId).catch(()=>{});
    };
    registerAgentStream(ticket.serverId,subscriptionId,deliver);
    socket.on('close',()=>{void closeStream();});
    socket.on('error',()=>{void closeStream();});
    void (async()=>{
      try{
        await registerRealtimeRoute(subscriptionId,message=>{
          if(message.type!=='agent.realtime.stream'||message.serverId!==ticket.serverId||message.subscriptionId!==subscriptionId)return;
          deliver(message);
        });
        await routeAgentRealtimeEnvelope(ticket.serverId,subscriptionId,{type:'stream.subscribe',subscriptionId,source:ticket.source,target:ticket.target,tail:ticket.tail});
        if(socket.readyState===1)socket.send(JSON.stringify({type:'ready',subscriptionId}));
      }catch{
        unregisterAgentStream(ticket.serverId,subscriptionId);
        await unregisterRealtimeRoute(subscriptionId).catch(()=>{});
        socket.close(1011,'Agent unavailable');
      }
    })();
  });
}
