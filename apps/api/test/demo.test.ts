import assert from 'node:assert/strict';
import test from 'node:test';
import {pool} from '../src/db.js';
import {buildApp} from '../src/index.js';
import {sweepOffline} from '../src/offline.js';
import {demoMetricPoints} from '../src/demo.js';

test('demo workspace metrics generate a full day of quarter-hour samples',()=>{
  const points=demoMetricPoints(28,0);
  assert.equal(points.length,96);
  assert.equal(points[0]?.minutesAgo,1425);
  assert.equal(points.at(-1)?.minutesAgo,0);
});

test('demo workspace metrics stay within operational bounds',()=>{
  const points=demoMetricPoints(80,3);
  for(const point of points){
    assert.ok(point.cpu>=2);
    assert.ok(point.cpu<=92);
    assert.ok(point.memory>=10);
    assert.ok(point.memory<=94);
    assert.ok(point.disk<=89);
    assert.ok(point.load>=0.1);
  }
});

test('demo workspace metrics vary instead of returning static placeholder values',()=>{
  const points=demoMetricPoints(28,1);
  assert.ok(new Set(points.map(point=>point.cpu.toFixed(2))).size>20);
});


test('synthetic demo servers are excluded from the offline heartbeat sweep', async t => {
  const app = buildApp();
  const email = `demo-sweep-${crypto.randomUUID()}@example.com`;
  t.after(async () => {
    await app.close();
    await pool.query('DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email=$1)', [email]);
    await pool.query('DELETE FROM users WHERE email=$1', [email]);
  });

  const registered = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {email, password: 'synthetic demo sweep passphrase 2026'},
  });
  assert.equal(registered.statusCode, 201);
  const {accessToken} = registered.json();

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/demo/workspace',
    headers: {authorization: `Bearer ${accessToken}`},
    payload: {},
  });
  assert.equal(created.statusCode, 201);
  const organizationId = created.json().organization.id as string;

  await pool.query(
    "UPDATE servers SET last_seen_at=now()-interval '10 minutes' WHERE organization_id=$1 AND status='online'",
    [organizationId],
  );
  await sweepOffline();

  const servers = await pool.query(
    'SELECT status FROM servers WHERE organization_id=$1 ORDER BY name',
    [organizationId],
  );
  assert.equal(servers.rowCount, 4);
  assert.equal(servers.rows.filter(server => server.status === 'online').length, 3);
  assert.equal(servers.rows.filter(server => server.status === 'offline').length, 1);
});


test('synthetic workspaces reject direct owner host mutations before dispatch',async t=>{
  const app=buildApp();
  const email=`demo-readonly-${crypto.randomUUID()}@example.com`;
  t.after(async()=>{await app.close();await pool.query('DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email=$1)',[email]);await pool.query('DELETE FROM users WHERE email=$1',[email]);});
  const registered=await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{email,password:'synthetic readonly passphrase 2026'}});
  assert.equal(registered.statusCode,201);
  const headers={authorization:`Bearer ${registered.json().accessToken}`};
  const created=await app.inject({method:'POST',url:'/api/v1/demo/workspace',headers,payload:{}});
  assert.equal(created.statusCode,201);
  const orgId=created.json().organization.id as string;
  const fleet=await app.inject({method:'GET',url:`/api/v1/organizations/${orgId}/servers`,headers});
  assert.equal(fleet.statusCode,200);
  const serverId=fleet.json().servers[0].id;
  const requests=[
    {url:'/api/v1/servers',payload:{organizationId:orgId,name:'Must not pair a demo agent'}},
    {url:`/api/v1/servers/${serverId}/docker/containers/${'a'.repeat(64)}/action`,payload:{action:'restart',confirm:true}},
    {url:`/api/v1/servers/${serverId}/services/caddy.service/action`,payload:{action:'restart',confirm:true}},
    {url:`/api/v1/servers/${serverId}/terminal/ticket`,payload:{}},
  ];
  for(const request of requests){
    const denied=await app.inject({method:'POST',headers,...request});
    assert.equal(denied.statusCode,403,`${request.url}: ${denied.body}`);
    assert.match(denied.json().error.message,/read-only/);
  }
  const rows=await pool.query('SELECT count(*)::integer AS count FROM servers WHERE organization_id=$1',[orgId]);
  assert.equal(rows.rows[0].count,4);
  const operations=await pool.query("SELECT action FROM audit_logs WHERE organization_id=$1 AND (action LIKE 'docker.%' OR action LIKE 'systemd.%' OR action LIKE 'terminal.%')",[orgId]);
  assert.equal(operations.rowCount,0);
});


test('synthetic workspaces reject owner transfer even for their owner',async t=>{
  const app=buildApp();
  const ownerEmail=`demo-transfer-owner-${crypto.randomUUID()}@example.com`;
  const targetEmail=`demo-transfer-target-${crypto.randomUUID()}@example.com`;
  let organizationId:string|undefined;
  let targetId:string|undefined;
  t.after(async()=>{
    await app.close();
    if(organizationId&&targetId)await pool.query('DELETE FROM organization_members WHERE organization_id=$1 AND user_id=$2',[organizationId,targetId]);
    if(targetId)await pool.query('DELETE FROM users WHERE id=$1',[targetId]);
    await pool.query('DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email=$1)',[ownerEmail]);
    await pool.query('DELETE FROM users WHERE email=$1',[ownerEmail]);
  });
  const registered=await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{email:ownerEmail,password:'synthetic transfer owner passphrase 2026'}});
  assert.equal(registered.statusCode,201);
  const headers={authorization:`Bearer ${registered.json().accessToken}`};
  const created=await app.inject({method:'POST',url:'/api/v1/demo/workspace',headers,payload:{}});
  assert.equal(created.statusCode,201);
  organizationId=created.json().organization.id as string;
  const target=await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'test-only-unused-hash') RETURNING id",[targetEmail]);
  targetId=target.rows[0].id as string;
  await pool.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'admin')",[organizationId,targetId]);
  const response=await app.inject({
    method:'POST',
    url:`/api/v1/organizations/${organizationId}/owner-transfer`,
    headers,
    payload:{memberId:targetId,confirm:true}
  });
  assert.equal(response.statusCode,403,response.body);
  assert.match(response.json().error.message,/read-only/);
  const owner=await pool.query('SELECT id FROM users WHERE email=$1',[ownerEmail]);
  const roles=await pool.query('SELECT user_id,role FROM organization_members WHERE organization_id=$1',[organizationId]);
  assert.equal(roles.rows.find(row=>row.user_id===owner.rows[0].id)?.role,'owner');
  assert.equal(roles.rows.find(row=>row.user_id===targetId)?.role,'admin');
});
