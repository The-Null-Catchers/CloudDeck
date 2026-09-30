import {Worker} from 'bullmq';
import {Redis} from 'ioredis';
import {z} from 'zod';
import {pool} from './db.js';
import {sendOperationalNotification} from './mail.js';
import {notificationQueueName} from './notification-queue.js';

const notificationJob=z.object({deliveryId:z.string().regex(/^[1-9][0-9]*$/)}).strict();
let workerConnection:Redis|null=null;
let worker:Worker|null=null;

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
       RETURNING notification_id,attempts
     )
     SELECT c.attempts,n.title,n.body,n.href,u.email
     FROM claimed c
     JOIN notifications n ON n.id=c.notification_id
     JOIN users u ON u.id=n.user_id
     WHERE u.email_verified_at IS NOT NULL`,
    [id]
  );
  return result.rows[0] as undefined|{
    attempts:number;
    title:string;
    body:string|null;
    href:string|null;
    email:string;
  };
}

async function markDeliveryFailure(id:string,error:unknown,terminal:boolean){
  const message=(error instanceof Error?error.message:'Email delivery failed').slice(0,500);
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
  await sendOperationalNotification(delivery.email,delivery.title,delivery.body,delivery.href);
  await pool.query(
    `UPDATE notification_deliveries
     SET status='sent',sent_at=now(),locked_at=NULL,last_error=NULL,updated_at=now()
     WHERE id=$1 AND status='sending'`,
    [id]
  );
  return {status:'sent' as const};
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
