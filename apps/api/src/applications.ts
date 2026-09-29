import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.js';
import {authenticate,membership,audit} from './security.js';
import {verifyGitHubSource} from './github.js';

const uuid=z.uuid();
const common={
  organizationId:uuid,
  serverId:uuid,
  name:z.string().trim().min(1).max(100),
  githubInstallationId:uuid,
  repositoryFullName:z.string().trim().min(3).max(201),
  branch:z.string().trim().min(1).max(255)
};
const createApplication=z.discriminatedUnion('deploymentType',[
  z.object({...common,deploymentType:z.literal('dockerfile'),sourcePath:z.string().trim().min(1).max(240).default('Dockerfile')}).strict(),
  z.object({...common,deploymentType:z.literal('compose'),sourcePath:z.string().trim().min(1).max(240).default('docker-compose.yml')}).strict()
]);

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
    const result=await pool.query(
      `INSERT INTO applications(organization_id,server_id,name,github_installation_id,repository_full_name,branch,deployment_type,source_path)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id,organization_id,server_id,name,github_installation_id,repository_full_name,branch,deployment_type,source_path,created_at`,
      [body.organizationId,body.serverId,body.name,source.connectionId,body.repositoryFullName,body.branch,body.deploymentType,source.sourcePath]
    );
    const application=result.rows[0];
    await audit(body.organizationId,userId,'application.create','application',application.id,request.ip,{
      repository:body.repositoryFullName,
      branch:body.branch,
      deploymentType:body.deploymentType,
      verifiedCommit:source.commitSha
    });
    reply.code(201);
    return application;
  });

  app.get('/organizations/:orgId/applications',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=z.object({orgId:uuid}).parse(request.params);
    await membership(userId,orgId,'deployment.read');
    const rows=await pool.query(
      `SELECT a.id,a.server_id,a.name,a.github_installation_id,a.repository_full_name,a.branch,a.deployment_type,a.source_path,a.created_at,
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
      `SELECT a.id,a.organization_id,a.server_id,a.name,a.github_installation_id,a.repository_full_name,a.branch,a.deployment_type,a.source_path,a.created_at,
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
