import process from 'node:process';
import type WebSocket from 'ws';
import {attachAgent,closeAgentRouter,resolveAgentResult,sendAgentCommand} from '../../src/commands.ts';

const role=process.env.CLOUDDECK_TEST_ROLE;
const serverId=process.env.CLOUDDECK_TEST_SERVER_ID;
if(!role||!serverId)throw new Error('Missing distributed router fixture environment');

async function owner(){
  const socket={
    readyState:1,
    send(value:string,done?:(error?:Error)=>void){
      const envelope=JSON.parse(value) as {type?:string;requestId?:string;action?:string};
      if(envelope.type==='command'&&envelope.requestId){
        setImmediate(()=>resolveAgentResult(serverId,{type:'command.result',requestId:envelope.requestId,success:true,data:{handledBy:process.env.CLOUDDECK_INSTANCE_ID,action:envelope.action}}));
      }
      done?.();
    },
    close(){this.readyState=3;}
  } as unknown as WebSocket;
  const attached=await attachAgent(serverId,socket);
  process.stdout.write(`READY:${attached}\n`);
  const shutdown=async()=>{await closeAgentRouter();process.exit(0);};
  process.on('SIGTERM',()=>void shutdown());
  process.on('SIGINT',()=>void shutdown());
  setInterval(()=>{},60_000).unref();
}

async function requester(){
  const result=await sendAgentCommand(serverId,'docker.listContainers',{},5_000);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  await closeAgentRouter();
}

async function duplicate(){
  const socket={readyState:1,send(){},close(){this.readyState=3;}} as unknown as WebSocket;
  const attached=await attachAgent(serverId,socket);
  process.stdout.write(`ATTACHED:${attached}\n`);
  await closeAgentRouter();
}

if(role==='owner')await owner();
else if(role==='requester')await requester();
else if(role==='duplicate')await duplicate();
else throw new Error(`Unknown role: ${role}`);
