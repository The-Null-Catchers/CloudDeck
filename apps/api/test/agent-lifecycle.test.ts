import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import WebSocket from 'ws';
import {closeAgentRouter, isAgentConnected} from '../src/commands.ts';
import {pool} from '../src/db.ts';
import {buildApp} from '../src/index.ts';
import {sweepOffline} from '../src/offline.ts';

test('a paired fixture agent resumes metrics and only the operator can restart its test service', {timeout: 20_000}, async t => {
  const app = buildApp();
  const suffix = crypto.randomUUID();
  const ownerEmail = `agent-owner-${suffix}@example.com`;
  const viewerEmail = `agent-viewer-${suffix}@example.com`;
  let agent: WebSocket | undefined;
  t.after(async () => {
    if (agent && agent.readyState !== agent.CLOSED) {
      const closed = once(agent, 'close', {signal: AbortSignal.timeout(3_000)});
      agent.terminate();
      await closed;
    }
    try {
      await app.close();
      await pool.query('DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email IN ($1,$2))', [ownerEmail, viewerEmail]);
      await pool.query('DELETE FROM users WHERE email IN ($1,$2)', [ownerEmail, viewerEmail]);
    } finally {
      await closeAgentRouter();
    }
  });

  const address = new URL(await app.listen({host: '127.0.0.1', port: 0}));
  address.protocol = 'ws:';
  const register = async (email: string) => {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: {email, password: 'synthetic agent lifecycle passphrase 2026'},
    });
    assert.equal(response.statusCode, 201);
    const {organizationId, accessToken} = response.json();
    return {organizationId, headers: {authorization: `Bearer ${accessToken}`}};
  };
  const owner = await register(ownerEmail);
  const viewer = await register(viewerEmail);
  await pool.query(`INSERT INTO organization_members(organization_id,user_id,role)
    SELECT $1,id,'viewer' FROM users WHERE email=$2`, [owner.organizationId, viewerEmail]);

  const created = await app.inject({
    method: 'POST', url: '/api/v1/servers', headers: owner.headers,
    payload: {organizationId: owner.organizationId, name: 'Synthetic lifecycle server'},
  });
  assert.equal(created.statusCode, 201);
  const {id: serverId, pairingToken} = created.json();
  const pair = () => app.inject({
    method: 'POST', url: '/api/v1/agent/pair', payload: {serverId, token: pairingToken},
  });
  const paired = await pair();
  assert.equal(paired.statusCode, 201);
  const {credential} = paired.json();
  assert.equal((await pair()).statusCode, 401);

  async function exchange(socket: WebSocket, frame: {type: string; [key: string]: unknown}) {
    const wait = new AbortController();
    const signal = AbortSignal.any([wait.signal, AbortSignal.timeout(3_000)]);
    try {
      const response = once(socket, 'message', {signal});
      const disconnected = once(socket, 'close', {signal}).then(([code, reason]) => {
        throw new Error(`Agent disconnected while sending ${frame.type}: ${code} ${reason}`);
      });
      socket.send(JSON.stringify(frame));
      const [data] = await Promise.race([response, disconnected]);
      assert.deepEqual(JSON.parse(data.toString()), {type: 'ack'});
    } finally {
      wait.abort();
    }
  }
  async function connect() {
    const socket = new WebSocket(new URL(`/api/v1/agent/connect/${serverId}`, address), {
      headers: {authorization: `Bearer ${credential}`},
    });
    agent = socket;
    await once(socket, 'open', {signal: AbortSignal.timeout(3_000)});
    await exchange(socket, {
      type: 'hello', hostname: 'synthetic-agent', operatingSystem: 'linux', architecture: 'amd64', agentVersion: 'test',
    });
    return socket;
  }
  const sample = {
    type: 'metrics', cpuPercent: 42, memoryPercent: 35, diskPercent: 12,
    load1: 0.5, networkRxBytes: 120, networkTxBytes: 100,
  };
  const getServer = async () => {
    const response = await app.inject({
      url: `/api/v1/organizations/${owner.organizationId}/servers`, headers: owner.headers,
    });
    assert.equal(response.statusCode, 200);
    return response.json().servers.find((server: {id: string}) => server.id === serverId);
  };

  const first = await connect();
  await exchange(first, sample);
  const started = await getServer();
  assert.equal(started.status, 'online');
  assert.equal(Number(started.cpuPercent), 42);

  const [serverSocket] = app.websocketServer.clients;
  const disconnected = once(serverSocket, 'close', {signal: AbortSignal.timeout(3_000)});
  first.close();
  await disconnected;
  assert.equal(isAgentConnected(serverId), false);
  // Simulate expiry of the heartbeat interval, then run the normal production sweep.
  await pool.query("UPDATE servers SET last_seen_at=now()-interval '91 seconds' WHERE id=$1", [serverId]);
  await sweepOffline();
  assert.equal((await getServer()).status, 'offline');

  const listAlerts = async () => {
    const response = await app.inject({
      url: `/api/v1/organizations/${owner.organizationId}/alerts?state=all`, headers: owner.headers,
    });
    assert.equal(response.statusCode, 200);
    return response.json().alerts.filter((alert: {server_id: string; kind: string}) =>
      alert.server_id === serverId && alert.kind === 'server.offline');
  };
  assert.deepEqual((await listAlerts()).map((alert: {state: string}) => alert.state), ['open']);

  const resumed = await connect();
  await exchange(resumed, {...sample, cpuPercent: 84});
  const server = await getServer();
  assert.equal(server.status, 'online');
  assert.ok(Number(server.cpuPercent) > 42);
  assert.deepEqual((await listAlerts()).map((alert: {state: string}) => alert.state), ['resolved']);

  const serviceName = 'clouddeck-fixture.service';
  const restart = (headers: {authorization: string}) => app.inject({
    method: 'POST', url: `/api/v1/servers/${serverId}/services/${serviceName}/action`,
    headers, payload: {action: 'restart', confirm: true},
  });
  const received: unknown[] = [];
  resumed.on('message', raw => {
    const command = JSON.parse(raw.toString());
    received.push(command);
    resumed.send(JSON.stringify({type: 'command.result', requestId: command.requestId, success: true, data: {ok: true}}));
  });
  assert.equal((await restart(viewer.headers)).statusCode, 403);
  assert.equal(received.length, 0);
  assert.equal((await restart(owner.headers)).statusCode, 200);
  assert.equal(received.length, 1);
  const [command] = received as {type: string; requestId: string; action: string; payload: object}[];
  assert.equal(command.type, 'command');
  assert.equal(command.action, 'systemd.restartService');
  assert.deepEqual(command.payload, {serviceName});

  const audit = await app.inject({
    url: `/api/v1/organizations/${owner.organizationId}/audit-logs?resourceType=service`, headers: owner.headers,
  });
  assert.equal(audit.statusCode, 200);
  assert.deepEqual(audit.json().auditLogs.map(({action, actor_email, resource_id}: {
    action: string; actor_email: string; resource_id: string;
  }) => [action, actor_email, resource_id]), [
    ['systemd.action.succeeded', ownerEmail, serviceName],
    ['systemd.action.requested', ownerEmail, serviceName],
  ]);
});
