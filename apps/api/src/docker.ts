import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.js';
import {authenticate,membership,audit} from './security.js';
import {containerId,sendAgentCommand} from './commands.js';

const params=z.object({serverId:z.uuid()});
const orgParams=z.object({orgId:z.uuid()});
const containerParams=params.extend({containerId});
const composeServiceParams=params.extend({project:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),service:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)});
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

const inspectSchema=z.object({
  image:z.string().max(300),
  created:z.string().max(100),
  restartCount:z.number().int().nonnegative(),
  mounts:z.array(z.object({type:z.string().max(32),source:z.string().max(500).optional(),destination:z.string().max(500),readOnly:z.boolean()})).max(100),
  networks:z.array(z.string().max(200)).max(100),
  ports:z.array(z.string().max(50)).max(100)
});
const statsSchema=z.object({
  cpuPercent:z.number().min(0).max(10000),
  memoryUsage:z.number().nonnegative(),
  memoryLimit:z.number().nonnegative(),
  networkRxBytes:z.number().nonnegative(),
  networkTxBytes:z.number().nonnegative()
});
const logQuery=z.object({limit:z.coerce.number().int().min(1).max(500).default(200)}).strict();

const composeLifecycleBody=z.object({action:z.enum(['start','stop','restart']),confirm:z.literal(true)}).strict();
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
  app.get('/organizations/:orgId/docker/containers',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=orgParams.parse(request.params);
    await membership(userId,orgId,'server.read');
    const servers=await pool.query(
      `SELECT id,name,hostname,status FROM servers WHERE organization_id=$1 ORDER BY name LIMIT 100`,
      [orgId]
    );
    const online=servers.rows.filter(server=>server.status==='online');
    const results=await Promise.all(online.map(async server=>{
      try{
        const raw=await sendAgentCommand(server.id,'docker.listContainers');
        const containers=z.array(containerSummary).max(200).parse(raw);
        return {server,error:null,containers};
      }catch(error){
        return {server,error:error instanceof Error?error.message:'Agent command failed',containers:[]};
      }
    }));
    return {
      containers:results.flatMap(result=>result.containers.map(container=>({
        ...container,
        serverId:result.server.id,
        serverName:result.server.name,
        serverHostname:result.server.hostname
      }))),
      servers:servers.rows.map(server=>({
        id:server.id,
        name:server.name,
        hostname:server.hostname,
        status:server.status,
        error:results.find(result=>result.server.id===server.id)?.error??null
      }))
    };
  });

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

  app.post('/servers/:serverId/docker/compose/:project/services/:service/action',async request=>{
    const {userId}=await authenticate(request);
    const {serverId,project,service}=composeServiceParams.parse(request.params);
    const {action}=composeLifecycleBody.parse(request.body);
    const orgId=await authorizedServer(userId,serverId,'server.action');
    const agentAction={start:'docker.startComposeService',stop:'docker.stopComposeService',restart:'docker.restartComposeService'} as const;
    const target=project+'/'+service;
    const metadata={serverId,project,service,operation:action};
    await audit(orgId,userId,`docker.compose.${action}.requested`,'compose_service',target,request.ip,metadata);
    try{
      z.object({ok:z.literal(true)}).parse(await sendAgentCommand(serverId,agentAction[action],{project,service}));
      await audit(orgId,userId,`docker.compose.${action}.succeeded`,'compose_service',target,request.ip,metadata);
      return {ok:true};
    }catch(error){
      await audit(orgId,userId,`docker.compose.${action}.failed`,'compose_service',target,request.ip,metadata);
      throw error;
    }
  });

  app.get('/servers/:serverId/docker/containers/:containerId/inspect',async request=>{
    const {userId}=await authenticate(request);
    const {serverId,containerId:target}=containerParams.parse(request.params);
    await authorizedServer(userId,serverId,'server.read');
    return inspectSchema.parse(await sendAgentCommand(serverId,'docker.inspectContainer',{containerId:target}));
  });

  app.get('/servers/:serverId/docker/containers/:containerId/stats',async request=>{
    const {userId}=await authenticate(request);
    const {serverId,containerId:target}=containerParams.parse(request.params);
    await authorizedServer(userId,serverId,'server.read');
    return statsSchema.parse(await sendAgentCommand(serverId,'docker.getContainerStats',{containerId:target}));
  });

  app.get('/servers/:serverId/docker/containers/:containerId/logs',async request=>{
    const {userId}=await authenticate(request);
    const {serverId,containerId:target}=containerParams.parse(request.params);
    const {limit}=logQuery.parse(request.query);
    const orgId=await authorizedServer(userId,serverId,'server.read');
    await audit(orgId,userId,'logs.docker.read','container',target,request.ip,{serverId,limit});
    return z.object({lines:z.array(z.string().max(4000)).max(500),truncated:z.boolean()}).parse(
      await sendAgentCommand(serverId,'docker.tailContainerLogs',{containerId:target,limit})
    );
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
