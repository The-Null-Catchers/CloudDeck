import {test} from 'node:test';
import assert from 'node:assert/strict';
import type WebSocket from 'ws';
import {attachAgent,detachAgent,resolveAgentResult,sendAgentCommand,containerId,registerAgentStream,resolveAgentStream,unregisterAgentStream} from '../src/commands.ts';
test('commands are scoped to the active agent and correlated by request ID',async()=>{
  const serverId=crypto.randomUUID();let sent='';
  const socket={readyState:1,send(value:string,done:(error?:Error)=>void){sent=value;done();}} as WebSocket;
  assert.equal(attachAgent(serverId,socket),true);
  assert.equal(attachAgent(serverId,socket),false);
  const pending=sendAgentCommand(serverId,'docker.listContainers');
  const envelope=JSON.parse(sent);
  assert.equal(envelope.action,'docker.listContainers');
  assert.equal(resolveAgentResult(serverId,{type:'command.result',requestId:crypto.randomUUID(),success:true,data:[]}),false);
  assert.equal(resolveAgentResult(serverId,{type:'command.result',requestId:envelope.requestId,success:true,data:[]}),true);
  assert.deepEqual(await pending,[]);
  detachAgent(serverId,socket);
  assert.throws(()=>sendAgentCommand(serverId,'docker.listContainers'),/Agent not connected/);
});
test('container ID rejects names and path traversal',()=>{
  assert.equal(containerId.safeParse('../etc/passwd').success,false);
  assert.equal(containerId.safeParse('nginx').success,false);
  assert.equal(containerId.safeParse('a'.repeat(64)).success,true);
});

test('stream messages route only to registered subscriptions',()=>{
  const serverId=crypto.randomUUID();const subscriptionId=crypto.randomUUID();const received:string[]=[];
  registerAgentStream(serverId,subscriptionId,message=>{if(message.line)received.push(message.line)});
  assert.equal(resolveAgentStream(serverId,{type:'stream.data',subscriptionId,line:'hello'}),true);
  assert.deepEqual(received,['hello']);
  assert.equal(resolveAgentStream(serverId,{type:'stream.data',subscriptionId:crypto.randomUUID(),line:'ignored'}),false);
  unregisterAgentStream(serverId,subscriptionId);
  assert.equal(resolveAgentStream(serverId,{type:'stream.data',subscriptionId,line:'late'}),false);
});
