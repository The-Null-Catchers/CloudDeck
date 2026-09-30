import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.js';
import {authenticate,membership,audit} from './security.js';
import {normalizeHealthTarget,type HealthKind} from './health-probe.js';

const uuid=z.uuid();
const kind=z.enum(['http','https','tcp']);
const baseFields={
  name:z.string().trim().min(1).max(100),
  serverId:uuid.nullable().optional(),
  kind,
  target:z.string().trim().min(3).max(2048),
  intervalSeconds:z.number().int().min(30).max(86400),
  timeoutSeconds:z.number().int().min(1).max(30),
  expectedStatus:z.number().int().min(100).max(599).nullable().optional(),
  failureThreshold:z.number().int().min(1).max(20).default(3),
  enabled:z.boolean().default(true)
};
const createBody=z.object(baseFields).strict();
const updateBody=z.object({
  name:baseFields.name.optional(),
  serverId:baseFields.serverId,
  kind:kind.optional(),
  target:baseFields.target.optional(),
  intervalSeconds:baseFields.intervalSeconds.optional(),
  timeoutSeconds:baseFields.timeoutSeconds.optional(),
  expectedStatus:baseFields.expectedStatus,
  failureThreshold:z.number().int().min(1).max(20).optional(),
  enabled:z.boolean().optional()
}).strict().refine(body=>Object.keys(body).length>0,'At least one field is required');
const resultQuery=z.object({limit:z.coerce.number().int().min(1).max(500).default(100)}).strict();

async function ensureServer(orgId:string,serverId:string|null|undefined){
  if(!serverId)return;
  const row=await pool.query('SELECT 1 FROM servers WHERE id=$1 AND organization_id=$2',[serverId,orgId]);
  if(!row.rowCount)throw Object.assign(new Error('Server not found in this workspace'),{statusCode:400});
}

function validatedTarget(checkKind:HealthKind,target:string,expectedStatus:number|null|undefined){
  if(checkKind==='tcp'&&expectedStatus!=null)throw Object.assign(new Error('TCP health checks cannot define an expected HTTP status'),{statusCode:400});
  return normalizeHealthTarget(checkKind,target);
}

export async function healthCheckRoutes(app:FastifyInstance){
  app.get('/organizations/:orgId/health-checks',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=z.object({orgId:uuid}).parse(request.params);
    await membership(userId,orgId,'health.read');
    const rows=await pool.query(
      `SELECT h.id,h.organization_id,h.server_id,h.name,h.kind,h.target,h.interval_seconds,h.timeout_seconds,
              h.expected_status,h.failure_threshold,h.enabled,h.next_check_at,h.last_checked_at,h.last_success_at,
              h.consecutive_failures,s.name AS server_name,
              latest.success AS last_success,latest.response_ms AS last_response_ms,latest.status_code AS last_status_code,latest.error AS last_error,
              alert.id AS alert_id,alert.state AS alert_state
       FROM health_checks h
       LEFT JOIN servers s ON s.id=h.server_id
       LEFT JOIN LATERAL (
         SELECT success,response_ms,status_code,error
         FROM health_check_results
         WHERE health_check_id=h.id
         ORDER BY checked_at DESC
         LIMIT 1
       ) latest ON true
       LEFT JOIN alerts alert ON alert.health_check_id=h.id AND alert.state IN ('open','acknowledged')
       WHERE h.organization_id=$1
       ORDER BY h.name ASC`,
      [orgId]
    );
    return {healthChecks:rows.rows};
  });

  app.post('/organizations/:orgId/health-checks',async (request,reply)=>{
    const {userId}=await authenticate(request);
    const {orgId}=z.object({orgId:uuid}).parse(request.params);
    const body=createBody.parse(request.body);
    await membership(userId,orgId,'health.manage');
    await ensureServer(orgId,body.serverId);
    if(body.timeoutSeconds>=body.intervalSeconds)throw Object.assign(new Error('Timeout must be shorter than the check interval'),{statusCode:400});
    const target=validatedTarget(body.kind,body.target,body.expectedStatus);
    const created=await pool.query(
      `INSERT INTO health_checks(
         organization_id,server_id,name,kind,target,interval_seconds,timeout_seconds,expected_status,failure_threshold,enabled,next_check_at
       )
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       RETURNING *`,
      [orgId,body.serverId??null,body.name,body.kind,target,body.intervalSeconds,body.timeoutSeconds,body.expectedStatus??null,body.failureThreshold,body.enabled]
    );
    await audit(orgId,userId,'health_check.create','health_check',created.rows[0].id,request.ip,{kind:body.kind,target});
    reply.code(201);
    return created.rows[0];
  });

  app.patch('/health-checks/:healthCheckId',async request=>{
    const {userId}=await authenticate(request);
    const {healthCheckId}=z.object({healthCheckId:uuid}).parse(request.params);
    const body=updateBody.parse(request.body);
    const current=await pool.query('SELECT * FROM health_checks WHERE id=$1',[healthCheckId]);
    if(!current.rowCount)throw Object.assign(new Error('Health check not found'),{statusCode:404});
    const row=current.rows[0];
    await membership(userId,row.organization_id,'health.manage');
    const merged={
      name:body.name??row.name,
      serverId:body.serverId===undefined?row.server_id:body.serverId,
      kind:(body.kind??row.kind) as HealthKind,
      target:body.target??row.target,
      intervalSeconds:body.intervalSeconds??row.interval_seconds,
      timeoutSeconds:body.timeoutSeconds??row.timeout_seconds,
      expectedStatus:body.expectedStatus===undefined?row.expected_status:body.expectedStatus,
      failureThreshold:body.failureThreshold??row.failure_threshold,
      enabled:body.enabled??row.enabled
    };
    await ensureServer(row.organization_id,merged.serverId);
    if(merged.timeoutSeconds>=merged.intervalSeconds)throw Object.assign(new Error('Timeout must be shorter than the check interval'),{statusCode:400});
    const target=validatedTarget(merged.kind,merged.target,merged.expectedStatus);
    const updated=await pool.query(
      `UPDATE health_checks
       SET name=$2,server_id=$3,kind=$4,target=$5,interval_seconds=$6,timeout_seconds=$7,
           expected_status=$8,failure_threshold=$9,enabled=$10,
           next_check_at=CASE WHEN $10 THEN LEAST(next_check_at,now()) ELSE next_check_at END
       WHERE id=$1
       RETURNING *`,
      [healthCheckId,merged.name,merged.serverId??null,merged.kind,target,merged.intervalSeconds,merged.timeoutSeconds,merged.expectedStatus??null,merged.failureThreshold,merged.enabled]
    );
    await audit(row.organization_id,userId,'health_check.update','health_check',healthCheckId,request.ip,{enabled:merged.enabled});
    return updated.rows[0];
  });

  app.delete('/health-checks/:healthCheckId',async request=>{
    const {userId}=await authenticate(request);
    const {healthCheckId}=z.object({healthCheckId:uuid}).parse(request.params);
    const current=await pool.query('SELECT organization_id,name FROM health_checks WHERE id=$1',[healthCheckId]);
    if(!current.rowCount)throw Object.assign(new Error('Health check not found'),{statusCode:404});
    await membership(userId,current.rows[0].organization_id,'health.manage');
    await pool.query('DELETE FROM health_checks WHERE id=$1',[healthCheckId]);
    await audit(current.rows[0].organization_id,userId,'health_check.delete','health_check',healthCheckId,request.ip,{name:current.rows[0].name});
    return {ok:true};
  });

  app.get('/health-checks/:healthCheckId/results',async request=>{
    const {userId}=await authenticate(request);
    const {healthCheckId}=z.object({healthCheckId:uuid}).parse(request.params);
    const {limit}=resultQuery.parse(request.query);
    const current=await pool.query('SELECT organization_id FROM health_checks WHERE id=$1',[healthCheckId]);
    if(!current.rowCount)throw Object.assign(new Error('Health check not found'),{statusCode:404});
    await membership(userId,current.rows[0].organization_id,'health.read');
    const rows=await pool.query(
      `SELECT id,checked_at,success,response_ms,status_code,error
       FROM health_check_results
       WHERE health_check_id=$1
       ORDER BY checked_at DESC
       LIMIT $2`,
      [healthCheckId,limit]
    );
    return {results:rows.rows};
  });
}
