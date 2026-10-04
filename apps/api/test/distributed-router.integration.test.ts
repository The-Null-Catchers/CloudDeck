import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';

const redisUrl=process.env.REDIS_URL;

function peer(role:'owner'|'requester'|'duplicate',serverId:string,instanceId:string){
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
    const timer=setTimeout(()=>finish(new Error(`Timed out waiting for ${prefix}; stdout=${output}; stderr=${stderr}`)),timeoutMs);
    let stderr='';
    const onData=(chunk:Buffer)=>{
      output+=chunk.toString();
      const line=output.split(/\r?\n/).find(value=>value.startsWith(prefix));
      if(line)finish(undefined,line);
    };
    const onError=(chunk:Buffer)=>{stderr+=chunk.toString();};
    const onExit=(code:number|null)=>finish(new Error(`Peer exited before ${prefix} (code ${code}); stdout=${output}; stderr=${stderr}`));
    const finish=(error?:Error,line?:string)=>{
      clearTimeout(timer);
      child.stdout.off('data',onData);
      child.stderr.off('data',onError);
      child.off('exit',onExit);
      if(error)reject(error);else resolve(line!);
    };
    child.stdout.on('data',onData);
    child.stderr.on('data',onError);
    child.once('exit',onExit);
  });
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
    await once(duplicate,'exit');
    assert.equal(duplicate.exitCode,0);

    const requester=peer('requester',serverId,'integration-requester');
    const line=await waitForLine(requester,'{');
    const result=JSON.parse(line) as {handledBy:string;action:string};
    assert.equal(result.handledBy,'integration-owner');
    assert.equal(result.action,'docker.listContainers');
    await once(requester,'exit');
    assert.equal(requester.exitCode,0);
  }finally{
    await stop(owner);
  }
});
