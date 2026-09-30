import {randomUUID} from 'node:crypto';
import {pool} from './db.js';

export const deploymentLeaseTtlMs=120_000;
export const deploymentLeaseHeartbeatMs=30_000;

export async function acquireDeploymentLease(applicationId:string,deploymentId:string){
  const leaseToken=randomUUID();
  const result=await pool.query(
    `INSERT INTO deployment_execution_leases(application_id,deployment_id,lease_token,expires_at)
     VALUES($1,$2,$3,now()+($4::text||' milliseconds')::interval)
     ON CONFLICT(application_id) DO UPDATE
       SET deployment_id=EXCLUDED.deployment_id,
           lease_token=EXCLUDED.lease_token,
           acquired_at=now(),
           updated_at=now(),
           expires_at=EXCLUDED.expires_at
     WHERE deployment_execution_leases.expires_at<=now()
     RETURNING lease_token`,
    [applicationId,deploymentId,leaseToken,deploymentLeaseTtlMs]
  );
  return result.rowCount?leaseToken:null;
}

export async function renewDeploymentLease(applicationId:string,deploymentId:string,leaseToken:string){
  const result=await pool.query(
    `UPDATE deployment_execution_leases
     SET updated_at=now(),expires_at=now()+($4::text||' milliseconds')::interval
     WHERE application_id=$1 AND deployment_id=$2 AND lease_token=$3
     RETURNING application_id`,
    [applicationId,deploymentId,leaseToken,deploymentLeaseTtlMs]
  );
  return Boolean(result.rowCount);
}

export async function releaseDeploymentLease(applicationId:string,deploymentId:string,leaseToken:string){
  const result=await pool.query(
    `DELETE FROM deployment_execution_leases
     WHERE application_id=$1 AND deployment_id=$2 AND lease_token=$3`,
    [applicationId,deploymentId,leaseToken]
  );
  return Boolean(result.rowCount);
}

export function startDeploymentLeaseHeartbeat(
  applicationId:string,
  deploymentId:string,
  leaseToken:string,
  onLost:()=>void|Promise<void>
){
  let stopped=false;
  let running=false;
  let lost=false;
  const check=async()=>{
    if(stopped||running||lost)return;
    running=true;
    try{
      const valid=await renewDeploymentLease(applicationId,deploymentId,leaseToken);
      if(!valid){
        lost=true;
        await onLost();
      }
    }catch{
      lost=true;
      await onLost();
    }finally{running=false}
  };
  const timer=setInterval(()=>void check(),deploymentLeaseHeartbeatMs);
  timer.unref();
  return ()=>{
    stopped=true;
    clearInterval(timer);
  };
}
