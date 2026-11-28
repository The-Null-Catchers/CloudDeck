import assert from 'node:assert/strict';
import {test} from 'node:test';
import {api,refresh,setAccessToken} from '../lib/api.js';

test('parallel initial reads share one rotating refresh and retry after a transport failure',async t=>{
  const original=globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;setAccessToken(null);});
  setAccessToken(null);
  let refreshes=0;
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  globalThis.fetch=async(input,init)=>{
    if(String(input).endsWith('/auth/refresh')){
      refreshes++;
      await gate;
      return Response.json({accessToken:'test-access'});
    }
    assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer test-access');
    return Response.json({ok:true});
  };
  const requests=[api('/one'),api('/two'),api('/three')];
  assert.equal(refreshes,1);
  release();
  assert.deepEqual(await Promise.all(requests),[{ok:true},{ok:true},{ok:true}]);
  assert.equal(refreshes,1);
  setAccessToken(null);
  globalThis.fetch=async()=>{throw new Error('offline');};
  await assert.rejects(refresh(),/offline/);
  globalThis.fetch=async()=>Response.json({accessToken:'test-access'});
  assert.equal(await refresh(),true);
});

test('revoked refresh refuses protected requests',async t=>{
  const original=globalThis.fetch;
  t.after(()=>{globalThis.fetch=original;setAccessToken(null);});
  setAccessToken(null);
  let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({error:{message:'Session expired'}},{status:401});};
  await assert.rejects(api('/protected'),/Sign in required/);
  assert.equal(calls,1);
});
