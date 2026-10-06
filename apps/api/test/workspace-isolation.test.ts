import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../src/index.ts';
import {pool} from '../src/db.ts';

test('workspace-scoped APIs reject authenticated users from other workspaces',async()=>{
  const app=buildApp();
  await app.ready();
  const suffix=crypto.randomUUID();
  const ownerAEmail=`isolation-a-${suffix}@example.com`;
  const ownerBEmail=`isolation-b-${suffix}@example.com`;
  const password='a secure workspace isolation passphrase 2026';

  const ownerA=await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{email:ownerAEmail,password}});
  const ownerB=await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{email:ownerBEmail,password}});
  assert.equal(ownerA.statusCode,201,ownerA.body);
  assert.equal(ownerB.statusCode,201,ownerB.body);

  const a=ownerA.json();
  const b=ownerB.json();
  const orgA=a.organizationId as string;
  const tokenA=a.accessToken as string;
  const tokenB=b.accessToken as string;

  const createServer=await app.inject({
    method:'POST',
    url:'/api/v1/servers',
    headers:{authorization:`Bearer ${tokenA}`},
    payload:{organizationId:orgA,name:'Private server'}
  });
  assert.equal(createServer.statusCode,201,createServer.body);
  const serverId=createServer.json().id as string;

  const forbiddenRequests=[
    {method:'GET',url:`/api/v1/organizations/${orgA}/servers`},
    {method:'GET',url:`/api/v1/organizations/${orgA}/members`},
    {method:'GET',url:`/api/v1/organizations/${orgA}/audit-logs`},
    {method:'GET',url:`/api/v1/organizations/${orgA}/metrics?range=1h`},
    {method:'GET',url:`/api/v1/organizations/${orgA}/docker/containers`},
    {method:'GET',url:`/api/v1/servers/${serverId}`},
    {method:'GET',url:`/api/v1/servers/${serverId}/metrics?range=1h`},
    {method:'POST',url:`/api/v1/organizations/${orgA}/invitations`,payload:{email:`intruder-${suffix}@example.com`,role:'viewer'}}
  ] as const;

  for(const request of forbiddenRequests){
    const response=await app.inject({
      method:request.method,
      url:request.url,
      headers:{authorization:`Bearer ${tokenB}`},
      ...(request.method==='POST'?{payload:request.payload}:{})
    });
    assert.equal(response.statusCode,403,`${request.method} ${request.url}: ${response.body}`);
  }

  const ownWorkspace=await app.inject({method:'GET',url:`/api/v1/organizations/${orgA}/servers`,headers:{authorization:`Bearer ${tokenA}`}});
  assert.equal(ownWorkspace.statusCode,200,ownWorkspace.body);
  assert.ok(ownWorkspace.json().servers.some((server:{id:string})=>server.id===serverId));

  await pool.query('DELETE FROM users WHERE email IN ($1,$2)',[ownerAEmail,ownerBEmail]);
  await app.close();
});
