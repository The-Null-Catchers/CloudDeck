import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {z} from 'zod';
import {pool,transaction} from './db.js';
import {authenticate,membership} from './security.js';

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

export async function deploymentRoutes(app:FastifyInstance){
  app.get('/organizations/:orgId/deployments',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=z.object({orgId:uuid}).parse(request.params);
    const {limit}=listQuery.parse(request.query);
    await membership(userId,orgId,'deployment.read');
    const rows=await pool.query(
      `SELECT d.id,d.application_id,a.name AS application_name,d.commit_sha,d.branch,d.state,d.created_at,d.started_at,d.finished_at,d.failure_code,d.rollback_of_deployment_id
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
      `SELECT d.id,d.application_id,a.organization_id,a.name AS application_name,d.commit_sha,d.branch,d.state,d.created_at,d.started_at,d.finished_at,d.failure_code,d.rollback_of_deployment_id
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
