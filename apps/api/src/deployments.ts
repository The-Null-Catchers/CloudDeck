import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {z} from 'zod';
import {pool,transaction} from './db.js';
import {authenticate,membership,audit} from './security.js';
import {verifyGitHubSource} from './github.js';
import {enqueueDeployment} from './deployment-queue.js';

export const deploymentStates=['queued','cloning','building','deploying','health-checking','successful','failed','rolled-back'] as const;
export type DeploymentState=typeof deploymentStates[number];

const transitions:Record<DeploymentState,ReadonlySet<DeploymentState>>={
  queued:new Set(['cloning','failed']),
  cloning:new Set(['building','failed']),
  building:new Set(['deploying','failed']),
  deploying:new Set(['health-checking','failed']),
  'health-checking':new Set(['successful','failed']),
  successful:new Set(['rolled-back']),
  failed:new Set(),
  'rolled-back':new Set()
};

export function canTransitionDeployment(from:DeploymentState,to:DeploymentState){
  return transitions[from].has(to);
}

export async function transitionDeployment(
  deploymentId:string,
  next:DeploymentState,
  options:{message?:string;failureCode?:string|null}={},
  client?:pg.PoolClient
){
  const run=async(db:pg.PoolClient)=>{
    const current=await db.query(
      `SELECT d.id,d.state,a.organization_id
       FROM deployments d
       JOIN applications a ON a.id=d.application_id
       WHERE d.id=$1
       FOR UPDATE`,
      [deploymentId]
    );
    if(!current.rowCount)throw Object.assign(new Error('Deployment not found'),{statusCode:404});
    const from=current.rows[0].state as DeploymentState;
    if(!canTransitionDeployment(from,next)){
      throw Object.assign(new Error(`Invalid deployment transition: ${from} -> ${next}`),{statusCode:409});
    }
    const terminal=next==='successful'||next==='failed'||next==='rolled-back';
    const started=from==='queued'&&next==='cloning';
    const updated=await db.query(
      `UPDATE deployments
       SET state=$2,
           started_at=CASE WHEN $3 THEN COALESCE(started_at,now()) ELSE started_at END,
           finished_at=CASE WHEN $4 THEN now() ELSE finished_at END,
           failure_code=CASE WHEN $2='failed' THEN $5 ELSE failure_code END
       WHERE id=$1
       RETURNING id,application_id,commit_sha,branch,state,created_at,started_at,finished_at,failure_code,rollback_of_deployment_id`,
      [deploymentId,next,started,terminal,options.failureCode??null]
    );
    await db.query(
      'INSERT INTO deployment_events(deployment_id,state,message) VALUES($1,$2,$3)',
      [deploymentId,next,options.message??null]
    );
    return {...updated.rows[0],organizationId:current.rows[0].organization_id as string};
  };
  if(client)return run(client);
  return transaction(run);
}

const uuid=z.uuid();
const listQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(50)}).strict();
const idempotencyKey=z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export function parseDeploymentIdempotencyKey(value:unknown){
  return idempotencyKey.parse(value);
}

export async function deploymentRoutes(app:FastifyInstance){
  app.post('/applications/:applicationId/deployments',async (request,reply)=>{
    const {userId}=await authenticate(request);
    const {applicationId}=z.object({applicationId:uuid}).parse(request.params);
    const requestKey=parseDeploymentIdempotencyKey(request.headers['idempotency-key']);
    const application=await pool.query(
      `SELECT id,organization_id,github_installation_id,repository_full_name,branch,deployment_type,source_path,
              container_name,container_port,host_port,restart_policy,compose_project
       FROM applications
       WHERE id=$1`,
      [applicationId]
    );
    if(!application.rowCount)throw Object.assign(new Error('Application not found'),{statusCode:404});
    const sourceConfig=application.rows[0];
    await membership(userId,sourceConfig.organization_id,'deployment.manage');
    const runtimeReady=sourceConfig.deployment_type==='dockerfile'
      ? Boolean(sourceConfig.container_name)
      : sourceConfig.deployment_type==='compose'
        ? Boolean(sourceConfig.compose_project)
        : false;
    if(!runtimeReady)throw Object.assign(new Error('Application runtime configuration is required before deployment'),{statusCode:409});
    if(sourceConfig.deployment_type==='compose')throw Object.assign(new Error('Automated Docker Compose deployment execution is not available yet'),{statusCode:409});

    const source=await verifyGitHubSource(
      sourceConfig.organization_id,
      sourceConfig.github_installation_id,
      sourceConfig.repository_full_name,
      sourceConfig.branch,
      sourceConfig.source_path
    );

    const created=await transaction(async db=>{
      const inserted=await db.query(
        `INSERT INTO deployments(
           application_id,commit_sha,branch,state,requested_by,idempotency_key,
           github_installation_id,repository_full_name,deployment_type,source_path,
           container_name,container_port,host_port,restart_policy,compose_project
         )
         VALUES($1,$2,$3,'queued',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (application_id,idempotency_key) WHERE idempotency_key IS NOT NULL
         DO NOTHING
         RETURNING id,application_id,commit_sha,branch,state,created_at,requested_by,
                   github_installation_id,repository_full_name,deployment_type,source_path,
                   container_name,container_port,host_port,restart_policy,compose_project`,
        [
          applicationId,
          source.commitSha,
          sourceConfig.branch,
          userId,
          requestKey,
          source.connectionId,
          sourceConfig.repository_full_name,
          sourceConfig.deployment_type,
          source.sourcePath,
          sourceConfig.container_name,
          sourceConfig.container_port,
          sourceConfig.host_port,
          sourceConfig.restart_policy,
          sourceConfig.compose_project
        ]
      );
      if(inserted.rowCount){
        await db.query(
          `INSERT INTO deployment_events(deployment_id,state,message)
           VALUES($1,'queued','Deployment requested and source commit pinned')`,
          [inserted.rows[0].id]
        );
        await audit(sourceConfig.organization_id,userId,'deployment.request','deployment',inserted.rows[0].id,request.ip,{
          applicationId,
          repository:sourceConfig.repository_full_name,
          branch:sourceConfig.branch,
          commitSha:source.commitSha,
          deploymentType:sourceConfig.deployment_type,
          runtime:sourceConfig.deployment_type==='dockerfile'?{
            containerName:sourceConfig.container_name,
            containerPort:sourceConfig.container_port,
            hostPort:sourceConfig.host_port,
            restartPolicy:sourceConfig.restart_policy
          }:{composeProject:sourceConfig.compose_project}
        },db);
        return {deployment:inserted.rows[0],created:true};
      }
      const existing=await db.query(
        `SELECT id,application_id,commit_sha,branch,state,created_at,requested_by,
                github_installation_id,repository_full_name,deployment_type,source_path,
                container_name,container_port,host_port,restart_policy,compose_project
         FROM deployments
         WHERE application_id=$1 AND idempotency_key=$2`,
        [applicationId,requestKey]
      );
      if(!existing.rowCount)throw new Error('Idempotent deployment lookup failed');
      return {deployment:existing.rows[0],created:false};
    });

    let dispatch:'enqueued'|'pending'='enqueued';
    try{
      await enqueueDeployment(created.deployment.id as string);
    }catch{
      dispatch='pending';
      if(created.created){
        await pool.query(
          `INSERT INTO deployment_events(deployment_id,state,message)
           VALUES($1,'queued','Queue dispatch pending; automatic reconciliation will retry')`,
          [created.deployment.id]
        );
      }
    }
    if(created.created)reply.code(201);
    return {...created.deployment,dispatch};
  });

  app.get('/organizations/:orgId/deployments',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=z.object({orgId:uuid}).parse(request.params);
    const {limit}=listQuery.parse(request.query);
    await membership(userId,orgId,'deployment.read');
    const rows=await pool.query(
      `SELECT d.id,d.application_id,a.name AS application_name,d.commit_sha,d.branch,d.state,d.created_at,d.started_at,d.finished_at,d.failure_code,d.rollback_of_deployment_id,
              d.repository_full_name,d.deployment_type,d.source_path,d.container_name,d.container_port,d.host_port,d.restart_policy,d.compose_project,d.image_ref,d.container_id,d.previous_container_id
       FROM deployments d
       JOIN applications a ON a.id=d.application_id
       WHERE a.organization_id=$1
       ORDER BY d.created_at DESC
       LIMIT $2`,
      [orgId,limit]
    );
    return {deployments:rows.rows};
  });

  app.get('/deployments/:deploymentId',async request=>{
    const {userId}=await authenticate(request);
    const {deploymentId}=z.object({deploymentId:uuid}).parse(request.params);
    const deployment=await pool.query(
      `SELECT d.id,d.application_id,a.organization_id,a.name AS application_name,d.commit_sha,d.branch,d.state,d.created_at,d.started_at,d.finished_at,d.failure_code,d.rollback_of_deployment_id,
              d.requested_by,d.repository_full_name,d.deployment_type,d.source_path,d.container_name,d.container_port,d.host_port,d.restart_policy,d.compose_project
       FROM deployments d
       JOIN applications a ON a.id=d.application_id
       WHERE d.id=$1`,
      [deploymentId]
    );
    if(!deployment.rowCount)throw Object.assign(new Error('Deployment not found'),{statusCode:404});
    await membership(userId,deployment.rows[0].organization_id,'deployment.read');
    const events=await pool.query(
      'SELECT id,state,message,created_at FROM deployment_events WHERE deployment_id=$1 ORDER BY id ASC LIMIT 1000',
      [deploymentId]
    );
    return {...deployment.rows[0],events:events.rows};
  });
}
