import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../src/index.ts';
import {pool} from '../src/db.ts';

test('workspace container overview includes non-reporting servers without contacting an agent',async()=>{
  const app=buildApp();
  await app.ready();
  const suffix=crypto.randomUUID();
  const email=`containers-${suffix}@example.com`;
  const register=await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{email,password:'a secure containers passphrase 2026'}});
  assert.equal(register.statusCode,201,register.body);
  const {accessToken,organizationId}=register.json();
  const created=await app.inject({method:'POST',url:'/api/v1/servers',headers:{authorization:`Bearer ${accessToken}`},payload:{organizationId,name:'Pending Docker host'}});
  assert.equal(created.statusCode,201,created.body);

  const response=await app.inject({method:'GET',url:`/api/v1/organizations/${organizationId}/docker/containers`,headers:{authorization:`Bearer ${accessToken}`}});
  assert.equal(response.statusCode,200,response.body);
  const body=response.json();
  assert.deepEqual(body.containers,[]);
  assert.equal(body.servers.length,1);
  assert.equal(body.servers[0].name,'Pending Docker host');
  assert.equal(body.servers[0].status,'pending');
  assert.equal(body.servers[0].error,null);

  await pool.query('DELETE FROM users WHERE email=$1',[email]);
  await pool.query('DELETE FROM organizations WHERE id=$1',[organizationId]);
  await app.close();
});
