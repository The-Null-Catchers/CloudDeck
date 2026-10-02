import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool,transaction} from './db.js';
import {authenticate,membership,audit} from './security.js';
import {normalizeDomainHostname} from './domain-tls.js';
import {executeDomainTlsCheck} from './domain-runner.js';
import {sendAgentCommand} from './commands.js';

const uuid=z.uuid();
const proxyType=z.enum(['caddy','nginx']);
const port=z.number().int().min(1).max(65535);
const createBody=z.object({
  applicationId:uuid,
  hostname:z.string().trim().min(3).max(253),
  proxyType,
  targetPort:port.optional(),
  enabled:z.boolean().default(true)
}).strict();
const updateBody=z.object({
  hostname:z.string().trim().min(3).max(253).optional(),
  proxyType:proxyType.optional(),
  targetPort:port.optional(),
  enabled:z.boolean().optional()
}).strict().refine(value=>Object.keys(value).length>0,'At least one field is required');

async function applicationForDomain(applicationId:string,organizationId:string){
  const result=await pool.query(
    `SELECT id,organization_id,server_id,name,deployment_type,host_port,compose_project
     FROM applications
     WHERE id=$1 AND organization_id=$2`,
    [applicationId,organizationId]
  );
  if(!result.rowCount)throw Object.assign(new Error('Application not found in this workspace'),{statusCode:404});
  return result.rows[0] as {
    id:string;
    organization_id:string;
    server_id:string|null;
    name:string;
    deployment_type:'dockerfile'|'compose'|null;
    host_port:number|null;
    compose_project:string|null;
  };
}

export function resolveDomainTargetPort(application:{deployment_type:'dockerfile'|'compose'|null;host_port:number|null},requested:number|undefined){
  if(application.deployment_type==='dockerfile'&&application.host_port){
    if(requested!==undefined&&requested!==application.host_port){
      throw Object.assign(new Error('Dockerfile domains must target the application host port'),{statusCode:400});
    }
    return port.parse(application.host_port);
  }
  if(requested===undefined){
    throw Object.assign(new Error('A target port is required when the application has no configured host port'),{statusCode:400});
  }
  return port.parse(requested);
}

async function managedDomain(domainId:string){
  const result=await pool.query(
    `SELECT d.id,d.hostname,d.proxy_type,d.target_port,d.proxy_status,d.proxy_error,
            a.organization_id,a.server_id,s.status AS server_status
     FROM domains d
     JOIN applications a ON a.id=d.application_id
     LEFT JOIN servers s ON s.id=a.server_id
     WHERE d.id=$1`,
    [domainId]
  );
  if(!result.rowCount)throw Object.assign(new Error('Domain not found'),{statusCode:404});
  return result.rows[0] as {
    id:string;hostname:string;proxy_type:'caddy'|'nginx';target_port:number;
    proxy_status:'unconfigured'|'applied'|'error';proxy_error:string|null;
    organization_id:string;server_id:string|null;server_status:string|null;
  };
}

function requireOnlineDomainServer(domain:{server_id:string|null;server_status:string|null}){
  if(!domain.server_id)throw Object.assign(new Error('Domain application is not assigned to a server'),{statusCode:409});
  if(domain.server_status!=='online')throw Object.assign(new Error('Domain server is offline'),{statusCode:503});
  return domain.server_id;
}

async function withDomainProxyLock<T>(domainId:string,work:()=>Promise<T>){
  const client=await pool.connect();
  let locked=false;
  try{
    const result=await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[domainId]);
    locked=result.rows[0]?.locked===true;
    if(!locked)throw Object.assign(new Error('Another proxy operation is already running for this domain'),{statusCode:409});
    return await work();
  }finally{
    if(locked){
      try{await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[domainId])}
      catch{void 0}
    }
    client.release();
  }
}

async function applyManagedProxyUnlocked(domain:Awaited<ReturnType<typeof managedDomain>>,userId:string,ip:string){
  const serverId=requireOnlineDomainServer(domain);
  try{
    await sendAgentCommand(serverId,'proxy.applyDomain',{
      proxyType:domain.proxy_type,
      hostname:domain.hostname,
      targetPort:domain.target_port
    },45_000);
    const updated=await pool.query(
      `UPDATE domains
       SET proxy_status='applied',proxy_error=NULL,proxy_applied_at=now(),updated_at=now()
       WHERE id=$1
       RETURNING proxy_status,proxy_error,proxy_applied_at`,
      [domain.id]
    );
    await audit(domain.organization_id,userId,'domain.proxy.apply','domain',domain.id,ip,{
      hostname:domain.hostname,proxyType:domain.proxy_type,targetPort:domain.target_port,serverId
    });
    return updated.rows[0];
  }catch(error){
    const message=(error instanceof Error?error.message:'Proxy apply failed').slice(0,500);
    await pool.query(
      `UPDATE domains
       SET proxy_status=CASE WHEN proxy_status='applied' THEN 'applied' ELSE 'error' END,
           proxy_error=$2,updated_at=now()
       WHERE id=$1`,
      [domain.id,message]
    );
    await audit(domain.organization_id,userId,'domain.proxy.apply.failed','domain',domain.id,ip,{
      hostname:domain.hostname,proxyType:domain.proxy_type,error:message
    });
    throw Object.assign(new Error(message),{statusCode:(error as {statusCode?:number})?.statusCode??502});
  }
}

async function removeManagedProxyUnlocked(domain:Awaited<ReturnType<typeof managedDomain>>,userId:string,ip:string){
  const serverId=requireOnlineDomainServer(domain);
  try{
    await sendAgentCommand(serverId,'proxy.removeDomain',{
      proxyType:domain.proxy_type,
      hostname:domain.hostname
    },45_000);
    const updated=await pool.query(
      `UPDATE domains
       SET proxy_status='unconfigured',proxy_error=NULL,proxy_applied_at=NULL,updated_at=now()
       WHERE id=$1
       RETURNING proxy_status,proxy_error,proxy_applied_at`,
      [domain.id]
    );
    await audit(domain.organization_id,userId,'domain.proxy.remove','domain',domain.id,ip,{
      hostname:domain.hostname,proxyType:domain.proxy_type,serverId
    });
    return updated.rows[0];
  }catch(error){
    const message=(error instanceof Error?error.message:'Proxy removal failed').slice(0,500);
    await pool.query(
      `UPDATE domains SET proxy_error=$2,updated_at=now() WHERE id=$1`,
      [domain.id,message]
    );
    await audit(domain.organization_id,userId,'domain.proxy.remove.failed','domain',domain.id,ip,{
      hostname:domain.hostname,proxyType:domain.proxy_type,error:message
    });
    throw Object.assign(new Error(message),{statusCode:(error as {statusCode?:number})?.statusCode??502});
  }
}

export async function domainRoutes(app:FastifyInstance){
  app.get('/organizations/:orgId/domains',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=z.object({orgId:uuid}).parse(request.params);
    await membership(userId,orgId,'domain.read');
    const rows=await pool.query(
      `SELECT d.id,d.application_id,d.hostname,d.proxy_type,d.target_port,d.enabled,d.https_status,
              d.certificate_expires_at,d.certificate_issuer,d.tls_error,d.last_tls_checked_at,d.next_tls_check_at,
              d.proxy_status,d.proxy_error,d.proxy_applied_at,d.created_at,d.updated_at,
              a.name AS application_name,a.server_id,s.name AS server_name,s.status AS server_status,
              alert.id AS alert_id,alert.state AS alert_state
       FROM domains d
       JOIN applications a ON a.id=d.application_id
       LEFT JOIN servers s ON s.id=a.server_id
       LEFT JOIN alerts alert
         ON alert.domain_id=d.id AND alert.kind='ssl_certificate_expiring' AND alert.state IN ('open','acknowledged')
       WHERE a.organization_id=$1
       ORDER BY d.hostname ASC`,
      [orgId]
    );
    return {domains:rows.rows};
  });

  app.post('/organizations/:orgId/domains',async (request,reply)=>{
    const {userId}=await authenticate(request);
    const {orgId}=z.object({orgId:uuid}).parse(request.params);
    const body=createBody.parse(request.body);
    await membership(userId,orgId,'domain.manage');
    const application=await applicationForDomain(body.applicationId,orgId);
    const hostname=normalizeDomainHostname(body.hostname);
    const targetPort=resolveDomainTargetPort(application,body.targetPort);
    let created;
    try{
      created=await pool.query(
        `INSERT INTO domains(application_id,hostname,proxy_type,target_port,enabled,next_tls_check_at)
         VALUES($1,$2,$3,$4,$5,now())
         RETURNING id,application_id,hostname,proxy_type,target_port,enabled,https_status,certificate_expires_at,
                   certificate_issuer,last_tls_checked_at,next_tls_check_at,proxy_status,proxy_error,proxy_applied_at,created_at`,
        [application.id,hostname,body.proxyType,targetPort,body.enabled]
      );
    }catch(error){
      if((error as {code?:string}).code==='23505')throw Object.assign(new Error('This domain is already attached'),{statusCode:409});
      throw error;
    }
    const domain=created.rows[0];
    await audit(orgId,userId,'domain.create','domain',domain.id,request.ip,{
      hostname,proxyType:body.proxyType,targetPort,applicationId:application.id
    });
    reply.code(201);
    return domain;
  });

  app.patch('/domains/:domainId',async request=>{
    const {userId}=await authenticate(request);
    const {domainId}=z.object({domainId:uuid}).parse(request.params);
    const body=updateBody.parse(request.body);
    const current=await pool.query(
      `SELECT d.*,a.organization_id,a.host_port,a.deployment_type
       FROM domains d
       JOIN applications a ON a.id=d.application_id
       WHERE d.id=$1`,
      [domainId]
    );
    if(!current.rowCount)throw Object.assign(new Error('Domain not found'),{statusCode:404});
    const row=current.rows[0];
    await membership(userId,row.organization_id,'domain.manage');
    const hostname=body.hostname===undefined?row.hostname:normalizeDomainHostname(body.hostname);
    const targetPort=body.targetPort===undefined?row.target_port:resolveDomainTargetPort(row,body.targetPort);
    const nextProxyType=body.proxyType??row.proxy_type;
    const enabled=body.enabled??row.enabled;
    const changesManagedProxy=hostname!==row.hostname||targetPort!==row.target_port||nextProxyType!==row.proxy_type;
    if(row.proxy_status==='applied'&&changesManagedProxy){
      throw Object.assign(new Error('Remove the managed proxy configuration before changing hostname, proxy type, or target port'),{statusCode:409});
    }
    let updated;
    try{
      updated=await pool.query(
        `UPDATE domains
         SET hostname=$2,proxy_type=$3,target_port=$4,enabled=$5,
             proxy_status=CASE WHEN $6 THEN 'unconfigured' ELSE proxy_status END,
             proxy_error=CASE WHEN $6 THEN NULL ELSE proxy_error END,
             proxy_applied_at=CASE WHEN $6 THEN NULL ELSE proxy_applied_at END,
             next_tls_check_at=CASE WHEN $5 THEN now() ELSE next_tls_check_at END,
             https_status=CASE WHEN hostname<>$2 THEN 'unknown' ELSE https_status END,
             certificate_expires_at=CASE WHEN hostname<>$2 THEN NULL ELSE certificate_expires_at END,
             certificate_issuer=CASE WHEN hostname<>$2 THEN NULL ELSE certificate_issuer END,
             tls_error=CASE WHEN hostname<>$2 THEN NULL ELSE tls_error END,
             updated_at=now()
         WHERE id=$1
         RETURNING *`,
        [domainId,hostname,nextProxyType,targetPort,enabled,changesManagedProxy]
      );
    }catch(error){
      if((error as {code?:string}).code==='23505')throw Object.assign(new Error('This domain is already attached'),{statusCode:409});
      throw error;
    }
    await audit(row.organization_id,userId,'domain.update','domain',domainId,request.ip,{
      hostname,proxyType:nextProxyType,targetPort,enabled
    });
    return updated.rows[0];
  });

  app.post('/domains/:domainId/proxy/apply',async request=>{
    const {userId}=await authenticate(request);
    const {domainId}=z.object({domainId:uuid}).parse(request.params);
    z.object({confirm:z.literal(true)}).strict().parse(request.body);
    const domain=await managedDomain(domainId);
    await membership(userId,domain.organization_id,'domain.manage');
    return withDomainProxyLock(domain.id,()=>applyManagedProxyUnlocked(domain,userId,request.ip));
  });

  app.post('/domains/:domainId/proxy/remove',async request=>{
    const {userId}=await authenticate(request);
    const {domainId}=z.object({domainId:uuid}).parse(request.params);
    z.object({confirm:z.literal(true)}).strict().parse(request.body);
    const domain=await managedDomain(domainId);
    await membership(userId,domain.organization_id,'domain.manage');
    return withDomainProxyLock(domain.id,()=>removeManagedProxyUnlocked(domain,userId,request.ip));
  });

  app.post('/domains/:domainId/check',async request=>{
    const {userId}=await authenticate(request);
    const {domainId}=z.object({domainId:uuid}).parse(request.params);
    const current=await pool.query(
      `SELECT d.id,d.hostname,a.organization_id,a.server_id
       FROM domains d JOIN applications a ON a.id=d.application_id
       WHERE d.id=$1`,
      [domainId]
    );
    if(!current.rowCount)throw Object.assign(new Error('Domain not found'),{statusCode:404});
    const domain=current.rows[0] as {id:string;hostname:string;organization_id:string;server_id:string|null};
    await membership(userId,domain.organization_id,'domain.manage');
    const result=await executeDomainTlsCheck(domain);
    await pool.query('UPDATE domains SET next_tls_check_at=now()+interval \'6 hours\',updated_at=now() WHERE id=$1',[domainId]);
    await audit(domain.organization_id,userId,'domain.tls.check','domain',domainId,request.ip,{status:result.result.status});
    return result;
  });

  app.delete('/domains/:domainId',async request=>{
    const {userId}=await authenticate(request);
    const {domainId}=z.object({domainId:uuid}).parse(request.params);
    const domain=await managedDomain(domainId);
    await membership(userId,domain.organization_id,'domain.manage');
    return withDomainProxyLock(domain.id,async()=>{
      const latest=await managedDomain(domain.id);
      if(latest.proxy_status==='applied')await removeManagedProxyUnlocked(latest,userId,request.ip);
      await transaction(async db=>{
        await db.query(
          `UPDATE alerts
           SET state='resolved',resolved_at=COALESCE(resolved_at,now())
           WHERE domain_id=$1 AND state IN ('open','acknowledged')`,
          [domainId]
        );
        await db.query('DELETE FROM domains WHERE id=$1',[domainId]);
        await audit(domain.organization_id,userId,'domain.delete','domain',domainId,request.ip,{
          hostname:domain.hostname,proxyType:domain.proxy_type
        },db);
      });
      return {ok:true};
    });
  });
}
