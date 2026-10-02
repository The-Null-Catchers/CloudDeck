import argon2 from 'argon2';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool,transaction} from './db.js';
import {authenticate,audit,digest,randomToken} from './security.js';
import {decryptSecretValue,encryptSecretValue} from './secret-crypto.js';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  totpUri,
  verifyTotpCode
} from './totp.js';

const factorCode=z.string().trim().min(6).max(32);
const verifyBody=z.object({code:factorCode}).strict();
const passwordBody=z.object({password:z.string().min(12).max(256)}).strict();
const protectedAction=z.object({
  password:z.string().min(12).max(256),
  code:factorCode
}).strict();

type TotpRow={
  ciphertext:Buffer;
  iv:Buffer;
  auth_tag:Buffer;
  key_version:number;
  confirmed_at:string|null;
};

function decryptTotp(row:TotpRow){
  return decryptSecretValue({
    ciphertext:row.ciphertext,
    iv:row.iv,
    authTag:row.auth_tag,
    keyVersion:row.key_version
  });
}

export async function beginTwoFactorChallenge(userId:string,clientType:'web'|'mobile'){
  const token=randomToken();
  await pool.query(
    `INSERT INTO two_factor_challenges(user_id,token_hash,client_type,expires_at)
     VALUES($1,$2,$3,now()+interval '5 minutes')`,
    [userId,digest(token),clientType]
  );
  return token;
}

async function verifyFactorWithDb(
  db:{query:(text:string,values?:unknown[])=>Promise<{rows:any[];rowCount:number|null}>},
  userId:string,
  code:string
){
  const totp=await db.query(
    `SELECT ciphertext,iv,auth_tag,key_version,confirmed_at
     FROM user_totp WHERE user_id=$1 AND confirmed_at IS NOT NULL`,
    [userId]
  );
  if(!totp.rowCount)throw Object.assign(new Error('Two-factor authentication is not configured'),{statusCode:409});
  const secret=decryptTotp(totp.rows[0] as TotpRow);
  if(verifyTotpCode(secret,code))return {usedRecovery:false};

  const normalized=normalizeRecoveryCode(code);
  if(normalized.length!==16)throw Object.assign(new Error('Invalid two-factor code'),{statusCode:401});
  const recovery=await db.query(
    `UPDATE user_recovery_codes
     SET used_at=now()
     WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL
     RETURNING code_hash`,
    [userId,digest(normalized)]
  );
  if(!recovery.rowCount)throw Object.assign(new Error('Invalid two-factor code'),{statusCode:401});
  return {usedRecovery:true};
}

export async function completeTwoFactorChallenge(challengeToken:string,code:string,expectedClientType:'web'|'mobile'){
  return transaction(async db=>{
    const challenge=await db.query(
      `SELECT id,user_id,client_type
       FROM two_factor_challenges
       WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now()
       FOR UPDATE`,
      [digest(challengeToken)]
    );
    if(!challenge.rowCount)throw Object.assign(new Error('Invalid or expired two-factor challenge'),{statusCode:401});
    const row=challenge.rows[0] as {id:string;user_id:string;client_type:'web'|'mobile'};
    if(row.client_type!==expectedClientType)throw Object.assign(new Error('Invalid two-factor challenge'),{statusCode:401});
    const verification=await verifyFactorWithDb(db,row.user_id,code);
    await db.query('UPDATE two_factor_challenges SET consumed_at=now() WHERE id=$1',[row.id]);
    return {userId:row.user_id,clientType:row.client_type,...verification};
  });
}

async function verifyPasswordAndFactor(userId:string,password:string,code:string){
  const user=await pool.query('SELECT password_hash FROM users WHERE id=$1',[userId]);
  if(!user.rowCount||!await argon2.verify(user.rows[0].password_hash,password)){
    throw Object.assign(new Error('Invalid credentials'),{statusCode:401});
  }
  return transaction(db=>verifyFactorWithDb(db,userId,code));
}

async function replaceRecoveryCodes(userId:string){
  const codes=generateRecoveryCodes();
  await transaction(async db=>{
    await db.query('DELETE FROM user_recovery_codes WHERE user_id=$1',[userId]);
    for(const code of codes){
      await db.query(
        'INSERT INTO user_recovery_codes(user_id,code_hash) VALUES($1,$2)',
        [userId,digest(normalizeRecoveryCode(code))]
      );
    }
  });
  return codes;
}

export async function twoFactorRoutes(app:FastifyInstance){
  app.get('/auth/2fa/status',async request=>{
    const {userId}=await authenticate(request);
    const [user,codes]=await Promise.all([
      pool.query('SELECT totp_enabled_at FROM users WHERE id=$1',[userId]),
      pool.query('SELECT count(*)::integer AS remaining FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL',[userId])
    ]);
    return {
      enabled:Boolean(user.rows[0]?.totp_enabled_at),
      enabledAt:user.rows[0]?.totp_enabled_at??null,
      recoveryCodesRemaining:codes.rows[0]?.remaining??0
    };
  });

  app.post('/auth/2fa/setup',async request=>{
    const {userId}=await authenticate(request);
    const {password}=passwordBody.parse(request.body);
    const user=await pool.query('SELECT email,password_hash,totp_enabled_at FROM users WHERE id=$1',[userId]);
    if(!user.rowCount)throw Object.assign(new Error('User not found'),{statusCode:404});
    if(!await argon2.verify(user.rows[0].password_hash,password))throw Object.assign(new Error('Invalid credentials'),{statusCode:401});
    if(user.rows[0].totp_enabled_at)throw Object.assign(new Error('Two-factor authentication is already enabled'),{statusCode:409});
    const secret=generateTotpSecret();
    const encrypted=encryptSecretValue(secret);
    await pool.query(
      `INSERT INTO user_totp(user_id,ciphertext,iv,auth_tag,key_version,confirmed_at,updated_at)
       VALUES($1,$2,$3,$4,$5,NULL,now())
       ON CONFLICT(user_id) DO UPDATE SET
         ciphertext=EXCLUDED.ciphertext,iv=EXCLUDED.iv,auth_tag=EXCLUDED.auth_tag,
         key_version=EXCLUDED.key_version,confirmed_at=NULL,updated_at=now()`,
      [userId,encrypted.ciphertext,encrypted.iv,encrypted.authTag,encrypted.keyVersion]
    );
    await audit(null,userId,'auth.2fa.setup.started','user',userId,request.ip);
    return {secret,otpauthUri:totpUri(user.rows[0].email,secret)};
  });

  app.post('/auth/2fa/enable',async request=>{
    const {userId}=await authenticate(request);
    const {code}=verifyBody.parse(request.body);
    const row=await pool.query(
      'SELECT ciphertext,iv,auth_tag,key_version,confirmed_at FROM user_totp WHERE user_id=$1',
      [userId]
    );
    if(!row.rowCount||row.rows[0].confirmed_at)throw Object.assign(new Error('Start two-factor setup first'),{statusCode:409});
    const secret=decryptTotp(row.rows[0] as TotpRow);
    if(!verifyTotpCode(secret,code))throw Object.assign(new Error('Invalid authenticator code'),{statusCode:401});
    const codes=generateRecoveryCodes();
    await transaction(async db=>{
      await db.query('UPDATE user_totp SET confirmed_at=now(),updated_at=now() WHERE user_id=$1',[userId]);
      await db.query('UPDATE users SET totp_enabled_at=now() WHERE id=$1',[userId]);
      await db.query('DELETE FROM user_recovery_codes WHERE user_id=$1',[userId]);
      for(const recovery of codes){
        await db.query(
          'INSERT INTO user_recovery_codes(user_id,code_hash) VALUES($1,$2)',
          [userId,digest(normalizeRecoveryCode(recovery))]
        );
      }
      await audit(null,userId,'auth.2fa.enabled','user',userId,request.ip,{},db);
    });
    return {enabled:true,recoveryCodes:codes};
  });

  app.post('/auth/2fa/recovery-codes',async request=>{
    const {userId}=await authenticate(request);
    const body=protectedAction.parse(request.body);
    await verifyPasswordAndFactor(userId,body.password,body.code);
    const codes=await replaceRecoveryCodes(userId);
    await audit(null,userId,'auth.2fa.recovery.regenerated','user',userId,request.ip);
    return {recoveryCodes:codes};
  });

  app.post('/auth/2fa/disable',async request=>{
    const {userId,sessionId}=await authenticate(request);
    const body=protectedAction.parse(request.body);
    await verifyPasswordAndFactor(userId,body.password,body.code);
    await transaction(async db=>{
      await db.query('DELETE FROM user_totp WHERE user_id=$1',[userId]);
      await db.query('DELETE FROM user_recovery_codes WHERE user_id=$1',[userId]);
      await db.query('UPDATE users SET totp_enabled_at=NULL WHERE id=$1',[userId]);
      await db.query(
        'UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL',
        [userId,sessionId]
      );
      await db.query(
        'UPDATE two_factor_challenges SET consumed_at=COALESCE(consumed_at,now()) WHERE user_id=$1 AND consumed_at IS NULL',
        [userId]
      );
      await audit(null,userId,'auth.2fa.disabled','user',userId,request.ip,{},db);
    });
    return {enabled:false};
  });
}
