import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.js';
import {authenticate,audit} from './security.js';

const registerBody=z.object({
  provider:z.literal('fcm'),
  platform:z.enum(['android','ios']),
  token:z.string().min(20).max(4096),
  deviceName:z.string().min(1).max(120).optional()
}).strict();
const idParams=z.object({deviceId:z.uuid()});

export async function pushDeviceRoutes(app:FastifyInstance){
  app.get('/push-devices',async request=>{
    const {userId}=await authenticate(request);
    const rows=await pool.query(
      `SELECT id,provider,platform,device_name AS "deviceName",active,last_seen_at AS "lastSeenAt",created_at AS "createdAt"
       FROM push_devices WHERE user_id=$1 ORDER BY last_seen_at DESC LIMIT 50`,
      [userId]
    );
    return {devices:rows.rows};
  });

  app.put('/push-devices',async request=>{
    const {userId}=await authenticate(request);
    const body=registerBody.parse(request.body);
    const result=await pool.query(
      `INSERT INTO push_devices(user_id,provider,platform,token,device_name)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(provider,token) DO UPDATE SET
         user_id=EXCLUDED.user_id,
         platform=EXCLUDED.platform,
         device_name=EXCLUDED.device_name,
         active=true,
         last_seen_at=now(),
         updated_at=now()
       RETURNING id,provider,platform,device_name AS "deviceName",active,last_seen_at AS "lastSeenAt",created_at AS "createdAt"`,
      [userId,body.provider,body.platform,body.token,body.deviceName??null]
    );
    await audit(null,userId,'push.device.registered','push_device',result.rows[0].id,request.ip,{provider:body.provider,platform:body.platform});
    return {device:result.rows[0]};
  });

  app.delete('/push-devices/:deviceId',async (request,reply)=>{
    const {userId}=await authenticate(request);
    const {deviceId}=idParams.parse(request.params);
    const removed=await pool.query('DELETE FROM push_devices WHERE id=$1 AND user_id=$2 RETURNING id,provider,platform',[deviceId,userId]);
    if(!removed.rowCount)throw Object.assign(new Error('Push device not found'),{statusCode:404});
    await audit(null,userId,'push.device.removed','push_device',deviceId,request.ip,{provider:removed.rows[0].provider,platform:removed.rows[0].platform});
    reply.code(204).send();
  });
}
