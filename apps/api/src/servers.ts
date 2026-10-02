import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, transaction } from './db.js';
import { authenticate, membership, audit, randomToken, digest } from './security.js';
import {queryServerMetrics} from './metrics-retention.js';
const id = z.uuid();
const create = z.object({organizationId:id,name:z.string().trim().min(1).max(100),provider:z.string().max(80).optional(),region:z.string().max(80).optional(),tags:z.array(z.string().max(40)).max(20).default([])});
const metricQuery = z.object({range:z.enum(['1h','6h','24h','7d','30d']).default('24h')});
export async function serverRoutes(app: FastifyInstance) {
  app.get('/organizations', async request => {
    const {userId} = await authenticate(request);
    const result = await pool.query('SELECT o.id,o.name,o.personal,m.role FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE m.user_id=$1 ORDER BY o.created_at', [userId]);
    return {organizations:result.rows};
  });
  app.post('/organizations', async (request,reply) => {
    const {userId} = await authenticate(request);
    const {name} = z.object({name:z.string().trim().min(1).max(100)}).parse(request.body);
    const result = await transaction(async client => {
      const org = await client.query('INSERT INTO organizations(name) VALUES($1) RETURNING id,name',[name]);
      await client.query('INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)',[org.rows[0].id,userId,'owner']);
      return org.rows[0];
    });
    await audit(result.id,userId,'organization.create','organization',result.id,request.ip);
    reply.code(201); return result;
  });
  app.get('/organizations/:orgId/dashboard', async request => {
    const {userId} = await authenticate(request);
    const {orgId} = z.object({orgId:id}).parse(request.params);
    await membership(userId,orgId,'server.read');
    const result = await pool.query(`SELECT count(*)::integer AS total, count(*) FILTER (WHERE status='online')::integer AS online, count(*) FILTER (WHERE status='offline')::integer AS offline FROM servers WHERE organization_id=$1`,[orgId]);
    const alerts = await pool.query(`SELECT count(*)::integer AS open FROM alerts WHERE organization_id=$1 AND state='open'`,[orgId]);
    return {...result.rows[0],openAlerts:alerts.rows[0].open};
  });
  app.get('/organizations/:orgId/servers', async request => {
    const {userId} = await authenticate(request);
    const {orgId} = z.object({orgId:id}).parse(request.params);
    await membership(userId,orgId,'server.read');
    const result = await pool.query(`SELECT s.id,s.name,s.hostname,s.status,s.last_seen_at AS "lastSeenAt",m.cpu_percent AS "cpuPercent",m.memory_percent AS "memoryPercent",m.disk_percent AS "diskPercent" FROM servers s LEFT JOIN LATERAL (SELECT cpu_percent,memory_percent,disk_percent FROM server_metrics WHERE server_id=s.id ORDER BY bucket_at DESC LIMIT 1) m ON true WHERE s.organization_id=$1 ORDER BY s.created_at DESC LIMIT 200`,[orgId]);
    return {servers:result.rows};
  });
  app.post('/servers', async (request,reply) => {
    const {userId} = await authenticate(request);
    const body = create.parse(request.body);
    await membership(userId,body.organizationId,'server.create');
    const pairing = randomToken();
    const server = await transaction(async client => {
      const result = await client.query('INSERT INTO servers(organization_id,name,provider,region,tags) VALUES($1,$2,$3,$4,$5) RETURNING id,name,status',[body.organizationId,body.name,body.provider ?? null,body.region ?? null,body.tags]);
      await client.query(`INSERT INTO server_agents(server_id,pairing_hash,pairing_expires_at) VALUES($1,$2,now()+interval '10 minutes')`,[result.rows[0].id,digest(pairing)]);
      return result.rows[0];
    });
    await audit(body.organizationId,userId,'server.create','server',server.id,request.ip);
    reply.code(201);
    return {...server,pairingToken:pairing,pairingExpiresIn:600};
  });
  app.get('/servers/:serverId', async request => {
    const {userId}=await authenticate(request);const {serverId}=z.object({serverId:id}).parse(request.params);
    const result=await pool.query('SELECT id,organization_id,name,hostname,provider,region,operating_system,architecture,agent_version,status,last_seen_at,tags FROM servers WHERE id=$1',[serverId]);
    if (!result.rowCount) throw Object.assign(new Error('Server not found'),{statusCode:404});
    await membership(userId,result.rows[0].organization_id,'server.read');return result.rows[0];
  });
  app.get('/servers/:serverId/metrics', async request => {
    const {userId} = await authenticate(request);
    const {serverId} = z.object({serverId:id}).parse(request.params);
    const {range} = metricQuery.parse(request.query);
    const server = await pool.query('SELECT organization_id FROM servers WHERE id=$1',[serverId]);
    if (!server.rowCount) throw Object.assign(new Error('Server not found'),{statusCode:404});
    await membership(userId,server.rows[0].organization_id,'metrics.read');
    return queryServerMetrics(serverId,range);
  });
  app.get('/notifications', async request => {
    const {userId}=await authenticate(request);const result=await pool.query('SELECT id,type,title,body,href,read_at,created_at,alert_id FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[userId]);return {notifications:result.rows};
  });
  app.post('/notifications/:notificationId/read', async request => {
    const {userId}=await authenticate(request);const {notificationId}=z.object({notificationId:id}).parse(request.params);
    await pool.query('UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2',[notificationId,userId]);return {ok:true};
  });
  app.get('/organizations/:orgId/audit', async request => {
    const {userId} = await authenticate(request);
    const {orgId} = z.object({orgId:id}).parse(request.params);
    await membership(userId,orgId,'audit.read');
    const rows = await pool.query('SELECT id,actor_id,action,resource_type,resource_id,created_at FROM audit_logs WHERE organization_id=$1 ORDER BY id DESC LIMIT 100',[orgId]);
    return {entries:rows.rows};
  });
}
