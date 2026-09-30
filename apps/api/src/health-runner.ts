import {transaction} from './db.js';
import {probeHealthTarget,type HealthKind,type HealthProbeResult} from './health-probe.js';
import {createOrganizationNotifications} from './notification-service.js';

type DueCheck={
  id:string;
  organization_id:string;
  server_id:string|null;
  name:string;
  kind:HealthKind;
  target:string;
  interval_seconds:number;
  timeout_seconds:number;
  expected_status:number|null;
  failure_threshold:number;
};

export async function claimDueHealthChecks(limit=20){
  const bounded=Math.max(1,Math.min(100,Math.trunc(limit)));
  return transaction(async db=>{
    const result=await db.query(
      `WITH due AS (
         SELECT id
         FROM health_checks
         WHERE enabled=true AND next_check_at<=now()
         ORDER BY next_check_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE health_checks h
       SET next_check_at=now()+(h.interval_seconds::text||' seconds')::interval
       FROM due
       WHERE h.id=due.id
       RETURNING h.id,h.organization_id,h.server_id,h.name,h.kind,h.target,
                 h.interval_seconds,h.timeout_seconds,h.expected_status,h.failure_threshold`,
      [bounded]
    );
    return result.rows as DueCheck[];
  });
}

export async function persistHealthResult(check:DueCheck,result:HealthProbeResult){
  return transaction(async db=>{
    await db.query(
      `INSERT INTO health_check_results(health_check_id,success,response_ms,status_code,error)
       VALUES($1,$2,$3,$4,$5)`,
      [check.id,result.success,result.responseMs,result.statusCode,result.error]
    );
    const updated=await db.query(
      `UPDATE health_checks
       SET last_checked_at=now(),
           last_success_at=CASE WHEN $2 THEN now() ELSE last_success_at END,
           consecutive_failures=CASE WHEN $2 THEN 0 ELSE consecutive_failures+1 END
       WHERE id=$1
       RETURNING consecutive_failures`,
      [check.id,result.success]
    );
    const failures=Number(updated.rows[0]?.consecutive_failures??0);
    if(result.success){
      const resolved=await db.query(
        `UPDATE alerts
         SET state='resolved',resolved_at=now()
         WHERE health_check_id=$1 AND state IN ('open','acknowledged')
         RETURNING id`,
        [check.id]
      );
      for(const row of resolved.rows){
        await createOrganizationNotifications(check.organization_id,{alertId:row.id as string,type:'health_check_recovered',title:`Recovered: ${check.name}`,body:`${check.target} is responding normally again.`,href:'/alerts'},db);
      }
      return {failures,alertOpened:false,alertResolved:Boolean(resolved.rowCount)};
    }
    if(failures>=check.failure_threshold){
      const opened=await db.query(
        `INSERT INTO alerts(organization_id,server_id,health_check_id,kind,state)
         VALUES($1,$2,$3,'health_check_failed','open')
         ON CONFLICT(health_check_id) WHERE health_check_id IS NOT NULL AND state IN ('open','acknowledged')
         DO NOTHING
         RETURNING id`,
        [check.organization_id,check.server_id,check.id]
      );
      if(opened.rowCount){
        await createOrganizationNotifications(check.organization_id,{alertId:opened.rows[0].id as string,type:'health_check_failed',title:`Health check failed: ${check.name}`,body:result.error??`${check.target} failed its configured health check.`,href:'/alerts'},db);
      }
      return {failures,alertOpened:Boolean(opened.rowCount),alertResolved:false};
    }
    return {failures,alertOpened:false,alertResolved:false};
  });
}

export async function executeHealthCheck(check:DueCheck){
  const result=await probeHealthTarget(check.kind,check.target,check.timeout_seconds,check.expected_status);
  const persisted=await persistHealthResult(check,result);
  return {result,...persisted};
}

export async function runDueHealthChecks(limit=20){
  const checks=await claimDueHealthChecks(limit);
  const results=await Promise.allSettled(checks.map(check=>executeHealthCheck(check)));
  return {
    claimed:checks.length,
    completed:results.filter(result=>result.status==='fulfilled').length,
    failed:results.filter(result=>result.status==='rejected').length
  };
}

export function startHealthCheckRunner(intervalMs=5_000){
  const delay=Math.max(2_000,intervalMs);
  let running=false;
  const run=async()=>{
    if(running)return;
    running=true;
    try{await runDueHealthChecks();}catch{void 0}finally{running=false}
  };
  void run();
  const timer=setInterval(()=>void run(),delay);
  timer.unref();
  return ()=>clearInterval(timer);
}
