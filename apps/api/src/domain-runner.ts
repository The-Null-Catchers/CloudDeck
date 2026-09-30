import {transaction} from './db.js';
import {certificateDaysRemaining,probeDomainTls,type DomainTlsProbe} from './domain-tls.js';
import {createOrganizationNotifications} from './notification-service.js';

type DueDomain={
  id:string;
  hostname:string;
  organization_id:string;
  server_id:string|null;
};

function warningDays(){
  const configured=Number(process.env.SSL_EXPIRY_WARNING_DAYS??14);
  return Number.isFinite(configured)?Math.max(1,Math.min(90,Math.trunc(configured))):14;
}

export async function claimDueDomainTlsChecks(limit=20){
  const bounded=Math.max(1,Math.min(100,Math.trunc(limit)));
  return transaction(async db=>{
    const result=await db.query(
      `WITH due AS (
         SELECT d.id
         FROM domains d
         WHERE d.enabled=true AND d.next_tls_check_at<=now()
         ORDER BY d.next_tls_check_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE domains d
       SET next_tls_check_at=now()+interval '6 hours',updated_at=now()
       FROM due,applications a
       WHERE d.id=due.id AND a.id=d.application_id
       RETURNING d.id,d.hostname,a.organization_id,a.server_id`,
      [bounded]
    );
    return result.rows as DueDomain[];
  });
}

export async function persistDomainTlsResult(domain:DueDomain,result:DomainTlsProbe){
  return transaction(async db=>{
    await db.query(
      `UPDATE domains
       SET https_status=$2,certificate_expires_at=$3,certificate_issuer=$4,tls_error=$5,
           last_tls_checked_at=now(),updated_at=now()
       WHERE id=$1`,
      [domain.id,result.status,result.certificateExpiresAt,result.certificateIssuer,result.error]
    );
    const days=certificateDaysRemaining(result.certificateExpiresAt);
    const shouldAlert=result.status==='valid'&&days!==null&&days<=warningDays();
    if(shouldAlert){
      const opened=await db.query(
        `INSERT INTO alerts(organization_id,server_id,domain_id,kind,state)
         VALUES($1,$2,$3,'ssl_certificate_expiring','open')
         ON CONFLICT(domain_id,kind) WHERE domain_id IS NOT NULL AND state IN ('open','acknowledged')
         DO NOTHING
         RETURNING id`,
        [domain.organization_id,domain.server_id,domain.id]
      );
      if(opened.rowCount){
        await createOrganizationNotifications(domain.organization_id,{
          alertId:opened.rows[0].id as string,
          type:'ssl_certificate_expiring',
          title:`TLS certificate expiring: ${domain.hostname}`,
          body:`The certificate expires in ${days} day${days===1?'':'s'}.`,
          href:'/domains'
        },db);
      }
      return {alertOpened:Boolean(opened.rowCount),alertResolved:false,daysRemaining:days};
    }
    if(result.status==='valid'&&days!==null&&days>warningDays()){
      const resolved=await db.query(
        `UPDATE alerts
         SET state='resolved',resolved_at=now()
         WHERE domain_id=$1 AND kind='ssl_certificate_expiring' AND state IN ('open','acknowledged')
         RETURNING id`,
        [domain.id]
      );
      for(const row of resolved.rows){
        await createOrganizationNotifications(domain.organization_id,{
          alertId:row.id as string,
          type:'ssl_certificate_recovered',
          title:`TLS certificate healthy: ${domain.hostname}`,
          body:`The certificate now has ${days} days remaining.`,
          href:'/domains'
        },db);
      }
      return {alertOpened:false,alertResolved:Boolean(resolved.rowCount),daysRemaining:days};
    }
    return {alertOpened:false,alertResolved:false,daysRemaining:days};
  });
}

export async function executeDomainTlsCheck(domain:DueDomain){
  const result=await probeDomainTls(domain.hostname);
  const persisted=await persistDomainTlsResult(domain,result);
  return {result,...persisted};
}

export async function runDueDomainTlsChecks(limit=20){
  const domains=await claimDueDomainTlsChecks(limit);
  const results=await Promise.allSettled(domains.map(domain=>executeDomainTlsCheck(domain)));
  return {
    claimed:domains.length,
    completed:results.filter(result=>result.status==='fulfilled').length,
    failed:results.filter(result=>result.status==='rejected').length
  };
}

export function startDomainTlsRunner(intervalMs=60_000){
  const delay=Math.max(15_000,intervalMs);
  let running=false;
  const run=async()=>{
    if(running)return;
    running=true;
    try{await runDueDomainTlsChecks()}catch{void 0}finally{running=false}
  };
  void run();
  const timer=setInterval(()=>void run(),delay);
  timer.unref();
  return ()=>clearInterval(timer);
}
