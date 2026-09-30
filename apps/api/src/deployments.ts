import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {z} from 'zod';
import {pool,transaction} from './db.js';
import {authenticate,membership,audit} from './security.js';
import {verifyGitHubSource} from './github.js';
import {enqueueDeployment,removeQueuedDeploymentJob} from './deployment-queue.js';
import {sendAgentCommand} from './commands.js';

export const deploymentStates=['queued','cloning','building','deploying','health-checking','successful','failed','cancelled','rolled-back'] as const;
export type DeploymentState=typeof deploymentStates[number];

const transitions:Record<DeploymentState,ReadonlySet<DeploymentState>>={
  queued:new Set(['cloning','failed','cancelled']),
  cloning:new Set(['building','failed','cancelled']),
  building:new Set(['deploying','failed','cancelled']),
  deploying:new Set(['health-checking','failed','cancelled']),
  'health-checking':new Set(['successful','failed','cancelled']),
  successful:new Set(['rolled-back']),
  failed:new Set(),
  cancelled:new Set(),
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
    const terminal=next==='successful'||next==='failed'||next==='cancelled'||next==='rolled-back';
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
const rollbackBody=z.object({confirm:z.literal(true)}).strict();
const cancelBody=z.object({confirm:z.literal(true)}).strict();
const rollbackResult=z.object({
  containerId:z.string().regex(/^[a-f0-9]{12,64}$/i),
  rolledBackContainerId:z.string().regex(/^[a-f0-9]{12,64}$/i)
}).strict();
const composeContainerMap=z.record(
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
  z.string().regex(/^[a-f0-9]{12,64}$/i)
);
const composeRollbackResult=z.object({
  composeContainerIds:composeContainerMap,
  rolledBackComposeContainerIds:composeContainerMap
}).strict();
const cancelResult=z.object({cancelled:z.boolean()}).strict();

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

  app.post('/deployments/:deploymentId/cancel',async (request,reply)=>{
    const {userId}=await authenticate(request);
    const {deploymentId}=z.object({deploymentId:uuid}).parse(request.params);
    cancelBody.parse(request.body);
    const deployment=await pool.query(
      `SELECT d.id,d.state,d.cancel_requested_at,a.organization_id,a.server_id
       FROM deployments d
       JOIN applications a ON a.id=d.application_id
       WHERE d.id=$1`,
      [deploymentId]
    );
    if(!deployment.rowCount)throw Object.assign(new Error('Deployment not found'),{statusCode:404});
    const row=deployment.rows[0];
    await membership(userId,row.organization_id,'deployment.manage');
    if(['successful','failed','cancelled','rolled-back'].includes(row.state)){
      throw Object.assign(new Error('Only an active or queued deployment can be cancelled'),{statusCode:409});
    }

    await pool.query(
      `UPDATE deployments
       SET cancel_requested_at=COALESCE(cancel_requested_at,now()),cancelled_by=$2
       WHERE id=$1`,
      [deploymentId,userId]
    );
    await audit(row.organization_id,userId,'deployment.cancel.requested','deployment',deploymentId,request.ip,{state:row.state});

    if(row.state==='queued'){
      try{await removeQueuedDeploymentJob(deploymentId);}catch{void 0;}
      const latest=await pool.query('SELECT state FROM deployments WHERE id=$1',[deploymentId]);
      if(latest.rows[0]?.state==='queued'){
        const cancelled=await transaction(async db=>{
          const transitioned=await transitionDeployment(deploymentId,'cancelled',{message:'Deployment cancelled before execution'},db);
          await audit(row.organization_id,userId,'deployment.cancel.completed','deployment',deploymentId,request.ip,{beforeExecution:true},db);
          return transitioned;
        });
        return {...cancelled,cancelRequested:true};
      }
    }

    const current=await pool.query('SELECT state FROM deployments WHERE id=$1',[deploymentId]);
    if(['successful','failed','cancelled','rolled-back'].includes(current.rows[0]?.state)){
      return {id:deploymentId,state:current.rows[0].state,cancelRequested:false};
    }

    let agentAcknowledged=false;
    if(row.server_id){
      try{
        const result=cancelResult.parse(await sendAgentCommand(
          row.server_id,
          'deployment.cancel',
          {deploymentId},
          15_000
        ));
        agentAcknowledged=result.cancelled;
      }catch{void 0;}
    }
    reply.code(202);
    return {id:deploymentId,state:'cancellation-requested',cancelRequested:true,agentAcknowledged};
  });

  app.post('/deployments/:deploymentId/rollback',async request=>{
    const {userId}=await authenticate(request);
    const {deploymentId}=z.object({deploymentId:uuid}).parse(request.params);
    rollbackBody.parse(request.body);
    const deployment=await pool.query(
      `SELECT d.id,d.state,d.deployment_type,d.container_name,d.container_id,d.previous_container_id,
              d.compose_project,d.compose_container_ids,d.previous_compose_container_ids,
              a.organization_id,a.server_id
       FROM deployments d
       JOIN applications a ON a.id=d.application_id
       WHERE d.id=$1`,
      [deploymentId]
    );
    if(!deployment.rowCount)throw Object.assign(new Error('Deployment not found'),{statusCode:404});
    const row=deployment.rows[0];
    await membership(userId,row.organization_id,'deployment.manage');
    if(row.state!=='successful')throw Object.assign(new Error('Only a successful deployment can be rolled back'),{statusCode:409});
    if(!row.server_id)throw Object.assign(new Error('Deployment target server is unavailable'),{statusCode:409});

    if(row.deployment_type==='compose'){
      const current=composeContainerMap.safeParse(row.compose_container_ids);
      const previous=composeContainerMap.safeParse(row.previous_compose_container_ids);
      if(!row.compose_project||!current.success||!previous.success||Object.keys(previous.data).length===0){
        throw Object.assign(new Error('This Compose deployment does not have a restorable previous project'),{statusCode:409});
      }
      await audit(row.organization_id,userId,'deployment.rollback.requested','deployment',deploymentId,request.ip,{
        deploymentType:'compose',
        composeProject:row.compose_project,
        services:Object.keys(current.data).sort()
      });
      let restored;
      try{
        restored=composeRollbackResult.parse(await sendAgentCommand(
          row.server_id,
          'deployment.rollbackCompose',
          {
            deploymentId,
            composeProject:row.compose_project,
            currentComposeContainerIds:current.data,
            previousComposeContainerIds:previous.data
          },
          5*60_000
        ));
      }catch(error){
        const reason=error instanceof Error?error.message:'Compose rollback failed';
        await audit(row.organization_id,userId,'deployment.rollback.failed','deployment',deploymentId,request.ip,{
          deploymentType:'compose',
          reason:reason.slice(0,200)
        });
        throw Object.assign(new Error('Compose rollback failed on target agent'),{statusCode:502});
      }
      const updated=await transaction(async db=>{
        const transitioned=await transitionDeployment(deploymentId,'rolled-back',{message:'Previous Compose project restored and readiness verified'},db);
        await db.query(
          `UPDATE deployments
           SET compose_container_ids=$2::jsonb,previous_compose_container_ids=$3::jsonb
           WHERE id=$1`,
          [deploymentId,JSON.stringify(restored.composeContainerIds),JSON.stringify(restored.rolledBackComposeContainerIds)]
        );
        await audit(row.organization_id,userId,'deployment.rollback.completed','deployment',deploymentId,request.ip,{
          deploymentType:'compose',
          activeServices:Object.keys(restored.composeContainerIds).sort()
        },db);
        return transitioned;
      });
      return {
        ...updated,
        composeContainerIds:restored.composeContainerIds,
        previousComposeContainerIds:restored.rolledBackComposeContainerIds
      };
    }

    if(row.deployment_type!=='dockerfile'||!row.container_name||!row.container_id||!row.previous_container_id){
      throw Object.assign(new Error('This deployment does not have a restorable previous container'),{statusCode:409});
    }
    await audit(row.organization_id,userId,'deployment.rollback.requested','deployment',deploymentId,request.ip,{
      deploymentType:'dockerfile',
      currentContainerId:row.container_id,
      previousContainerId:row.previous_container_id
    });
    let restored;
    try{
      restored=rollbackResult.parse(await sendAgentCommand(
        row.server_id,
        'deployment.rollback',
        {
          deploymentId,
          containerName:row.container_name,
          currentContainerId:row.container_id,
          previousContainerId:row.previous_container_id
        },
        2*60_000
      ));
    }catch(error){
      const reason=error instanceof Error?error.message:'Rollback failed';
      await audit(row.organization_id,userId,'deployment.rollback.failed','deployment',deploymentId,request.ip,{
        deploymentType:'dockerfile',
        reason:reason.slice(0,200)
      });
      throw Object.assign(new Error('Rollback failed on target agent'),{statusCode:502});
    }
    const updated=await transaction(async db=>{
      const transitioned=await transitionDeployment(deploymentId,'rolled-back',{message:'Previous container restored and readiness verified'},db);
      await db.query(
        `UPDATE deployments
         SET container_id=$2,previous_container_id=$3
         WHERE id=$1`,
        [deploymentId,restored.containerId,restored.rolledBackContainerId]
      );
      await audit(row.organization_id,userId,'deployment.rollback.completed','deployment',deploymentId,request.ip,{
        deploymentType:'dockerfile',
        activeContainerId:restored.containerId,
        rolledBackContainerId:restored.rolledBackContainerId
      },db);
      return transitioned;
    });
    return {...updated,containerId:restored.containerId,previousContainerId:restored.rolledBackContainerId};
  });

  app.get('/organizations/:orgId/deployments',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=z.object({orgId:uuid}).parse(request.params);
    const {limit}=listQuery.parse(request.query);
    await membership(userId,orgId,'deployment.read');
    const rows=await pool.query(
      `SELECT d.id,d.application_id,a.name AS application_name,d.commit_sha,d.branch,d.state,d.created_at,d.started_at,d.finished_at,d.failure_code,d.cancel_requested_at,d.cancelled_by,d.rollback_of_deployment_id,
              d.repository_full_name,d.deployment_type,d.source_path,d.container_name,d.container_port,d.host_port,d.restart_policy,d.compose_project,d.image_ref,d.container_id,d.previous_container_id,d.compose_container_ids,d.previous_compose_container_ids
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
      `SELECT d.id,d.application_id,a.organization_id,a.name AS application_name,d.commit_sha,d.branch,d.state,d.created_at,d.started_at,d.finished_at,d.failure_code,d.cancel_requested_at,d.cancelled_by,d.rollback_of_deployment_id,
              d.requested_by,d.repository_full_name,d.deployment_type,d.source_path,d.container_name,d.container_port,d.host_port,d.restart_policy,d.compose_project,d.image_ref,d.container_id,d.previous_container_id,d.compose_container_ids,d.previous_compose_container_ids
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
