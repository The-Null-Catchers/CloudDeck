import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.js';
import {authenticate,membership,audit} from './security.js';
import {sendAgentCommand} from './commands.js';

const serverParams=z.object({serverId:z.uuid()});
const serviceParams=serverParams.extend({serviceName:z.string().regex(/^[A-Za-z0-9@_.:-]+\.service$/).max(180)});
const serviceSummary=z.object({
  name:z.string().max(180),
  load:z.string().max(32),
  active:z.string().max(32),
  sub:z.string().max(32),
  description:z.string().max(300)
});
const actionBody=z.object({action:z.enum(['start','stop','restart']),confirm:z.literal(true)}).strict();

async function authorize(userId:string,serverId:string,permission:'server.read'|'server.action') {
  const server=await pool.query('SELECT organization_id FROM servers WHERE id=$1',[serverId]);
  if(!server.rowCount)throw Object.assign(new Error('Server not found'),{statusCode:404});
  await membership(userId,server.rows[0].organization_id,permission);
  return server.rows[0].organization_id as string;
}

export async function serviceRoutes(app:FastifyInstance) {
  app.get('/servers/:serverId/services',async request=>{
    const {userId}=await authenticate(request);
    const {serverId}=serverParams.parse(request.params);
    await authorize(userId,serverId,'server.read');
    const result=await sendAgentCommand(serverId,'systemd.listServices');
    return {services:z.array(serviceSummary).max(500).parse(result)};
  });

  app.post('/servers/:serverId/services/:serviceName/action',async request=>{
    const {userId}=await authenticate(request);
    const {serverId,serviceName}=serviceParams.parse(request.params);
    const {action}=actionBody.parse(request.body);
    const organizationId=await authorize(userId,serverId,'server.action');
    const agentAction={
      start:'systemd.startService',
      stop:'systemd.stopService',
      restart:'systemd.restartService'
    } as const;
    const auditBase={serverId,serviceName,operation:action};
    await audit(organizationId,userId,'systemd.action.requested','service',serviceName,request.ip,auditBase);
    try {
      const result=z.object({ok:z.literal(true)}).parse(await sendAgentCommand(serverId,agentAction[action],{serviceName}));
      await audit(organizationId,userId,'systemd.action.succeeded','service',serviceName,request.ip,auditBase);
      return result;
    } catch(error) {
      await audit(organizationId,userId,'systemd.action.failed','service',serviceName,request.ip,auditBase);
      throw error;
    }
  });
}
