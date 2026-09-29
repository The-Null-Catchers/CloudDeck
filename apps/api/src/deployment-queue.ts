import {Queue} from 'bullmq';
import IORedis from 'ioredis';
import {z} from 'zod';
import {pool} from './db.js';

export const deploymentQueueName='clouddeck-deployments';
const deploymentJob=z.object({deploymentId:z.uuid()}).strict();
let connection:IORedis|null=null;
let queue:Queue|null=null;

function redisUrl(){
  const value=process.env.REDIS_URL;
  if(!value)throw new Error('REDIS_URL is required for deployment dispatch');
  const parsed=new URL(value);
  if(parsed.protocol!=='redis:'&&parsed.protocol!=='rediss:')throw new Error('REDIS_URL must use redis:// or rediss://');
  return value;
}

function deploymentQueue(){
  if(queue)return queue;
  connection=new IORedis(redisUrl(),{
    maxRetriesPerRequest:1,
    enableOfflineQueue:false,
    connectTimeout:2000
  });
  connection.on('error',()=>{});
  queue=new Queue(deploymentQueueName,{connection});
  return queue;
}

export function deploymentQueueJob(deploymentId:string){
  const data=deploymentJob.parse({deploymentId});
  return {
    name:'execute',
    data,
    options:{
      jobId:deploymentId,
      attempts:5,
      backoff:{type:'exponential' as const,delay:5000},
      removeOnComplete:{count:1000},
      removeOnFail:{count:5000}
    }
  };
}

export async function enqueueDeployment(deploymentId:string){
  const job=deploymentQueueJob(deploymentId);
  await deploymentQueue().add(job.name,job.data,job.options);
}

export async function reconcileQueuedDeployments(limit=100){
  const bounded=Math.max(1,Math.min(500,Math.trunc(limit)));
  const rows=await pool.query(
    `SELECT id
     FROM deployments
     WHERE state='queued'
     ORDER BY created_at ASC
     LIMIT $1`,
    [bounded]
  );
  let enqueued=0;
  for(const row of rows.rows){
    try{
      await enqueueDeployment(row.id as string);
      enqueued++;
    }catch{
      break;
    }
  }
  return {scanned:rows.rowCount??0,enqueued};
}

export function startDeploymentQueueReconciler(intervalMs=15_000){
  const delay=Math.max(5_000,intervalMs);
  let running=false;
  const run=async()=>{
    if(running)return;
    running=true;
    try{await reconcileQueuedDeployments();}catch{void 0;}finally{running=false;}
  };
  void run();
  const timer=setInterval(()=>void run(),delay);
  timer.unref();
  return ()=>clearInterval(timer);
}

export async function closeDeploymentQueue(){
  const activeQueue=queue;
  const activeConnection=connection;
  queue=null;
  connection=null;
  if(activeQueue)await activeQueue.close();
  if(activeConnection)activeConnection.disconnect();
}
