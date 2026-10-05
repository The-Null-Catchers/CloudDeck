import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.js';
import {authenticate,membership} from './security.js';

const paramsSchema=z.object({orgId:z.uuid()});
const querySchema=z.object({
  limit:z.coerce.number().int().min(1).max(200).default(100),
  beforeId:z.coerce.number().int().positive().optional(),
  action:z.string().trim().min(1).max(120).optional(),
  resourceType:z.string().trim().min(1).max(80).optional()
}).strict();
const sensitiveKey=/(password|passphrase|token|secret|credential|authorization|cookie|private.?key|value)/i;

export function sanitizeAuditMetadata(value:unknown,depth=0):unknown{
  if(depth>4)return '[truncated]';
  if(Array.isArray(value))return value.slice(0,50).map(item=>sanitizeAuditMetadata(item,depth+1));
  if(value&&typeof value==='object'){
    return Object.fromEntries(Object.entries(value as Record<string,unknown>).slice(0,100).map(([key,item])=>[
      key,sensitiveKey.test(key)?'[redacted]':sanitizeAuditMetadata(item,depth+1)
    ]));
  }
  if(typeof value==='string')return value.length>1000?`${value.slice(0,1000)}…`:value;
  return value;
}

export async function auditLogRoutes(app:FastifyInstance){
  app.get('/organizations/:orgId/audit-logs',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=paramsSchema.parse(request.params);
    const query=querySchema.parse(request.query);
    await membership(userId,orgId,'audit.read');

    const values:unknown[]=[orgId];
    const where=['a.organization_id=$1'];
    if(query.beforeId){values.push(query.beforeId);where.push(`a.id < $${values.length}`)}
    if(query.action){values.push(query.action);where.push(`a.action=$${values.length}`)}
    if(query.resourceType){values.push(query.resourceType);where.push(`a.resource_type=$${values.length}`)}
    values.push(query.limit+1);

    const result=await pool.query(
      `SELECT a.id,a.action,a.resource_type,a.resource_id,a.ip::text AS ip,a.metadata,a.created_at,
              u.email AS actor_email
       FROM audit_logs a
       LEFT JOIN users u ON u.id=a.actor_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.id DESC
       LIMIT $${values.length}`,
      values
    );

    const hasMore=result.rows.length>query.limit;
    const rows=(hasMore?result.rows.slice(0,query.limit):result.rows).map(row=>({...row,metadata:sanitizeAuditMetadata(row.metadata)}));
    return {
      auditLogs:rows,
      nextBeforeId:hasMore?rows.at(-1)?.id??null:null
    };
  });
}
