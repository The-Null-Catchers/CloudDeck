import {test} from 'node:test';
import assert from 'node:assert/strict';
import type WebSocket from 'ws';
import {attachAgent,detachAgent,resolveAgentResult,sendAgentCommand,containerId,registerAgentStream,resolveAgentStream,unregisterAgentStream,registerDeploymentLogHandler,resolveDeploymentLog,unregisterDeploymentLogHandler} from '../src/commands.ts';
test('commands are scoped to the active agent and correlated by request ID',async()=>{
  const serverId=crypto.randomUUID();let sent='';
  const socket={readyState:1,send(value:string,done:(error?:Error)=>void){sent=value;done();}} as WebSocket;
  assert.equal(await attachAgent(serverId,socket),true);
  assert.equal(await attachAgent(serverId,socket),false);
  const pending=sendAgentCommand(serverId,'docker.listContainers');
  const envelope=JSON.parse(sent);
  assert.equal(envelope.action,'docker.listContainers');
  assert.equal(resolveAgentResult(serverId,{type:'command.result',requestId:crypto.randomUUID(),success:true,data:[]}),false);
  assert.equal(resolveAgentResult(serverId,{type:'command.result',requestId:envelope.requestId,success:true,data:[]}),true);
  assert.deepEqual(await pending,[]);
  detachAgent(serverId,socket);
  await assert.rejects(()=>sendAgentCommand(serverId,'docker.listContainers'),/Agent not connected/);
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


test('deployment log envelopes are strict and routed by deployment ID',async()=>{
  const deploymentId=crypto.randomUUID();
  const received:string[]=[];
  registerDeploymentLogHandler(deploymentId,message=>{received.push(message.line)});
  assert.equal(resolveDeploymentLog({
    type:'deployment.log',
    deploymentId,
    stage:'building',
    stream:'build',
    line:'Step 1/4'
  }),true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(received,['Step 1/4']);
  assert.equal(resolveDeploymentLog({
    type:'deployment.log',
    deploymentId,
    stage:'building',
    stream:'build',
    line:'x'.repeat(4001)
  }),false);
  unregisterDeploymentLogHandler(deploymentId);
  assert.equal(resolveDeploymentLog({
    type:'deployment.log',
    deploymentId,
    stage:'deploying',
    stream:'system',
    line:'late but valid'
  }),true);
});
