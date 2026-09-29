import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.js';
import {authenticate,membership,audit} from './security.js';
import {containerId,sendAgentCommand} from './commands.js';
const params=z.object({serverId:z.uuid()});
const restartParams=params.extend({containerId});
const containerSummary=z.object({id:containerId,name:z.string().max(200),image:z.string().max(300),state:z.string().max(32),status:z.string().max(200),ports:z.array(z.object({privatePort:z.number().int(),publicPort:z.number().int().optional(),type:z.string().max(12)})).max(100)});
async function authorizedServer(userId:string,serverId:string,permission:'server.read'|'server.action') {
  const server=await pool.query('SELECT organization_id FROM servers WHERE id=$1',[serverId]);
  if(!server.rowCount)throw Object.assign(new Error('Server not found'),{statusCode:404});
  await membership(userId,server.rows[0].organization_id,permission);
  return server.rows[0].organization_id as string;
}
export async function dockerRoutes(app:FastifyInstance) {
  app.get('/servers/:serverId/docker/containers',async request=>{
    const {userId}=await authenticate(request);
    const {serverId}=params.parse(request.params);
    await authorizedServer(userId,serverId,'server.read');
    const result=await sendAgentCommand(serverId,'docker.listContainers');
    return {containers:z.array(containerSummary).max(200).parse(result)};
  });
  app.post('/servers/:serverId/docker/containers/:containerId/restart',async request=>{
    const {userId}=await authenticate(request);
    const {serverId,containerId:target}=restartParams.parse(request.params);
    z.object({confirm:z.literal(true)}).strict().parse(request.body);
    const orgId=await authorizedServer(userId,serverId,'server.action');
    await audit(orgId,userId,'docker.restart.requested','container',target,request.ip,{serverId});
    try {
      const result=await sendAgentCommand(serverId,'docker.restartContainer',{containerId:target});
      z.object({restarted:z.literal(true)}).parse(result);
      await audit(orgId,userId,'docker.restart.succeeded','container',target,request.ip,{serverId});
      return {ok:true};
    } catch(error) {
      await audit(orgId,userId,'docker.restart.failed','container',target,request.ip,{serverId});
      throw error;
    }
  });
}
