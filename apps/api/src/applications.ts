import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.js';
import {authenticate,membership,audit} from './security.js';
import {verifyGitHubSource} from './github.js';

const uuid=z.uuid();
const port=z.number().int().min(1).max(65535);
const runtimeName=z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const restartPolicy=z.enum(['no','always','unless-stopped','on-failure']);
const dockerRuntime=z.object({
  containerName:runtimeName,
  containerPort:port.optional(),
  hostPort:port.optional(),
  restartPolicy:restartPolicy.default('unless-stopped')
}).strict();
const composeRuntime=z.object({
  composeProject:runtimeName
}).strict();

export function parseApplicationRuntime(type:'dockerfile'|'compose',input:unknown){
  if(type==='dockerfile'){
    const parsed=dockerRuntime.parse(input);
    if(parsed.hostPort!==undefined&&parsed.containerPort===undefined){
      throw Object.assign(new Error('containerPort is required when hostPort is configured'),{statusCode:400});
    }
    return {
      containerName:parsed.containerName,
      containerPort:parsed.containerPort??null,
      hostPort:parsed.hostPort??null,
      restartPolicy:parsed.restartPolicy,
      composeProject:null
    };
  }
  const parsed=composeRuntime.parse(input);
  return {
    containerName:null,
    containerPort:null,
    hostPort:null,
    restartPolicy:null,
    composeProject:parsed.composeProject
  };
}

const common={
  organizationId:uuid,
  serverId:uuid,
  name:z.string().trim().min(1).max(100),
  githubInstallationId:uuid,
  repositoryFullName:z.string().trim().min(3).max(201),
  branch:z.string().trim().min(1).max(255)
};
const createApplication=z.discriminatedUnion('deploymentType',[
  z.object({...common,deploymentType:z.literal('dockerfile'),sourcePath:z.string().trim().min(1).max(240).default('Dockerfile'),runtime:dockerRuntime}).strict(),
  z.object({...common,deploymentType:z.literal('compose'),sourcePath:z.string().trim().min(1).max(240).default('docker-compose.yml'),runtime:composeRuntime}).strict()
]);

const runtimeColumns=`container_name,container_port,host_port,restart_policy,compose_project`;

export async function applicationRoutes(app:FastifyInstance){
  app.post('/applications',async (request,reply)=>{
    const {userId}=await authenticate(request);
    const body=createApplication.parse(request.body);
    await membership(userId,body.organizationId,'deployment.manage');
    const server=await pool.query('SELECT 1 FROM servers WHERE id=$1 AND organization_id=$2',[body.serverId,body.organizationId]);
    if(!server.rowCount)throw Object.assign(new Error('Server not found in this workspace'),{statusCode:404});
    const source=await verifyGitHubSource(
      body.organizationId,
      body.githubInstallationId,
      body.repositoryFullName,
      body.branch,
      body.sourcePath
    );
    const runtime=parseApplicationRuntime(body.deploymentType,body.runtime);
    let result;
    try{
      result=await pool.query(
        `INSERT INTO applications(
           organization_id,server_id,name,github_installation_id,repository_full_name,branch,deployment_type,source_path,
           container_name,container_port,host_port,restart_policy,compose_project
         )
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id,organization_id,server_id,name,github_installation_id,repository_full_name,branch,deployment_type,source_path,
                   ${runtimeColumns},created_at`,
        [
          body.organizationId,body.serverId,body.name,source.connectionId,body.repositoryFullName,body.branch,body.deploymentType,source.sourcePath,
          runtime.containerName,runtime.containerPort,runtime.hostPort,runtime.restartPolicy,runtime.composeProject
        ]
      );
    }catch(error){
      if((error as {code?:string}).code==='23505')throw Object.assign(new Error('Application runtime target conflicts with another application on this server'),{statusCode:409});
      throw error;
    }
    const application=result.rows[0];
    await audit(body.organizationId,userId,'application.create','application',application.id,request.ip,{
      repository:body.repositoryFullName,
      branch:body.branch,
      deploymentType:body.deploymentType,
      verifiedCommit:source.commitSha,
      runtime:body.deploymentType==='dockerfile'?{
        containerName:runtime.containerName,
        containerPort:runtime.containerPort,
        hostPort:runtime.hostPort,
        restartPolicy:runtime.restartPolicy
      }:{composeProject:runtime.composeProject}
    });
    reply.code(201);
    return application;
  });

  app.put('/applications/:applicationId/runtime',async request=>{
    const {userId}=await authenticate(request);
    const {applicationId}=z.object({applicationId:uuid}).parse(request.params);
    const current=await pool.query(
      'SELECT id,organization_id,deployment_type FROM applications WHERE id=$1',
      [applicationId]
    );
    if(!current.rowCount)throw Object.assign(new Error('Application not found'),{statusCode:404});
    const row=current.rows[0] as {id:string;organization_id:string;deployment_type:'dockerfile'|'compose'};
    await membership(userId,row.organization_id,'deployment.manage');
    const runtime=parseApplicationRuntime(row.deployment_type,request.body);
    let updated;
    try{
      updated=await pool.query(
        `UPDATE applications
         SET container_name=$2,container_port=$3,host_port=$4,restart_policy=$5,compose_project=$6
         WHERE id=$1
         RETURNING id,deployment_type,${runtimeColumns}`,
        [applicationId,runtime.containerName,runtime.containerPort,runtime.hostPort,runtime.restartPolicy,runtime.composeProject]
      );
    }catch(error){
      if((error as {code?:string}).code==='23505')throw Object.assign(new Error('Application runtime target conflicts with another application on this server'),{statusCode:409});
      throw error;
    }
    await audit(row.organization_id,userId,'application.runtime.update','application',applicationId,request.ip,{
      deploymentType:row.deployment_type,
      containerName:runtime.containerName,
      containerPort:runtime.containerPort,
      hostPort:runtime.hostPort,
      restartPolicy:runtime.restartPolicy,
      composeProject:runtime.composeProject
    });
    return updated.rows[0];
  });

  app.get('/organizations/:orgId/applications',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=z.object({orgId:uuid}).parse(request.params);
    await membership(userId,orgId,'deployment.read');
    const rows=await pool.query(
      `SELECT a.id,a.server_id,a.name,a.github_installation_id,a.repository_full_name,a.branch,a.deployment_type,a.source_path,
              a.container_name,a.container_port,a.host_port,a.restart_policy,a.compose_project,a.created_at,
              s.name AS server_name,s.status AS server_status,g.account_login AS github_account
       FROM applications a
       LEFT JOIN servers s ON s.id=a.server_id
       LEFT JOIN github_installations g ON g.id=a.github_installation_id
       WHERE a.organization_id=$1
       ORDER BY a.created_at DESC
       LIMIT 200`,
      [orgId]
    );
    return {applications:rows.rows};
  });

  app.get('/applications/:applicationId',async request=>{
    const {userId}=await authenticate(request);
    const {applicationId}=z.object({applicationId:uuid}).parse(request.params);
    const row=await pool.query(
      `SELECT a.id,a.organization_id,a.server_id,a.name,a.github_installation_id,a.repository_full_name,a.branch,a.deployment_type,a.source_path,
              a.container_name,a.container_port,a.host_port,a.restart_policy,a.compose_project,a.created_at,
              s.name AS server_name,s.status AS server_status,g.account_login AS github_account
       FROM applications a
       LEFT JOIN servers s ON s.id=a.server_id
       LEFT JOIN github_installations g ON g.id=a.github_installation_id
       WHERE a.id=$1`,
      [applicationId]
    );
    if(!row.rowCount)throw Object.assign(new Error('Application not found'),{statusCode:404});
    await membership(userId,row.rows[0].organization_id,'deployment.read');
    return row.rows[0];
  });
}
