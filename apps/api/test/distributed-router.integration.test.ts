import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';

const redisUrl=process.env.REDIS_URL;

type PeerRole='owner'|'requester'|'realtime-requester'|'duplicate';
function peer(role:PeerRole,serverId:string,instanceId:string){
  return spawn(process.execPath,['--import','tsx','test/fixtures/distributed-router-peer.ts'],{
    cwd:new URL('..',import.meta.url),
    env:{
      ...process.env,
      NODE_ENV:'test',
      REDIS_URL:redisUrl,
      CLOUDDECK_TEST_DISTRIBUTED_ROUTING:'1',
      CLOUDDECK_TEST_ROLE:role,
      CLOUDDECK_TEST_SERVER_ID:serverId,
      CLOUDDECK_INSTANCE_ID:instanceId
    },
    stdio:['pipe','pipe','pipe']
  });
}

function waitForLine(child:ChildProcessWithoutNullStreams,prefix:string,timeoutMs=8_000):Promise<string>{
  return new Promise((resolve,reject)=>{
    let output='';
    let stderr='';
    const finish=(error?:Error,line?:string)=>{
      clearTimeout(timer);
      child.stdout.off('data',onData);
      child.stderr.off('data',onError);
      child.off('exit',onExit);
      if(error)reject(error);else resolve(line!);
    };
    const timer=setTimeout(()=>finish(new Error(`Timed out waiting for ${prefix}; stdout=${output}; stderr=${stderr}`)),timeoutMs);
    const onData=(chunk:Buffer)=>{
      output+=chunk.toString();
      const line=output.split(/\r?\n/).find(value=>value.startsWith(prefix));
      if(line)finish(undefined,line);
    };
    const onError=(chunk:Buffer)=>{stderr+=chunk.toString();};
    const onExit=(code:number|null)=>finish(new Error(`Peer exited before ${prefix} (code ${code}); stdout=${output}; stderr=${stderr}`));
    child.stdout.on('data',onData);
    child.stderr.on('data',onError);
    child.once('exit',onExit);
  });
}

async function waitForExit(child:ChildProcessWithoutNullStreams){
  if(child.exitCode!==null)return child.exitCode;
  const [code]=await once(child,'exit');
  return code as number|null;
}

async function stop(child:ChildProcessWithoutNullStreams){
  if(child.exitCode!==null)return;
  child.kill('SIGTERM');
  await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,3_000))]);
  if(child.exitCode===null)child.kill('SIGKILL');
}

test('routes commands to the owning API process and rejects duplicate ownership',{skip:!redisUrl,timeout:20_000},async()=>{
  const serverId=randomUUID();
  const owner=peer('owner',serverId,'integration-owner');
  try{
    assert.equal(await waitForLine(owner,'READY:'),'READY:true');

    const duplicate=peer('duplicate',serverId,'integration-duplicate');
    assert.equal(await waitForLine(duplicate,'ATTACHED:'),'ATTACHED:false');
    assert.equal(await waitForExit(duplicate),0);

    const requester=peer('requester',serverId,'integration-requester');
    const line=await waitForLine(requester,'{');
    const result=JSON.parse(line) as {handledBy:string;action:string};
    assert.equal(result.handledBy,'integration-owner');
    assert.equal(result.action,'docker.listContainers');
    assert.equal(await waitForExit(requester),0);
  }finally{
    await stop(owner);
  }
});

test('routes live logs and bidirectional terminal traffic across API processes',{skip:!redisUrl,timeout:25_000},async()=>{
  const serverId=randomUUID();
  const owner=peer('owner',serverId,'realtime-owner');
  try{
    assert.equal(await waitForLine(owner,'READY:'),'READY:true');
    const requester=peer('realtime-requester',serverId,'realtime-requester');
    const line=await waitForLine(requester,'{',12_000);
    const result=JSON.parse(line) as {received:string[]};
    assert.deepEqual(result.received,[
      'log:distributed-log-line',
      'terminal:shell-ready',
      'terminal:echo:whoami\n',
      'terminal:resize:120x40'
    ]);
    assert.equal(await waitForExit(requester),0);
  }finally{
    await stop(owner);
  }
});
