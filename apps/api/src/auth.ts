import type { FastifyInstance, FastifyReply } from 'fastify';
import argon2 from 'argon2';
import { z } from 'zod';
import { pool, transaction } from './db.js';
import { sendChallenge } from './mail.js';
import { accessToken, authenticate, audit, digest, randomToken } from './security.js';
import {beginTwoFactorChallenge,completeTwoFactorChallenge} from './two-factor.js';
const credentials = z.object({email: z.email().max(320).transform(v => v.toLowerCase()),password: z.string().min(12).max(256)});
const emailSchema = z.object({email: z.email().max(320).transform(v => v.toLowerCase())});
const tokenSchema = z.object({token: z.string().min(20)});
const mobileCredentials=credentials.extend({deviceName:z.string().trim().min(1).max(120).optional()});
const mobileRefresh=z.object({refreshToken:z.string().min(20)}).strict();
const twoFactorComplete=z.object({challengeToken:z.string().min(20),code:z.string().trim().min(6).max(32)}).strict();
const refreshOptions = {httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/api/v1/auth', maxAge: 60*60*24*30};
function setRefresh(reply: FastifyReply, value: string) { reply.setCookie('clouddeck_refresh', value, refreshOptions); }
async function createSession(userId:string){
  const refresh=randomToken();
  const result=await pool.query(
    "INSERT INTO sessions(user_id,refresh_hash,expires_at) VALUES($1,$2,now()+interval '30 days') RETURNING id",
    [userId,digest(refresh)]
  );
  return {sessionId:result.rows[0].id as string,refresh};
}
async function issue(userId: string, reply: FastifyReply) {
  const session=await createSession(userId);
  setRefresh(reply,session.refresh);
  return {accessToken: await accessToken(userId,session.sessionId), expiresIn: 600};
}
async function issueMobile(userId:string){
  const session=await createSession(userId);
  return {
    accessToken:await accessToken(userId,session.sessionId),
    refreshToken:session.refresh,
    expiresIn:600
  };
}
async function createChallenge(userId: string, email: string, kind: 'verify_email'|'reset_password') {
  const token = randomToken();
  await pool.query('INSERT INTO auth_challenges(user_id,kind,token_hash,expires_at) VALUES($1,$2,$3,now()+interval \'30 minutes\')', [userId,kind,digest(token)]);
  await sendChallenge(kind,email,token);
}
export async function authRoutes(app: FastifyInstance) {
  app.post('/register', {config:{rateLimit:{max:5,timeWindow:'1 minute'}}}, async (request,reply) => {
    const input = credentials.parse(request.body);
    const passwordHash = await argon2.hash(input.password, {type:argon2.argon2id});
    const result = await transaction(async client => {
      const user = await client.query('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id', [input.email,passwordHash]);
      const org = await client.query('INSERT INTO organizations(name,personal) VALUES($1,true) RETURNING id', [`${input.email}'s workspace`]);
      await client.query('INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)', [org.rows[0].id,user.rows[0].id,'owner']);
      return {userId:user.rows[0].id,organizationId:org.rows[0].id};
    });
    await createChallenge(result.userId,input.email,'verify_email');
    await audit(result.organizationId,result.userId,'auth.register','user',result.userId,request.ip);
    reply.code(201);
    return {...await issue(result.userId,reply), organizationId: result.organizationId};
  });
  app.post('/login', {config:{rateLimit:{max:5,timeWindow:'1 minute'}}}, async (request,reply) => {
    const input = credentials.parse(request.body);
    const result = await pool.query('SELECT id,password_hash,totp_enabled_at FROM users WHERE email=$1', [input.email]);
    const valid = result.rowCount ? await argon2.verify(result.rows[0].password_hash,input.password) : false;
    if (!valid) throw Object.assign(new Error('Invalid credentials'), {statusCode:401});
    if(result.rows[0].totp_enabled_at){
      const challengeToken=await beginTwoFactorChallenge(result.rows[0].id,'web');
      await audit(null,result.rows[0].id,'auth.2fa.challenge','user',result.rows[0].id,request.ip,{clientType:'web'});
      reply.code(202);
      return {twoFactorRequired:true,challengeToken,expiresIn:300};
    }
    await audit(null,result.rows[0].id,'auth.login','user',result.rows[0].id,request.ip);
    return issue(result.rows[0].id,reply);
  });
  app.post('/mobile/login',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async request=>{
    const input=mobileCredentials.parse(request.body);
    const result=await pool.query('SELECT id,password_hash,totp_enabled_at FROM users WHERE email=$1',[input.email]);
    const valid=result.rowCount?await argon2.verify(result.rows[0].password_hash,input.password):false;
    if(!valid)throw Object.assign(new Error('Invalid credentials'),{statusCode:401});
    if(result.rows[0].totp_enabled_at){
      const challengeToken=await beginTwoFactorChallenge(result.rows[0].id,'mobile');
      await audit(null,result.rows[0].id,'auth.2fa.challenge','user',result.rows[0].id,request.ip,{
        clientType:'mobile',deviceName:input.deviceName??null
      });
      return {twoFactorRequired:true,challengeToken,expiresIn:300};
    }
    await audit(null,result.rows[0].id,'auth.mobile.login','user',result.rows[0].id,request.ip,{
      deviceName:input.deviceName??null
    });
    return issueMobile(result.rows[0].id);
  });

  app.post('/2fa/complete',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async (request,reply)=>{
    const body=twoFactorComplete.parse(request.body);
    const verified=await completeTwoFactorChallenge(body.challengeToken,body.code,'web');
    await audit(null,verified.userId,'auth.login.2fa','user',verified.userId,request.ip,{usedRecovery:verified.usedRecovery});
    return issue(verified.userId,reply);
  });

  app.post('/mobile/2fa/complete',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async request=>{
    const body=twoFactorComplete.parse(request.body);
    const verified=await completeTwoFactorChallenge(body.challengeToken,body.code,'mobile');
    await audit(null,verified.userId,'auth.mobile.login.2fa','user',verified.userId,request.ip,{usedRecovery:verified.usedRecovery});
    return issueMobile(verified.userId);
  });

  app.post('/mobile/refresh',async request=>{
    const {refreshToken}=mobileRefresh.parse(request.body);
    const replacement=randomToken();
    const result=await pool.query(
      `UPDATE sessions
       SET refresh_hash=$1,last_used_at=now()
       WHERE refresh_hash=$2 AND revoked_at IS NULL AND expires_at>now()
       RETURNING id,user_id`,
      [digest(replacement),digest(refreshToken)]
    );
    if(!result.rowCount)throw Object.assign(new Error('Session expired'),{statusCode:401});
    return {
      accessToken:await accessToken(result.rows[0].user_id,result.rows[0].id),
      refreshToken:replacement,
      expiresIn:600
    };
  });

  app.post('/mobile/logout',async request=>{
    const {refreshToken}=mobileRefresh.parse(request.body);
    await pool.query(
      'UPDATE sessions SET revoked_at=now() WHERE refresh_hash=$1 AND revoked_at IS NULL',
      [digest(refreshToken)]
    );
    return {ok:true};
  });

  app.post('/refresh', async (request,reply) => {
    const refresh = request.cookies.clouddeck_refresh;
    if (!refresh) throw Object.assign(new Error('Session expired'), {statusCode:401});
    const replacement = randomToken();
    const result = await pool.query(`UPDATE sessions SET refresh_hash=$1,last_used_at=now() WHERE refresh_hash=$2 AND revoked_at IS NULL AND expires_at>now() RETURNING id,user_id`, [digest(replacement),digest(refresh)]);
    if (!result.rowCount) {reply.clearCookie('clouddeck_refresh',refreshOptions); throw Object.assign(new Error('Session expired'), {statusCode:401});}
    setRefresh(reply,replacement);
    return {accessToken:await accessToken(result.rows[0].user_id,result.rows[0].id),expiresIn:600};
  });
  app.post('/logout', async (request,reply) => {
    const refresh = request.cookies.clouddeck_refresh;
    if (refresh) await pool.query('UPDATE sessions SET revoked_at=now() WHERE refresh_hash=$1 AND revoked_at IS NULL', [digest(refresh)]);
    reply.clearCookie('clouddeck_refresh',refreshOptions);
    return {ok:true};
  });
  app.get('/sessions', async request => {
    const identity = await authenticate(request);
    const result = await pool.query('SELECT id,created_at,last_used_at,expires_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC', [identity.userId]);
    return {sessions:result.rows,currentSessionId:identity.sessionId};
  });
  app.delete('/sessions/:id', async request => {
    const identity = await authenticate(request);
    const {id} = z.object({id:z.uuid()}).parse(request.params);
    await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2', [id,identity.userId]);
    return {ok:true};
  });
  app.post('/forgot-password', {config:{rateLimit:{max:3,timeWindow:'1 minute'}}}, async request => {
    const {email} = emailSchema.parse(request.body);
    const result = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (result.rowCount) await createChallenge(result.rows[0].id,email,'reset_password');
    return {ok:true};
  });
  app.post('/reset-password', async request => {
    const {token,password} = tokenSchema.extend({password:z.string().min(12).max(256)}).parse(request.body);
    const hash = await argon2.hash(password,{type:argon2.argon2id});
    await transaction(async client => {
      const challenge = await client.query(`UPDATE auth_challenges SET consumed_at=now() WHERE token_hash=$1 AND kind='reset_password' AND consumed_at IS NULL AND expires_at>now() RETURNING user_id`,[digest(token)]);
      if (!challenge.rowCount) throw Object.assign(new Error('Invalid or expired token'),{statusCode:400});
      await client.query('UPDATE users SET password_hash=$1 WHERE id=$2',[hash,challenge.rows[0].user_id]);
      await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[challenge.rows[0].user_id]);
    });
    return {ok:true};
  });
  app.post('/verify-email', async request => {
    const {token} = tokenSchema.parse(request.body);
    await transaction(async client => {
      const challenge = await client.query(`UPDATE auth_challenges SET consumed_at=now() WHERE token_hash=$1 AND kind='verify_email' AND consumed_at IS NULL AND expires_at>now() RETURNING user_id`,[digest(token)]);
      if (!challenge.rowCount) throw Object.assign(new Error('Invalid or expired token'),{statusCode:400});
      await client.query('UPDATE users SET email_verified_at=now() WHERE id=$1',[challenge.rows[0].user_id]);
    });
    return {ok:true};
  });
}
