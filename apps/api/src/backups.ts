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
const safeSecretText=(max:number)=>z.string().min(1).max(max).refine(value=>[...value].every(character=>{const code=character.charCodeAt(0);return code>=32&&code!==127;}),'S3 credential contains unsupported control characters');
const s3Secret=z.object({
  endpoint:z.string().trim().url().max(500),
  region:z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/,'S3 region contains unsupported characters'),
  bucket:z.string().trim().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,'S3 bucket is invalid').refine(value=>!value.includes('..'),'S3 bucket is invalid'),
  accessKey:safeSecretText(256).refine(value=>!/[\s]/.test(value),'S3 access key contains whitespace'),
  secretKey:safeSecretText(512),
  sessionToken:z.string().max(4096).refine(value=>[...value].every(character=>{const code=character.charCodeAt(0);return code>=32&&code!==127;}),'S3 session token contains unsupported control characters').optional().default(''),
  prefix:z.string().trim().max(200).regex(/^[A-Za-z0-9._/-]*$/,'S3 prefix contains unsupported characters').refine(value=>!value.startsWith('/')&&!value.endsWith('/')&&!value.includes('//')&&value.split('/').every(segment=>segment!=='.'&&segment!=='..'),'S3 prefix is invalid').optional().default('')
}).strict().superRefine((value,ctx)=>{
  const endpoint=new URL(value.endpoint);
  if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||(endpoint.pathname&&endpoint.pathname!='/')){
    ctx.addIssue({code:'custom',message:'S3 endpoint must not contain credentials, path, query, or fragment',path:['endpoint']});
  }
  const loopback=['localhost','127.0.0.1','::1','[::1]'].includes(endpoint.hostname.toLowerCase());
  if(endpoint.protocol!=='https:'&&!(endpoint.protocol==='http:'&&loopback)){
    ctx.addIssue({code:'custom',message:'S3 endpoint must use HTTPS except for loopback development endpoints',path:['endpoint']});
  }
});
const commonCreate={
  name:z.string().trim().min(1).max(120),
  serverId:uuid,
  retentionCount:z.number().int().min(1).max(100).default(7),
  schedule:backupSchedule.default('manual'),
  targetType:z.enum(['local','s3']).default('local'),
  targetSecretId:uuid.optional()
};
const createBody=z.discriminatedUnion('kind',[
  z.object({...commonCreate,kind:z.literal('directory'),source:directoryPath}).strict(),
  z.object({...commonCreate,kind:z.literal('docker_volume'),source:volumeName}).strict(),
  z.object({...commonCreate,kind:z.enum(['postgres','mysql']),source:databaseName,sourceSecretId:uuid}).strict()
]).superRefine((value,ctx)=>{
  if(value.targetType==='s3'&&!value.targetSecretId)ctx.addIssue({code:'custom',message:'S3 target credentials are required',path:['targetSecretId']});
  if(value.targetType==='local'&&value.targetSecretId)ctx.addIssue({code:'custom',message:'Local backups cannot include S3 target credentials',path:['targetSecretId']});
});

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
export function parseS3BackupSecret(value:string){
  let decoded:unknown;
  try{decoded=JSON.parse(value)}
  catch{throw Object.assign(new Error('S3 backup target secret is invalid'),{statusCode:400})}
  const parsed=s3Secret.safeParse(decoded);
  if(!parsed.success)throw Object.assign(new Error('S3 backup target secret is invalid'),{statusCode:400});
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
            b.next_run_at,b.last_scheduled_at,b.target_secret_id,b.created_by,b.created_at,b.updated_at,s.name AS server_name,s.status AS server_status
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

  let created:{id:string;job_id:string;status:string;started_at:string;created_at:string};
  try{
    created=await transaction(async db=>{
      await db.query('SELECT id FROM backup_jobs WHERE id=$1 FOR UPDATE',[jobId]);
      const restoring=await db.query("SELECT id FROM backup_restores WHERE job_id=$1 AND status='running' LIMIT 1",[jobId]);
      if(restoring.rowCount)throw Object.assign(new Error('Backup job is currently restoring'),{statusCode:409});
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
  }catch(error){
    if((error as {code?:string})?.code==='23505')throw Object.assign(new Error('Backup job is already running'),{statusCode:409});
    throw error;
  }

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
    let s3:z.infer<typeof s3Secret>|undefined;
    if(job.target_type==='s3'){
      if(!job.target_secret_id)throw new Error('S3 backup target secret is missing');
      let plaintext='';
      try{
        plaintext=await readSecretValueForService(job.target_secret_id,job.organization_id);
        s3=parseS3BackupSecret(plaintext);
      }finally{
        plaintext='';
      }
    }
    const raw=await sendAgentCommand(job.server_id,'backup.execute',{
      backupId:created.id,
      kind:job.kind,
      source:job.source,
      targetType:job.target_type,
      database,
      s3
    },30*60_000);
    const result=runResult.parse(raw);
    const completed=await transaction(async db=>{
      const updated=await db.query(
        `UPDATE backups
         SET status='successful',size_bytes=$2,verified_at=now(),finished_at=now(),storage_key=$3,sha256=$4,
             manifest=jsonb_build_object('entryCount',$5,'verification',CASE WHEN $6='s3' THEN 'archive-read+sha256+s3-head' ELSE 'archive-read+sha256' END)
         WHERE id=$1 AND status='running'
         RETURNING id,job_id,status,size_bytes,verified_at,started_at,finished_at,storage_key,sha256,manifest,created_at`,
        [created.id,result.sizeBytes,result.storageKey,result.sha256,result.entryCount,job.target_type]
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
        if(job.target_type==='s3'){
          if(!s3)throw new Error('S3 backup target secret is missing');
          await sendAgentCommand(job.server_id,'backup.deleteS3',{storageKey:row.storage_key,s3},60_000);
        }else{
          await sendAgentCommand(job.server_id,'backup.deleteLocal',{storageKey:row.storage_key});
        }
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
              b.next_run_at,b.last_scheduled_at,b.target_secret_id,b.created_by,b.created_at,b.updated_at,s.name AS server_name,s.status AS server_status,
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
      `SELECT b.id,b.job_id,b.status,b.size_bytes,b.verified_at,b.started_at,b.finished_at,b.storage_key,b.sha256,b.error,b.manifest,b.triggered_by,b.created_at,
              restore.id AS latest_restore_id,restore.status AS latest_restore_status,restore.started_at AS latest_restore_started_at,
              restore.finished_at AS latest_restore_finished_at,restore.error AS latest_restore_error
       FROM backups b
       LEFT JOIN LATERAL (
         SELECT id,status,started_at,finished_at,error
         FROM backup_restores WHERE backup_id=b.id ORDER BY created_at DESC LIMIT 1
       ) restore ON true
       WHERE b.job_id=$1 ORDER BY b.created_at DESC LIMIT 100`,
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
    let targetSecretId:string|null=null;
    if(body.targetType==='s3'){
      const secret=await pool.query(
        'SELECT id FROM secrets WHERE id=$1 AND organization_id=$2 AND kind=$3',
        [body.targetSecretId,orgId,'backup']
      );
      if(!secret.rowCount)throw Object.assign(new Error('S3 backup target secret not found in this workspace'),{statusCode:404});
      let plaintext='';
      try{
        plaintext=await readSecretValueForService(body.targetSecretId!,orgId);
        parseS3BackupSecret(plaintext);
      }finally{
        plaintext='';
      }
      targetSecretId=body.targetSecretId!;
    }
    const nextRunAt=nextBackupRun(body.schedule);
    const created=await transaction(async db=>{
      const result=await db.query(
        `INSERT INTO backup_jobs(organization_id,server_id,name,kind,source,source_secret_id,schedule,retention_count,target_type,target_secret_id,enabled,created_by,next_run_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12)
         RETURNING id,organization_id,server_id,name,kind,source,source_secret_id,schedule,retention_count,target_type,target_secret_id,enabled,next_run_at,created_by,created_at,updated_at`,
        [orgId,body.serverId,body.name,body.kind,body.source,sourceSecretId,body.schedule,body.retentionCount,body.targetType,targetSecretId,userId,nextRunAt]
      );
      await audit(orgId,userId,'backup.job.create','backup_job',result.rows[0].id,request.ip,{
        kind:body.kind,serverId:body.serverId,retentionCount:body.retentionCount,targetType:body.targetType,schedule:body.schedule
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

  app.post('/backups/:backupId/restore',async (request,reply)=>{
    const {userId}=await authenticate(request);
    const {backupId}=z.object({backupId:uuid}).parse(request.params);
    z.object({confirm:z.literal(true)}).strict().parse(request.body);
    const result=await pool.query(
      `SELECT b.id,b.status,b.verified_at,b.storage_key,b.sha256,b.job_id,
              j.organization_id,j.server_id,j.kind,j.source,j.source_secret_id,j.target_type,j.target_secret_id,j.enabled,
              s.status AS server_status
       FROM backups b
       JOIN backup_jobs j ON j.id=b.job_id
       JOIN servers s ON s.id=j.server_id
       WHERE b.id=$1`,
      [backupId]
    );
    if(!result.rowCount)throw Object.assign(new Error('Backup not found'),{statusCode:404});
    const item=result.rows[0];
    await membership(userId,item.organization_id,'backup.manage');
    if(item.status!=='successful'||!item.verified_at||!item.storage_key||!item.sha256)throw Object.assign(new Error('Only verified successful backups can be restored'),{statusCode:409});
    if(item.server_status!=='online')throw Object.assign(new Error('Backup server is offline'),{statusCode:503});

    let restore:{id:string;status:string;started_at:string;created_at:string};
    try{
      restore=await transaction(async db=>{
        await db.query('SELECT id FROM backup_jobs WHERE id=$1 FOR UPDATE',[item.job_id]);
        const runningBackup=await db.query("SELECT id FROM backups WHERE job_id=$1 AND status='running' LIMIT 1",[item.job_id]);
        if(runningBackup.rowCount)throw Object.assign(new Error('Backup job is currently running'),{statusCode:409});
        const created=await db.query(
          `INSERT INTO backup_restores(backup_id,job_id,status,requested_by)
           VALUES($1,$2,'running',$3)
           RETURNING id,status,started_at,created_at`,
          [backupId,item.job_id,userId]
        );
        await audit(item.organization_id,userId,'backup.restore.requested','backup_restore',created.rows[0].id,request.ip,{
          backupId,jobId:item.job_id,kind:item.kind,targetType:item.target_type,serverId:item.server_id
        },db);
        return created.rows[0];
      });
    }catch(error){
      if((error as {code?:string})?.code==='23505')throw Object.assign(new Error('Backup job already has a restore in progress'),{statusCode:409});
      throw error;
    }

    try{
      let s3:z.infer<typeof s3Secret>|undefined;
      if(item.target_type==='s3'){
        if(!item.target_secret_id)throw new Error('S3 backup target secret is missing');
        let targetPlaintext='';
        try{
          targetPlaintext=await readSecretValueForService(item.target_secret_id,item.organization_id);
          s3=parseS3BackupSecret(targetPlaintext);
        }finally{
          targetPlaintext='';
        }
      }

      let raw:unknown;
      if(item.kind==='postgres'||item.kind==='mysql'){
        if(!item.source_secret_id)throw new Error('Database backup source secret is missing');
        let database:z.infer<typeof databaseSecret>;
        let plaintext='';
        try{
          plaintext=await readSecretValueForService(item.source_secret_id,item.organization_id);
          database=parseDatabaseBackupSecret(plaintext);
        }finally{
          plaintext='';
        }
        raw=await sendAgentCommand(item.server_id,'backup.restoreDatabase',{
          backupId:item.id,
          kind:item.kind,
          databaseName:item.source,
          targetType:item.target_type,
          storageKey:item.storage_key,
          expectedSha256:item.sha256,
          database,
          s3
        },30*60_000);
      }else if(item.kind==='directory'||item.kind==='docker_volume'){
        raw=await sendAgentCommand(item.server_id,'backup.restoreFilesystem',{
          backupId:item.id,
          kind:item.kind,
          source:item.source,
          targetType:item.target_type,
          storageKey:item.storage_key,
          expectedSha256:item.sha256,
          s3
        },30*60_000);
      }else{
        throw new Error('Unsupported backup kind for restore');
      }
      const restored=z.object({restored:z.literal(true)}).strict().parse(raw);
      void restored;
      const completed=await transaction(async db=>{
        const updated=await db.query(
          `UPDATE backup_restores SET status='successful',finished_at=now(),error=NULL
           WHERE id=$1 AND status='running'
           RETURNING id,backup_id,job_id,status,started_at,finished_at,error,requested_by,created_at`,
          [restore.id]
        );
        if(!updated.rowCount)throw new Error('Restore state changed unexpectedly');
        await audit(item.organization_id,userId,'backup.restore.completed','backup_restore',restore.id,request.ip,{
          backupId,jobId:item.job_id,kind:item.kind,targetType:item.target_type
        },db);
        return updated.rows[0];
      });
      reply.code(201);
      return completed;
    }catch(error){
      const message=(error instanceof Error?error.message:'Restore failed').slice(0,500);
      await transaction(async db=>{
        await db.query(
          `UPDATE backup_restores SET status='failed',error=$2,finished_at=now()
           WHERE id=$1 AND status='running'`,
          [restore.id,message]
        );
        await audit(item.organization_id,userId,'backup.restore.failed','backup_restore',restore.id,request.ip,{
          backupId,jobId:item.job_id,kind:item.kind,error:message
        },db);
      });
      throw Object.assign(new Error(message),{statusCode:(error as {statusCode?:number})?.statusCode??502});
    }
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
    let s3:z.infer<typeof s3Secret>|undefined;
    if(job.target_type==='s3'){
      if(!job.target_secret_id)throw Object.assign(new Error('S3 backup target secret is missing'),{statusCode:409});
      let plaintext='';
      try{
        plaintext=await readSecretValueForService(job.target_secret_id,job.organization_id);
        s3=parseS3BackupSecret(plaintext);
      }finally{
        plaintext='';
      }
    }
    for(const row of stored.rows as Array<{id:string;storage_key:string}>){
      if(job.target_type==='s3'){
        await sendAgentCommand(job.server_id,'backup.deleteS3',{storageKey:row.storage_key,s3},60_000);
      }else{
        await sendAgentCommand(job.server_id,'backup.deleteLocal',{storageKey:row.storage_key});
      }
    }
    await transaction(async db=>{
      await db.query('DELETE FROM backup_jobs WHERE id=$1',[jobId]);
      await audit(job.organization_id,userId,'backup.job.delete','backup_job',jobId,request.ip,{name:job.name,kind:job.kind,archivesRemoved:stored.rowCount},db);
    });
    return {ok:true};
  });
}
