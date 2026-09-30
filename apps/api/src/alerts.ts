import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool,transaction} from './db.js';
import {authenticate,membership,audit} from './security.js';

const uuid=z.uuid();
const listQuery=z.object({
  state:z.enum(['open','acknowledged','resolved','all']).default('open'),
  limit:z.coerce.number().int().min(1).max(200).default(100)
}).strict();

export async function alertRoutes(app:FastifyInstance){
  app.get('/organizations/:orgId/alerts',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=z.object({orgId:uuid}).parse(request.params);
    const {state,limit}=listQuery.parse(request.query);
    await membership(userId,orgId,'alert.read');
    const rows=await pool.query(
      `SELECT a.id,a.organization_id,a.server_id,a.health_check_id,a.kind,a.state,a.created_at,a.resolved_at,
              h.name AS health_check_name,h.kind AS health_check_kind,h.target AS health_check_target,
              s.name AS server_name
       FROM alerts a
       LEFT JOIN health_checks h ON h.id=a.health_check_id
       LEFT JOIN servers s ON s.id=a.server_id
       WHERE a.organization_id=$1
         AND ($2='all' OR a.state=$2)
       ORDER BY CASE a.state WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,a.created_at DESC
       LIMIT $3`,
      [orgId,state,limit]
    );
    return {alerts:rows.rows};
  });

  app.post('/alerts/:alertId/acknowledge',async request=>{
    const {userId}=await authenticate(request);
    const {alertId}=z.object({alertId:uuid}).parse(request.params);
    const current=await pool.query('SELECT organization_id,state FROM alerts WHERE id=$1',[alertId]);
    if(!current.rowCount)throw Object.assign(new Error('Alert not found'),{statusCode:404});
    const row=current.rows[0];
    await membership(userId,row.organization_id,'alert.manage');
    if(row.state==='resolved')throw Object.assign(new Error('Resolved alerts cannot be acknowledged'),{statusCode:409});
    if(row.state==='acknowledged')return {id:alertId,state:'acknowledged'};
    const updated=await transaction(async db=>{
      const result=await db.query(
        `UPDATE alerts SET state='acknowledged' WHERE id=$1 AND state='open' RETURNING id,state`,
        [alertId]
      );
      await audit(row.organization_id,userId,'alert.acknowledge','alert',alertId,request.ip,{},db);
      return result.rows[0];
    });
    return updated;
  });
}
