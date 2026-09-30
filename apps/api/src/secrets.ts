import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool,transaction} from './db.js';
import {authenticate,membership,audit} from './security.js';
import {decryptSecretValue,encryptSecretValue} from './secret-crypto.js';

const uuid=z.uuid();
const kind=z.enum(['environment','api_key','deployment','backup','other']);
const name=z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/,'Secret name contains unsupported characters');
const description=z.string().trim().max(500).nullable().optional();
const createBody=z.object({
  name,
  kind,
  description,
  value:z.string().min(1).max(16384)
}).strict();
const updateBody=z.object({
  name:name.optional(),
  kind:kind.optional(),
  description,
  value:z.string().min(1).max(16384).optional()
}).strict().refine(v=>Object.keys(v).length>0,'At least one field is required');
const confirmBody=z.object({confirm:z.literal(true)}).strict();

type SecretRow={
  id:string;
  organization_id:string;
  name:string;
  kind:string;
  description:string|null;
  created_by:string|null;
  created_at:string;
  updated_at:string;
};

const publicSecret=(row:SecretRow)=>({
  id:row.id,
  organizationId:row.organization_id,
  name:row.name,
  kind:row.kind,
  description:row.description,
  createdBy:row.created_by,
  createdAt:row.created_at,
  updatedAt:row.updated_at,
  valueConfigured:true
});

async function findSecret(secretId:string){
  const result=await pool.query(
    `SELECT id,organization_id,name,kind,description,created_by,created_at,updated_at
     FROM secrets WHERE id=$1`,
    [secretId]
  );
  if(!result.rowCount)throw Object.assign(new Error('Secret not found'),{statusCode:404});
  return result.rows[0] as SecretRow;
}

export async function readSecretValueForService(secretId:string,organizationId:string){
  const result=await pool.query(
    `SELECT s.organization_id,sv.ciphertext,sv.iv,sv.auth_tag,sv.key_version
     FROM secrets s JOIN secret_values sv ON sv.secret_id=s.id
     WHERE s.id=$1 AND s.organization_id=$2`,
    [secretId,organizationId]
  );
  if(!result.rowCount)throw Object.assign(new Error('Secret not found'),{statusCode:404});
  const row=result.rows[0] as {ciphertext:Buffer;iv:Buffer;auth_tag:Buffer;key_version:number};
  return decryptSecretValue({ciphertext:row.ciphertext,iv:row.iv,authTag:row.auth_tag,keyVersion:row.key_version});
}

export async function secretRoutes(app:FastifyInstance){
  app.get('/organizations/:orgId/secrets',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=z.object({orgId:uuid}).parse(request.params);
    await membership(userId,orgId,'secret.read');
    const result=await pool.query(
      `SELECT id,organization_id,name,kind,description,created_by,created_at,updated_at
       FROM secrets WHERE organization_id=$1 ORDER BY name ASC`,
      [orgId]
    );
    return {secrets:result.rows.map(row=>publicSecret(row as SecretRow))};
  });

  app.post('/organizations/:orgId/secrets',async (request,reply)=>{
    const {userId}=await authenticate(request);
    const {orgId}=z.object({orgId:uuid}).parse(request.params);
    const body=createBody.parse(request.body);
    await membership(userId,orgId,'secret.manage');
    const encrypted=encryptSecretValue(body.value);
    let created:SecretRow;
    try{
      created=await transaction(async db=>{
        const result=await db.query(
          `INSERT INTO secrets(organization_id,name,kind,description,created_by)
           VALUES($1,$2,$3,$4,$5)
           RETURNING id,organization_id,name,kind,description,created_by,created_at,updated_at`,
          [orgId,body.name,body.kind,body.description??null,userId]
        );
        const row=result.rows[0] as SecretRow;
        await db.query(
          `INSERT INTO secret_values(secret_id,ciphertext,iv,auth_tag,key_version)
           VALUES($1,$2,$3,$4,$5)`,
          [row.id,encrypted.ciphertext,encrypted.iv,encrypted.authTag,encrypted.keyVersion]
        );
        await audit(orgId,userId,'secret.create','secret',row.id,request.ip,{name:row.name,kind:row.kind},db);
        return row;
      });
    }catch(error){
      if((error as {code?:string}).code==='23505')throw Object.assign(new Error('A secret with this name already exists'),{statusCode:409});
      throw error;
    }
    reply.code(201);
    return publicSecret(created);
  });

  app.patch('/secrets/:secretId',async request=>{
    const {userId}=await authenticate(request);
    const {secretId}=z.object({secretId:uuid}).parse(request.params);
    const body=updateBody.parse(request.body);
    const current=await findSecret(secretId);
    await membership(userId,current.organization_id,'secret.manage');
    const encrypted=body.value===undefined?null:encryptSecretValue(body.value);
    try{
      return await transaction(async db=>{
        const result=await db.query(
          `UPDATE secrets
           SET name=COALESCE($2,name),
               kind=COALESCE($3,kind),
               description=CASE WHEN $4::boolean THEN $5 ELSE description END,
               updated_at=now()
           WHERE id=$1
           RETURNING id,organization_id,name,kind,description,created_by,created_at,updated_at`,
          [secretId,body.name??null,body.kind??null,Object.prototype.hasOwnProperty.call(body,'description'),body.description??null]
        );
        if(encrypted){
          await db.query(
            `UPDATE secret_values
             SET ciphertext=$2,iv=$3,auth_tag=$4,key_version=$5,updated_at=now()
             WHERE secret_id=$1`,
            [secretId,encrypted.ciphertext,encrypted.iv,encrypted.authTag,encrypted.keyVersion]
          );
        }
        const row=result.rows[0] as SecretRow;
        await audit(current.organization_id,userId,'secret.update','secret',secretId,request.ip,{
          name:row.name,
          kind:row.kind,
          rotatedValue:Boolean(encrypted)
        },db);
        return publicSecret(row);
      });
    }catch(error){
      if((error as {code?:string}).code==='23505')throw Object.assign(new Error('A secret with this name already exists'),{statusCode:409});
      throw error;
    }
  });

  app.delete('/secrets/:secretId',async request=>{
    const {userId}=await authenticate(request);
    const {secretId}=z.object({secretId:uuid}).parse(request.params);
    confirmBody.parse(request.body);
    const current=await findSecret(secretId);
    await membership(userId,current.organization_id,'secret.manage');
    await transaction(async db=>{
      await db.query('DELETE FROM secrets WHERE id=$1',[secretId]);
      await audit(current.organization_id,userId,'secret.delete','secret',secretId,request.ip,{name:current.name,kind:current.kind},db);
    });
    return {ok:true};
  });
}
