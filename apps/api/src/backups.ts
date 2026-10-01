import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool,transaction} from './db.js';
import {authenticate,membership,audit} from './security.js';
import {sendAgentCommand} from './commands.js';
import {readSecretValueForService} from './secrets.js';

const uuid=z.uuid();
export const backupSchedule=z.enum(['manual','hourly','daily','weekly']);
export type BackupSchedule=z.infer<typeof backupSchedule>;
const volumeName=z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const directoryPath=z.string().trim().min(1).max(500).regex(/^\//,'Directory source must be an absolute path');
const databaseName=z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/,'Database name contains unsupported characters');
const databaseSecret=z.object({
  host:z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9_.:-]+$/,'Database host contains unsupported characters'),
  port:z.number().int().min(1).max(65535),
  username:z.string().min(1).max(128).refine(value=>!/[\s]/.test(value)&&[...value].every(character=>{const code=character.charCodeAt(0);return code>=32&&code!==127;}),'Database username contains unsupported characters'),
  password:z.string().min(1).max(4096).refine(value=>[...value].every(character=>![0,10,13].includes(character.charCodeAt(0))),'Database password contains unsupported control characters'),
  sslMode:z.enum(['disable','require']).default('require')
}).strict();
const commonCreate={
  name:z.string().trim().min(1).max(120),
  serverId:uuid,
  retentionCount:z.number().int().min(1).max(100).default(7),
  schedule:backupSchedule.default('manual')
};
const createBody=z.discriminatedUnion('kind',[
  z.object({...commonCreate,kind:z.literal('directory'),source:directoryPath}).strict(),
  z.object({...commonCreate,kind:z.literal('docker_volume'),source:volumeName}).strict(),
  z.object({...commonCreate,kind:z.enum(['postgres','mysql']),source:databaseName,sourceSecretId:uuid}).strict()
]);

export function nextBackupRun(schedule:BackupSchedule,from=new Date()){
  if(schedule==='manual')return null;
  const next=new Date(from);
  if(schedule==='hourly')next.setUTCHours(next.getUTCHours()+1);
  if(schedule==='daily')next.setUTCDate(next.getUTCDate()+1);
  if(schedule==='weekly')next.setUTCDate(next.getUTCDate()+7);
  return next;
}

export function parseDatabaseBackupSecret(value:string){
  let decoded:unknown;
  try{decoded=JSON.parse(value)}
  catch{throw Object.assign(new Error('Database backup source secret is invalid'),{statusCode:400})}
  const parsed=databaseSecret.safeParse(decoded);
  if(!parsed.success)throw Object.assign(new Error('Database backup source secret is invalid'),{statusCode:400});
  return parsed.data;
}

const runResult=z.object({
  storageKey:z.string().min(1).max(500),
  sizeBytes:z.number().int().nonnegative(),
  sha256:z.string().regex(/^[a-f0-9]{64}$/),
  verified:z.literal(true),
  entryCount:z.number().int().nonnegative()
}).strict();

async function backupJob(jobId:string){
  const result=await pool.query(
    `SELECT b.id,b.organization_id,b.server_id,b.name,b.kind,b.source,b.source_secret_id,b.schedule,b.retention_count,b.target_type,b.enabled,
            b.next_run_at,b.last_scheduled_at,b.created_by,b.created_at,b.updated_at,s.name AS server_name,s.status AS server_status
     FROM backup_jobs b JOIN servers s ON s.id=b.server_id
     WHERE b.id=$1`,
    [jobId]
  );
  if(!result.rowCount)throw Object.assign(new Error('Backup job not found'),{statusCode:404});
  return result.rows[0];
}

type BackupTrigger={actorId:string|null;ip:string;trigger:'manual'|'schedule'};

export async function executeBackupJob(jobId:string,trigger:BackupTrigger){
  const job=await backupJob(jobId);
  if(!job.enabled)throw Object.assign(new Error('Backup job is disabled'),{statusCode:409});
  if(job.server_status!=='online')throw Object.assign(new Error('Backup server is offline'),{statusCode:503});

  const running=await pool.query("SELECT id FROM backups WHERE job_id=$1 AND status='running' LIMIT 1",[jobId]);
  if(running.rowCount)throw Object.assign(new Error('Backup job is already running'),{statusCode:409});

  const created=await transaction(async db=>{
    const result=await db.query(
      `INSERT INTO backups(job_id,status,started_at,triggered_by)
       VALUES($1,'running',now(),$2)
       RETURNING id,job_id,status,started_at,created_at`,
      [jobId,trigger.actorId]
    );
    await audit(job.organization_id,trigger.actorId,'backup.run.requested','backup',result.rows[0].id,trigger.ip,{
      jobId,kind:job.kind,serverId:job.server_id,targetType:job.target_type,trigger:trigger.trigger
    },db);
    return result.rows[0];
  });

  try{
    let database:z.infer<typeof databaseSecret>|undefined;
    if(job.kind==='postgres'||job.kind==='mysql'){
      if(!job.source_secret_id)throw new Error('Database backup source secret is missing');
      let plaintext='';
      try{
        plaintext=await readSecretValueForService(job.source_secret_id,job.organization_id);
        database=parseDatabaseBackupSecret(plaintext);
      }finally{
        plaintext='';
      }
    }
    const raw=await sendAgentCommand(job.server_id,'backup.execute',{
      backupId:created.id,
      kind:job.kind,
      source:job.source,
      targetType:'local',
      database
    },30*60_000);
    const result=runResult.parse(raw);
    const completed=await transaction(async db=>{
      const updated=await db.query(
        `UPDATE backups
         SET status='successful',size_bytes=$2,verified_at=now(),finished_at=now(),storage_key=$3,sha256=$4,
             manifest=jsonb_build_object('entryCount',$5,'verification','archive-read+sha256')
         WHERE id=$1 AND status='running'
         RETURNING id,job_id,status,size_bytes,verified_at,started_at,finished_at,storage_key,sha256,manifest,created_at`,
        [created.id,result.sizeBytes,result.storageKey,result.sha256,result.entryCount]
      );
      if(!updated.rowCount)throw new Error('Backup state changed unexpectedly');
      await audit(job.organization_id,trigger.actorId,'backup.run.completed','backup',created.id,trigger.ip,{
        jobId,sizeBytes:result.sizeBytes,sha256:result.sha256,storageKey:result.storageKey,trigger:trigger.trigger
      },db);
      return updated.rows[0];
    });
    const stale=await pool.query(
      `SELECT id,storage_key
       FROM backups
       WHERE job_id=$1 AND status='successful' AND storage_key IS NOT NULL
       ORDER BY created_at DESC
       OFFSET $2`,
      [jobId,job.retention_count]
    );
    for(const row of stale.rows as Array<{id:string;storage_key:string}>){
      try{
        await sendAgentCommand(job.server_id,'backup.deleteLocal',{storageKey:row.storage_key});
        await pool.query('DELETE FROM backups WHERE id=$1',[row.id]);
      }catch(error){void error}
    }
    return completed;
  }catch(error){
    const message=(error instanceof Error?error.message:'Backup failed').slice(0,500);
    await transaction(async db=>{
      await db.query(
        `UPDATE backups SET status='failed',error=$2,finished_at=now() WHERE id=$1 AND status='running'`,
        [created.id,message]
      );
      await audit(job.organization_id,trigger.actorId,'backup.run.failed','backup',created.id,trigger.ip,{jobId,error:message,trigger:trigger.trigger},db);
    });
    throw Object.assign(new Error(message),{statusCode:(error as {statusCode?:number})?.statusCode??502});
  }
}

export async function backupRoutes(app:FastifyInstance){
  app.get('/organizations/:orgId/backup-jobs',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=z.object({orgId:uuid}).parse(request.params);
    await membership(userId,orgId,'backup.read');
    const jobs=await pool.query(
      `SELECT b.id,b.organization_id,b.server_id,b.name,b.kind,b.source,b.source_secret_id,b.schedule,b.retention_count,b.target_type,b.enabled,
              b.next_run_at,b.last_scheduled_at,b.created_by,b.created_at,b.updated_at,s.name AS server_name,s.status AS server_status,
              latest.id AS latest_backup_id,latest.status AS latest_backup_status,latest.size_bytes AS latest_backup_size,
              latest.verified_at AS latest_verified_at,latest.created_at AS latest_backup_created_at
       FROM backup_jobs b
       JOIN servers s ON s.id=b.server_id
       LEFT JOIN LATERAL (
         SELECT id,status,size_bytes,verified_at,created_at
         FROM backups WHERE job_id=b.id ORDER BY created_at DESC LIMIT 1
       ) latest ON true
       WHERE b.organization_id=$1
       ORDER BY b.created_at DESC`,
      [orgId]
    );
    return {jobs:jobs.rows};
  });

  app.get('/backup-jobs/:jobId/backups',async request=>{
    const {userId}=await authenticate(request);
    const {jobId}=z.object({jobId:uuid}).parse(request.params);
    const job=await backupJob(jobId);
    await membership(userId,job.organization_id,'backup.read');
    const result=await pool.query(
      `SELECT id,job_id,status,size_bytes,verified_at,started_at,finished_at,storage_key,sha256,error,manifest,triggered_by,created_at
       FROM backups WHERE job_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [jobId]
    );
    return {backups:result.rows};
  });

  app.post('/organizations/:orgId/backup-jobs',async (request,reply)=>{
    const {userId}=await authenticate(request);
    const {orgId}=z.object({orgId:uuid}).parse(request.params);
    const body=createBody.parse(request.body);
    await membership(userId,orgId,'backup.manage');
    const server=await pool.query('SELECT id FROM servers WHERE id=$1 AND organization_id=$2',[body.serverId,orgId]);
    if(!server.rowCount)throw Object.assign(new Error('Server not found in this workspace'),{statusCode:404});
    let sourceSecretId:string|null=null;
    if(body.kind==='postgres'||body.kind==='mysql'){
      const secret=await pool.query(
        'SELECT id FROM secrets WHERE id=$1 AND organization_id=$2 AND kind=$3',
        [body.sourceSecretId,orgId,'backup']
      );
      if(!secret.rowCount)throw Object.assign(new Error('Backup source secret not found in this workspace'),{statusCode:404});
      sourceSecretId=body.sourceSecretId;
    }
    const nextRunAt=nextBackupRun(body.schedule);
    const created=await transaction(async db=>{
      const result=await db.query(
        `INSERT INTO backup_jobs(organization_id,server_id,name,kind,source,source_secret_id,schedule,retention_count,target_type,enabled,created_by,next_run_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'local',true,$9,$10)
         RETURNING id,organization_id,server_id,name,kind,source,source_secret_id,schedule,retention_count,target_type,enabled,next_run_at,created_by,created_at,updated_at`,
        [orgId,body.serverId,body.name,body.kind,body.source,sourceSecretId,body.schedule,body.retentionCount,userId,nextRunAt]
      );
      await audit(orgId,userId,'backup.job.create','backup_job',result.rows[0].id,request.ip,{
        kind:body.kind,serverId:body.serverId,retentionCount:body.retentionCount,targetType:'local',schedule:body.schedule
      },db);
      return result.rows[0];
    });
    reply.code(201);
    return created;
  });

  app.post('/backup-jobs/:jobId/run',async (request,reply)=>{
    const {userId}=await authenticate(request);
    const {jobId}=z.object({jobId:uuid}).parse(request.params);
    const job=await backupJob(jobId);
    await membership(userId,job.organization_id,'backup.manage');
    const completed=await executeBackupJob(jobId,{actorId:userId,ip:request.ip,trigger:'manual'});
    reply.code(201);
    return completed;
  });

  app.delete('/backup-jobs/:jobId',async request=>{
    const {userId}=await authenticate(request);
    const {jobId}=z.object({jobId:uuid}).parse(request.params);
    const body=z.object({confirm:z.literal(true)}).strict().parse(request.body);
    void body;
    const job=await backupJob(jobId);
    await membership(userId,job.organization_id,'backup.manage');
    const stored=await pool.query(
      `SELECT id,storage_key FROM backups WHERE job_id=$1 AND storage_key IS NOT NULL ORDER BY created_at ASC`,
      [jobId]
    );
    for(const row of stored.rows as Array<{id:string;storage_key:string}>){
      await sendAgentCommand(job.server_id,'backup.deleteLocal',{storageKey:row.storage_key});
    }
    await transaction(async db=>{
      await db.query('DELETE FROM backup_jobs WHERE id=$1',[jobId]);
      await audit(job.organization_id,userId,'backup.job.delete','backup_job',jobId,request.ip,{name:job.name,kind:job.kind,archivesRemoved:stored.rowCount},db);
    });
    return {ok:true};
  });
}
