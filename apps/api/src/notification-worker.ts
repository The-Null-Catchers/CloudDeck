import {Worker} from 'bullmq';
import {Redis} from 'ioredis';
import {z} from 'zod';
import {pool} from './db.js';
import {sendOperationalNotification} from './mail.js';
import {sendPushNotification} from './push-provider.js';
import {notificationQueueName} from './notification-queue.js';

const notificationJob=z.object({deliveryId:z.string().regex(/^[1-9][0-9]*$/)}).strict();
let workerConnection:Redis|null=null;
let worker:Worker|null=null;

type ClaimedDelivery={
  attempts:number;
  channel:'email'|'push';
  type:string;
  title:string;
  body:string|null;
  href:string|null;
  email:string;
  email_verified_at:string|null;
  push_device_id:string|null;
  push_token:string|null;
  push_active:boolean|null;
};

function redisUrl(){
  const value=process.env.REDIS_URL;
  if(!value)throw new Error('REDIS_URL is required for notification worker');
  const parsed=new URL(value);
  if(parsed.protocol!=='redis:'&&parsed.protocol!=='rediss:')throw new Error('REDIS_URL must use redis:// or rediss://');
  return value;
}

async function claimDelivery(id:string){
  const result=await pool.query(
    `WITH claimed AS (
       UPDATE notification_deliveries
       SET status='sending',attempts=attempts+1,locked_at=now(),last_error=NULL,updated_at=now()
       WHERE id=$1 AND status='pending'
       RETURNING notification_id,channel,push_device_id,attempts
     )
     SELECT c.attempts,c.channel,n.type,n.title,n.body,n.href,u.email,u.email_verified_at,
            d.id AS push_device_id,d.token AS push_token,d.active AS push_active
     FROM claimed c
     JOIN notifications n ON n.id=c.notification_id
     JOIN users u ON u.id=n.user_id
     LEFT JOIN push_devices d ON d.id=c.push_device_id`,
    [id]
  );
  return result.rows[0] as ClaimedDelivery|undefined;
}

async function markSent(id:string){
  await pool.query(
    `UPDATE notification_deliveries
     SET status='sent',sent_at=now(),locked_at=NULL,last_error=NULL,updated_at=now()
     WHERE id=$1 AND status='sending'`,
    [id]
  );
}

async function markTerminalFailure(id:string,message:string){
  await pool.query(
    `UPDATE notification_deliveries
     SET status='failed',locked_at=NULL,last_error=$2,updated_at=now()
     WHERE id=$1 AND status='sending'`,
    [id,message.slice(0,500)]
  );
}

async function markDeliveryFailure(id:string,error:unknown,terminal:boolean){
  const message=(error instanceof Error?error.message:'Notification delivery failed').slice(0,500);
  await pool.query(
    `UPDATE notification_deliveries
     SET status=$2,locked_at=NULL,last_error=$3,next_attempt_at=now(),updated_at=now()
     WHERE id=$1 AND status='sending'`,
    [id,terminal?'failed':'pending',message]
  );
}

export async function processNotificationDelivery(id:string){
  const delivery=await claimDelivery(id);
  if(!delivery)return {status:'skipped' as const};

  if(delivery.channel==='email'){
    if(!delivery.email_verified_at){
      await markTerminalFailure(id,'Email address is not verified');
      return {status:'skipped' as const,reason:'email_unverified' as const};
    }
    await sendOperationalNotification(delivery.email,delivery.title,delivery.body,delivery.href);
    await markSent(id);
    return {status:'sent' as const,channel:'email' as const};
  }

  if(!delivery.push_device_id||!delivery.push_token||delivery.push_active!==true){
    await markTerminalFailure(id,'Push device is unavailable');
    return {status:'skipped' as const,reason:'push_device_unavailable' as const};
  }
  const result=await sendPushNotification({
    token:delivery.push_token,
    title:delivery.title,
    body:delivery.body,
    href:delivery.href,
    type:delivery.type
  });
  if(result==='invalid_token'){
    await pool.query('UPDATE push_devices SET active=false,updated_at=now() WHERE id=$1',[delivery.push_device_id]);
    await markTerminalFailure(id,'Push registration token is no longer valid');
    return {status:'skipped' as const,reason:'push_token_invalid' as const};
  }
  await markSent(id);
  return {status:'sent' as const,channel:'push' as const};
}

export function startNotificationWorker(){
  if(worker)return worker;
  workerConnection=new Redis(redisUrl(),{
    maxRetriesPerRequest:null,
    enableOfflineQueue:true,
    connectTimeout:5000
  });
  workerConnection.on('error',()=>{});
  worker=new Worker(
    notificationQueueName,
    async job=>{
      const {deliveryId}=notificationJob.parse(job.data);
      const maxAttempts=typeof job.opts.attempts==='number'?job.opts.attempts:1;
      const finalAttempt=job.attemptsMade+1>=maxAttempts;
      try{
        return await processNotificationDelivery(deliveryId);
      }catch(error){
        await markDeliveryFailure(deliveryId,error,finalAttempt).catch(()=>{});
        throw error;
      }
    },
    {connection:workerConnection,concurrency:4}
  );
  worker.on('error',()=>{});
  return worker;
}

export async function closeNotificationWorker(){
  const activeWorker=worker;
  const activeConnection=workerConnection;
  worker=null;
  workerConnection=null;
  if(activeWorker)await activeWorker.close();
  if(activeConnection)activeConnection.disconnect();
}
