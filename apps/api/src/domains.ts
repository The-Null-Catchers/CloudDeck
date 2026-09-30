import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.js';
import {authenticate,membership,audit} from './security.js';
import {normalizeDomainHostname} from './domain-tls.js';
import {executeDomainTlsCheck} from './domain-runner.js';

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

function resolveTargetPort(application:{deployment_type:'dockerfile'|'compose'|null;host_port:number|null},requested:number|undefined){
  const resolved=requested??application.host_port??undefined;
  if(!resolved)throw Object.assign(new Error('A target port is required when the application has no configured host port'),{statusCode:400});
  return port.parse(resolved);
}

export async function domainRoutes(app:FastifyInstance){
  app.get('/organizations/:orgId/domains',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=z.object({orgId:uuid}).parse(request.params);
    await membership(userId,orgId,'domain.read');
    const rows=await pool.query(
      `SELECT d.id,d.application_id,d.hostname,d.proxy_type,d.target_port,d.enabled,d.https_status,
              d.certificate_expires_at,d.certificate_issuer,d.tls_error,d.last_tls_checked_at,d.next_tls_check_at,
              d.created_at,d.updated_at,a.name AS application_name,a.server_id,s.name AS server_name,s.status AS server_status,
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
    const targetPort=resolveTargetPort(application,body.targetPort);
    let created;
    try{
      created=await pool.query(
        `INSERT INTO domains(application_id,hostname,proxy_type,target_port,enabled,next_tls_check_at)
         VALUES($1,$2,$3,$4,$5,now())
         RETURNING id,application_id,hostname,proxy_type,target_port,enabled,https_status,certificate_expires_at,
                   certificate_issuer,last_tls_checked_at,next_tls_check_at,created_at`,
        [application.id,hostname,body.proxyType,targetPort,body.enabled]
      );
    }catch(error){
      if((error as {code?:string}).code==='23505')throw Object.assign(new Error('This domain is already attached'),{statusCode:409});
      throw error;
    }
    const domain=created.rows[0];
    await audit(orgId,userId,'domain.create','domain',domain.id,request.ip,{
      hostname,
      proxyType:body.proxyType,
      targetPort,
      applicationId:application.id
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
    const targetPort=body.targetPort===undefined?row.target_port:resolveTargetPort(row,body.targetPort);
    const nextProxyType=body.proxyType??row.proxy_type;
    const enabled=body.enabled??row.enabled;
    let updated;
    try{
      updated=await pool.query(
        `UPDATE domains
         SET hostname=$2,proxy_type=$3,target_port=$4,enabled=$5,
             next_tls_check_at=CASE WHEN $5 THEN now() ELSE next_tls_check_at END,
             https_status=CASE WHEN hostname<>$2 THEN 'unknown' ELSE https_status END,
             certificate_expires_at=CASE WHEN hostname<>$2 THEN NULL ELSE certificate_expires_at END,
             certificate_issuer=CASE WHEN hostname<>$2 THEN NULL ELSE certificate_issuer END,
             tls_error=CASE WHEN hostname<>$2 THEN NULL ELSE tls_error END,
             updated_at=now()
         WHERE id=$1
         RETURNING *`,
        [domainId,hostname,nextProxyType,targetPort,enabled]
      );
    }catch(error){
      if((error as {code?:string}).code==='23505')throw Object.assign(new Error('This domain is already attached'),{statusCode:409});
      throw error;
    }
    await audit(row.organization_id,userId,'domain.update','domain',domainId,request.ip,{
      hostname,
      proxyType:nextProxyType,
      targetPort,
      enabled
    });
    return updated.rows[0];
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
    const current=await pool.query(
      `SELECT d.id,d.hostname,d.proxy_type,a.organization_id
       FROM domains d JOIN applications a ON a.id=d.application_id
       WHERE d.id=$1`,
      [domainId]
    );
    if(!current.rowCount)throw Object.assign(new Error('Domain not found'),{statusCode:404});
    const row=current.rows[0];
    await membership(userId,row.organization_id,'domain.manage');
    await pool.query('DELETE FROM domains WHERE id=$1',[domainId]);
    await audit(row.organization_id,userId,'domain.delete','domain',domainId,request.ip,{hostname:row.hostname,proxyType:row.proxy_type});
    return {ok:true};
  });
}
