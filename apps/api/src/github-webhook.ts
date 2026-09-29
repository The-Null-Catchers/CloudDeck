import {createHmac,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool,transaction} from './db.js';
import {audit} from './security.js';
import {verifyGitHubCommitSource} from './github.js';
import {enqueueDeployment} from './deployment-queue.js';

const deliveryIdSchema=z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/);
const sha=z.string().regex(/^[a-f0-9]{40}$/i);
const pushPayload=z.object({
  ref:z.string().min(1).max(500),
  after:sha,
  deleted:z.boolean().optional().default(false),
  repository:z.object({full_name:z.string().min(3).max(201)}).passthrough(),
  installation:z.object({id:z.number().int().positive()}).passthrough()
}).passthrough();

function webhookSecret(){
  const value=process.env.GITHUB_WEBHOOK_SECRET;
  if(!value||Buffer.byteLength(value)<32)throw Object.assign(new Error('GitHub webhook secret is not configured'),{statusCode:503});
  return value;
}

export function verifyGitHubWebhookSignature(raw:Buffer,signature:unknown,secret=webhookSecret()){
  if(typeof signature!=='string'||!/^sha256=[a-f0-9]{64}$/i.test(signature))return false;
  const supplied=Buffer.from(signature.slice(7),'hex');
  const expected=createHmac('sha256',secret).update(raw).digest();
  return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
}

function deploymentKey(deliveryId:string){
  return `github-push:${deliveryId}`;
}

async function recordDelivery(deliveryId:string,eventName:string,installationId:number|null,repositoryFullName:string|null){
  await pool.query(
    `INSERT INTO github_webhook_deliveries(delivery_id,event_name,installation_id,repository_full_name,processed_at)
     VALUES($1,$2,$3,$4,now())
     ON CONFLICT(delivery_id) DO NOTHING`,
    [deliveryId,eventName,installationId,repositoryFullName]
  );
}

export async function githubWebhookRoutes(app:FastifyInstance){
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    {parseAs:'buffer',bodyLimit:512*1024},
    (_request,body,done)=>done(null,body)
  );

  app.post('/github',async (request,reply)=>{
    const raw=request.body;
    if(!Buffer.isBuffer(raw))throw Object.assign(new Error('Webhook body must be raw JSON'),{statusCode:400});
    if(!verifyGitHubWebhookSignature(raw,request.headers['x-hub-signature-256'])){
      throw Object.assign(new Error('Invalid GitHub webhook signature'),{statusCode:401});
    }

    const eventName=z.string().min(1).max(100).parse(request.headers['x-github-event']);
    const deliveryId=deliveryIdSchema.parse(request.headers['x-github-delivery']);
    const duplicate=await pool.query('SELECT 1 FROM github_webhook_deliveries WHERE delivery_id=$1',[deliveryId]);
    if(duplicate.rowCount){
      reply.code(202);
      return {accepted:true,duplicate:true};
    }

    if(eventName!=='push'){
      await recordDelivery(deliveryId,eventName,null,null);
      reply.code(202);
      return {accepted:true,ignored:true};
    }

    let payload:unknown;
    try{payload=JSON.parse(raw.toString('utf8'));}catch{
      throw Object.assign(new Error('Invalid GitHub webhook JSON'),{statusCode:400});
    }
    const push=pushPayload.parse(payload);
    const prefix='refs/heads/';
    if(push.deleted||!push.ref.startsWith(prefix)||/^0{40}$/.test(push.after)){
      await recordDelivery(deliveryId,eventName,push.installation.id,push.repository.full_name);
      reply.code(202);
      return {accepted:true,ignored:true};
    }
    const branch=push.ref.slice(prefix.length);
    if(!branch||branch.length>255){
      await recordDelivery(deliveryId,eventName,push.installation.id,push.repository.full_name);
      reply.code(202);
      return {accepted:true,ignored:true};
    }

    const applications=await pool.query(
      `SELECT a.id,a.organization_id,a.server_id,a.github_installation_id,a.repository_full_name,a.branch,a.deployment_type,a.source_path,
              a.container_name,a.container_port,a.host_port,a.restart_policy,a.compose_project
       FROM applications a
       JOIN github_installations g ON g.id=a.github_installation_id
       WHERE a.auto_deploy=true
         AND g.installation_id=$1
         AND lower(a.repository_full_name)=lower($2)
         AND a.branch=$3
       ORDER BY a.id`,
      [push.installation.id,push.repository.full_name,branch]
    );

    const deployments:string[]=[];
    const skipped:string[]=[];
    for(const appRow of applications.rows){
      let source;
      try{
        source=await verifyGitHubCommitSource(
          appRow.organization_id,
          appRow.github_installation_id,
          appRow.repository_full_name,
          push.after,
          appRow.source_path
        );
      }catch(error){
        const status=(error as {statusCode?:number}).statusCode;
        if(status===400||status===404){
          const reason=error instanceof Error?error.message:'Source verification failed';
          skipped.push(appRow.id);
          await audit(appRow.organization_id,null,'application.auto_deploy.skipped','application',appRow.id,request.ip,{
            deliveryId,
            repository:push.repository.full_name,
            branch,
            commitSha:push.after,
            reason:reason.slice(0,200)
          });
          continue;
        }
        throw error;
      }

      const created=await transaction(async db=>{
        const inserted=await db.query(
          `INSERT INTO deployments(
             application_id,commit_sha,branch,state,requested_by,idempotency_key,
             github_installation_id,repository_full_name,deployment_type,source_path,
             container_name,container_port,host_port,restart_policy,compose_project
           )
           VALUES($1,$2,$3,'queued',NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT(application_id,idempotency_key) WHERE idempotency_key IS NOT NULL
           DO NOTHING
           RETURNING id`,
          [
            appRow.id,
            source.commitSha,
            appRow.branch,
            deploymentKey(deliveryId),
            source.connectionId,
            appRow.repository_full_name,
            appRow.deployment_type,
            source.sourcePath,
            appRow.container_name,
            appRow.container_port,
            appRow.host_port,
            appRow.restart_policy,
            appRow.compose_project
          ]
        );
        if(!inserted.rowCount){
          const existing=await db.query(
            'SELECT id FROM deployments WHERE application_id=$1 AND idempotency_key=$2',
            [appRow.id,deploymentKey(deliveryId)]
          );
          return {id:existing.rows[0]?.id as string|undefined,created:false};
        }
        const deploymentId=inserted.rows[0].id as string;
        await db.query(
          `INSERT INTO deployment_events(deployment_id,state,message)
           VALUES($1,'queued','GitHub push matched auto-deploy configuration')`,
          [deploymentId]
        );
        await audit(appRow.organization_id,null,'deployment.auto_deploy.requested','deployment',deploymentId,request.ip,{
          deliveryId,
          applicationId:appRow.id,
          repository:push.repository.full_name,
          branch,
          commitSha:push.after
        },db);
        return {id:deploymentId,created:true};
      });
      if(!created.id)throw new Error('Auto-deploy idempotency lookup failed');
      deployments.push(created.id);
      try{
        await enqueueDeployment(created.id);
      }catch{
        if(created.created){
          await pool.query(
            `INSERT INTO deployment_events(deployment_id,state,message)
             VALUES($1,'queued','Queue dispatch pending; automatic reconciliation will retry')`,
            [created.id]
          );
        }
      }
    }

    await recordDelivery(deliveryId,eventName,push.installation.id,push.repository.full_name);
    reply.code(202);
    return {accepted:true,deployments,skipped};
  });
}
