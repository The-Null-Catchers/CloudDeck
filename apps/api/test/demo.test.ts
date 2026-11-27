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
