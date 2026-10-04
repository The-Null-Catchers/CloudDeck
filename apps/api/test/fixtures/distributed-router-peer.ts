import process from 'node:process';
import {randomUUID} from 'node:crypto';
import type WebSocket from 'ws';
import {attachAgent,closeAgentRouter,resolveAgentResult,sendAgentCommand} from '../../src/commands.ts';
import {closeRealtimeRouter,forwardRemoteStream,forwardRemoteTerminal,registerRealtimeRoute,routeAgentRealtimeEnvelope,unregisterRealtimeRoute} from '../../src/realtime-router.ts';

const role=process.env.CLOUDDECK_TEST_ROLE;
const serverId=process.env.CLOUDDECK_TEST_SERVER_ID;
if(!role||!serverId)throw new Error('Missing distributed router fixture environment');

async function shutdown(){
  await closeRealtimeRouter();
  await closeAgentRouter();
}

async function owner(){
  // Ensure this replica is subscribed to the realtime control channel before
  // advertising the Agent as ready to the integration coordinator.
  const bootstrapRoute=randomUUID();
  await registerRealtimeRoute(bootstrapRoute,()=>{});
  await unregisterRealtimeRoute(bootstrapRoute);

  const socket={
    readyState:1,
    send(value:string,done?:(error?:Error)=>void){
      const envelope=JSON.parse(value) as Record<string,unknown>;
      if(envelope.type==='command'&&typeof envelope.requestId==='string'){
        setImmediate(()=>resolveAgentResult(serverId,{type:'command.result',requestId:envelope.requestId,success:true,data:{handledBy:process.env.CLOUDDECK_INSTANCE_ID,action:envelope.action}}));
      }
      if(envelope.type==='stream.subscribe'&&typeof envelope.subscriptionId==='string'){
        const subscriptionId=envelope.subscriptionId;
        setImmediate(()=>forwardRemoteStream(serverId,{type:'stream.data',subscriptionId,line:'distributed-log-line'}));
      }
      if(envelope.type==='terminal.open'&&typeof envelope.sessionId==='string'){
        const sessionId=envelope.sessionId;
        setImmediate(()=>forwardRemoteTerminal(serverId,{type:'terminal.data',sessionId,data:'shell-ready'}));
      }
      if(envelope.type==='terminal.input'&&typeof envelope.sessionId==='string'&&typeof envelope.data==='string'){
        const sessionId=envelope.sessionId;
        const data=envelope.data;
        setImmediate(()=>forwardRemoteTerminal(serverId,{type:'terminal.data',sessionId,data:`echo:${data}`}));
      }
      if(envelope.type==='terminal.resize'&&typeof envelope.sessionId==='string'&&typeof envelope.cols==='number'&&typeof envelope.rows==='number'){
        const sessionId=envelope.sessionId;
        const cols=envelope.cols;
        const rows=envelope.rows;
        setImmediate(()=>forwardRemoteTerminal(serverId,{type:'terminal.data',sessionId,data:`resize:${cols}x${rows}`}));
      }
      done?.();
    },
    close(){this.readyState=3;}
  } as unknown as WebSocket;
  const attached=await attachAgent(serverId,socket);
  process.stdout.write(`READY:${attached}\n`);
  const stop=async()=>{await shutdown();process.exit(0);};
  process.on('SIGTERM',()=>void stop());
  process.on('SIGINT',()=>void stop());
  setInterval(()=>{},60_000).unref();
}

async function requester(){
  const result=await sendAgentCommand(serverId,'docker.listContainers',{},5_000);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  await shutdown();
}

async function realtimeRequester(){
  const routeId=randomUUID();
  const subscriptionId=randomUUID();
  const sessionId=randomUUID();
  const received:string[]=[];
  let wake:()=>void=()=>{};
  await registerRealtimeRoute(routeId,message=>{
    if(message.type==='agent.realtime.stream'&&message.line)received.push(`log:${message.line}`);
    else if(message.type==='agent.realtime.terminal.data')received.push(`terminal:${message.data}`);
    wake();
  });
  const waitFor=(count:number)=>new Promise<void>((resolve,reject)=>{
    if(received.length>=count){resolve();return;}
    const timer=setTimeout(()=>reject(new Error(`Timed out waiting for realtime data: ${JSON.stringify(received)}`)),5_000);
    wake=()=>{if(received.length>=count){clearTimeout(timer);wake=()=>{};resolve();}};
  });

  await routeAgentRealtimeEnvelope(serverId,routeId,{type:'stream.subscribe',subscriptionId,source:'docker',target:'container123',tail:10});
  await waitFor(1);
  await routeAgentRealtimeEnvelope(serverId,routeId,{type:'terminal.open',sessionId,cols:80,rows:24});
  await waitFor(2);
  await routeAgentRealtimeEnvelope(serverId,routeId,{type:'terminal.input',sessionId,data:'whoami\n'});
  await waitFor(3);
  await routeAgentRealtimeEnvelope(serverId,routeId,{type:'terminal.resize',sessionId,cols:120,rows:40});
  await waitFor(4);
  await routeAgentRealtimeEnvelope(serverId,routeId,{type:'stream.unsubscribe',subscriptionId});
  await routeAgentRealtimeEnvelope(serverId,routeId,{type:'terminal.close',sessionId});

  process.stdout.write(`${JSON.stringify({received})}\n`);
  await unregisterRealtimeRoute(routeId);
  await shutdown();
}

async function duplicate(){
  const socket={readyState:1,send(){},close(){this.readyState=3;}} as unknown as WebSocket;
  const attached=await attachAgent(serverId,socket);
  process.stdout.write(`ATTACHED:${attached}\n`);
  await shutdown();
}

if(role==='owner')await owner();
else if(role==='requester')await requester();
else if(role==='realtime-requester')await realtimeRequester();
else if(role==='duplicate')await duplicate();
else throw new Error(`Unknown role: ${role}`);
