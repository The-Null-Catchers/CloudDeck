import {pool} from './db.js';
import {executeBackupJob,nextBackupRun,backupSchedule} from './backups.js';

const INTERVAL_MS=30_000;
const CLAIM_LIMIT=10;

export async function runDueBackupJobs(now=new Date()){
  const due=await pool.query(
    `WITH candidates AS (
       SELECT id
       FROM backup_jobs
       WHERE enabled=true
         AND schedule<>'manual'
         AND next_run_at IS NOT NULL
         AND next_run_at <= $1
       ORDER BY next_run_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $2
     )
     UPDATE backup_jobs b
     SET last_scheduled_at=$1,
         next_run_at=CASE b.schedule
           WHEN 'hourly' THEN $1 + interval '1 hour'
           WHEN 'daily' THEN $1 + interval '1 day'
           WHEN 'weekly' THEN $1 + interval '7 days'
           ELSE NULL
         END,
         updated_at=now()
     FROM candidates
     WHERE b.id=candidates.id
     RETURNING b.id,b.schedule`,
    [now,CLAIM_LIMIT]
  );
  for(const row of due.rows as Array<{id:string;schedule:string}>){
    const schedule=backupSchedule.parse(row.schedule);
    if(schedule==='manual')continue;
    try{
      await executeBackupJob(row.id,{actorId:null,ip:'scheduler',trigger:'schedule'});
    }catch(error){
      void error;
    }
  }
  return due.rowCount??0;
}

export function startBackupRunner(){
  let stopped=false;
  let running=false;
  const tick=async()=>{
    if(stopped||running)return;
    running=true;
    try{await runDueBackupJobs()}
    finally{running=false}
  };
  void tick();
  const timer=setInterval(()=>void tick(),INTERVAL_MS);
  timer.unref?.();
  return ()=>{stopped=true;clearInterval(timer)};
}

export function scheduleNextRun(schedule:unknown,from=new Date()){
  return nextBackupRun(backupSchedule.parse(schedule),from);
}
