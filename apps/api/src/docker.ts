import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.js';
import {authenticate,membership,audit} from './security.js';
import {containerId,sendAgentCommand} from './commands.js';

const params=z.object({serverId:z.uuid()});
const containerParams=params.extend({containerId});
const containerSummary=z.object({
  id:containerId,
  name:z.string().max(200),
  image:z.string().max(300),
  state:z.string().max(32),
  status:z.string().max(200),
  ports:z.array(z.object({privatePort:z.number().int(),publicPort:z.number().int().optional(),type:z.string().max(12)})).max(100),
  composeProject:z.string().max(200).optional(),
  composeService:z.string().max(200).optional()
});
const composeProject=z.object({
  name:z.string().max(200),
  services:z.array(z.string().max(200)).max(200),
  running:z.number().int().nonnegative(),
  total:z.number().int().nonnegative()
});
const lifecycleBody=z.object({
  action:z.enum(['start','stop','restart','pause','unpause','remove']),
  confirm:z.literal(true)
}).strict();

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

  app.get('/servers/:serverId/docker/compose',async request=>{
    const {userId}=await authenticate(request);
    const {serverId}=params.parse(request.params);
    await authorizedServer(userId,serverId,'server.read');
    const result=await sendAgentCommand(serverId,'docker.listComposeProjects');
    return {projects:z.array(composeProject).max(100).parse(result)};
  });

  app.post('/servers/:serverId/docker/containers/:containerId/action',async request=>{
    const {userId}=await authenticate(request);
    const {serverId,containerId:target}=containerParams.parse(request.params);
    const {action}=lifecycleBody.parse(request.body);
    const orgId=await authorizedServer(userId,serverId,'server.action');
    const agentAction={
      start:'docker.startContainer',
      stop:'docker.stopContainer',
      restart:'docker.restartContainer',
      pause:'docker.pauseContainer',
      unpause:'docker.unpauseContainer',
      remove:'docker.removeContainer'
    } as const;
    const metadata={serverId,operation:action};
    await audit(orgId,userId,`docker.${action}.requested`,'container',target,request.ip,metadata);
    try {
      z.object({ok:z.literal(true)}).parse(await sendAgentCommand(serverId,agentAction[action],{containerId:target}));
      await audit(orgId,userId,`docker.${action}.succeeded`,'container',target,request.ip,metadata);
      return {ok:true};
    } catch(error) {
      await audit(orgId,userId,`docker.${action}.failed`,'container',target,request.ip,metadata);
      throw error;
    }
  });
}
