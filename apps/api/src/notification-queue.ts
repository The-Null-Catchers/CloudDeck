import {Queue} from 'bullmq';
import {Redis} from 'ioredis';
import {z} from 'zod';
import {pool} from './db.js';

export const notificationQueueName='clouddeck-notifications';
const deliveryId=z.string().regex(/^[1-9][0-9]*$/);
const notificationJob=z.object({deliveryId}).strict();
let connection:Redis|null=null;
let queue:Queue|null=null;

function redisUrl(){
  const value=process.env.REDIS_URL;
  if(!value)throw new Error('REDIS_URL is required for notification delivery');
  const parsed=new URL(value);
  if(parsed.protocol!=='redis:'&&parsed.protocol!=='rediss:')throw new Error('REDIS_URL must use redis:// or rediss://');
  return value;
}

function notificationQueue(){
  if(queue)return queue;
  connection=new Redis(redisUrl(),{
    maxRetriesPerRequest:1,
    enableOfflineQueue:false,
    connectTimeout:2000
  });
  connection.on('error',()=>{});
  queue=new Queue(notificationQueueName,{connection});
  return queue;
}

export function notificationQueueJob(id:string|number){
  const data=notificationJob.parse({deliveryId:String(id)});
  return {
    name:'email',
    data,
    options:{
      jobId:`email-${data.deliveryId}`,
      attempts:5,
      backoff:{type:'exponential' as const,delay:10_000},
      removeOnComplete:{count:2000},
      removeOnFail:{count:5000}
    }
  };
}

export async function enqueueNotificationDelivery(id:string|number){
  const job=notificationQueueJob(id);
  await notificationQueue().add(job.name,job.data,job.options);
}

export async function reconcileNotificationDeliveries(limit=100){
  const bounded=Math.max(1,Math.min(500,Math.trunc(limit)));
  await pool.query(
    `UPDATE notification_deliveries
     SET status='pending',locked_at=NULL,next_attempt_at=now(),updated_at=now()
     WHERE status='sending' AND locked_at < now()-interval '10 minutes'`
  );
  const rows=await pool.query(
    `SELECT id
     FROM notification_deliveries
     WHERE status='pending' AND next_attempt_at<=now()
     ORDER BY next_attempt_at ASC,id ASC
     LIMIT $1`,
    [bounded]
  );
  let enqueued=0;
  for(const row of rows.rows){
    try{
      await enqueueNotificationDelivery(String(row.id));
      enqueued++;
    }catch{
      break;
    }
  }
  return {scanned:rows.rowCount??0,enqueued};
}

export function startNotificationQueueReconciler(intervalMs=15_000){
  const delay=Math.max(5_000,intervalMs);
  let running=false;
  const run=async()=>{
    if(running)return;
    running=true;
    try{await reconcileNotificationDeliveries();}catch{void 0}finally{running=false}
  };
  void run();
  const timer=setInterval(()=>void run(),delay);
  timer.unref();
  return ()=>clearInterval(timer);
}

export async function closeNotificationQueue(){
  const activeQueue=queue;
  const activeConnection=connection;
  queue=null;
  connection=null;
  if(activeQueue)await activeQueue.close();
  if(activeConnection)activeConnection.disconnect();
}
