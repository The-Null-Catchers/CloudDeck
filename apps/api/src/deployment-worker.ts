import {Worker} from 'bullmq';
import {Redis} from 'ioredis';
import {z} from 'zod';
import {pool} from './db.js';
import {deploymentQueueName} from './deployment-queue.js';
import {createInstallationToken} from './github.js';
import {
  isAgentConnected,
  registerDeploymentProgress,
  unregisterDeploymentProgress,
  sendAgentCommand,
  type DeploymentProgressStage
} from './commands.js';
import {canTransitionDeployment,transitionDeployment,type DeploymentState} from './deployments.js';

const workerResult=z.object({
  containerId:z.string().regex(/^[a-f0-9]{12,64}$/i),
  imageRef:z.string().min(1).max(255),
  previousContainerId:z.string().regex(/^[a-f0-9]{12,64}$/i).nullable().optional()
}).strict();

const stageOrder:DeploymentState[]=['queued','cloning','building','deploying','health-checking','successful'];
let workerConnection:Redis|null=null;
let worker:Worker|null=null;

function redisUrl(){
  const value=process.env.REDIS_URL;
  if(!value)throw new Error('REDIS_URL is required for deployment worker');
  const parsed=new URL(value);
  if(parsed.protocol!=='redis:'&&parsed.protocol!=='rediss:')throw new Error('REDIS_URL must use redis:// or rediss://');
  return value;
}

async function deploymentSnapshot(deploymentId:string){
  const result=await pool.query(
    `SELECT d.id,d.state,d.commit_sha,d.repository_full_name,d.deployment_type,d.source_path,
            d.container_name,d.container_port,d.host_port,d.restart_policy,d.compose_project,
            a.organization_id,a.server_id,g.installation_id
     FROM deployments d
     JOIN applications a ON a.id=d.application_id
     LEFT JOIN github_installations g ON g.id=d.github_installation_id
     WHERE d.id=$1`,
    [deploymentId]
  );
  return result.rows[0] as undefined|{
    id:string;
    state:DeploymentState;
    commit_sha:string|null;
    repository_full_name:string|null;
    deployment_type:'dockerfile'|'compose'|null;
    source_path:string|null;
    container_name:string|null;
    container_port:number|null;
    host_port:number|null;
    restart_policy:'no'|'always'|'unless-stopped'|'on-failure'|null;
    compose_project:string|null;
    organization_id:string;
    server_id:string|null;
    installation_id:string|number|null;
  };
}

async function currentState(deploymentId:string){
  const result=await pool.query('SELECT state FROM deployments WHERE id=$1',[deploymentId]);
  return result.rows[0]?.state as DeploymentState|undefined;
}

async function advanceTo(deploymentId:string,target:DeploymentProgressStage,message?:string){
  const targetIndex=stageOrder.indexOf(target);
  while(true){
    const state=await currentState(deploymentId);
    if(!state)return;
    const currentIndex=stageOrder.indexOf(state);
    if(currentIndex<0||currentIndex>=targetIndex)return;
    const next=stageOrder[currentIndex+1] as DeploymentState|undefined;
    if(!next||!canTransitionDeployment(state,next))return;
    await transitionDeployment(deploymentId,next,{message:next===target?message:undefined});
  }
}

async function failStartedDeployment(deploymentId:string,message:string){
  const state=await currentState(deploymentId);
  if(!state||state==='failed'||state==='successful'||state==='rolled-back')return;
  if(canTransitionDeployment(state,'failed')){
    await transitionDeployment(deploymentId,'failed',{
      failureCode:'DEPLOYMENT_EXECUTION_FAILED',
      message:message.slice(0,500)
    });
  }
}

export async function processDeploymentJob(deploymentId:string){
  const snapshot=await deploymentSnapshot(deploymentId);
  if(!snapshot)return {status:'missing' as const};
  if(snapshot.state!=='queued')return {status:'skipped' as const,state:snapshot.state};
  if(!snapshot.server_id)throw new Error('Deployment target server is missing');
  if(!isAgentConnected(snapshot.server_id))throw Object.assign(new Error('Target agent is not connected'),{code:'AGENT_UNAVAILABLE'});
  if(!snapshot.installation_id||!snapshot.commit_sha||!snapshot.repository_full_name||!snapshot.deployment_type||!snapshot.source_path){
    await transitionDeployment(deploymentId,'failed',{failureCode:'INVALID_DEPLOYMENT_SNAPSHOT',message:'Deployment snapshot is incomplete'});
    return {status:'failed' as const};
  }

  const token=await createInstallationToken(Number(snapshot.installation_id));
  await transitionDeployment(deploymentId,'cloning',{message:'Deployment worker claimed the queued request'});
  let progressChain=Promise.resolve();
  registerDeploymentProgress(deploymentId,progress=>{
    progressChain=progressChain.then(()=>advanceTo(deploymentId,progress.stage,progress.message));
    return progressChain;
  });

  try{
    const result=workerResult.parse(await sendAgentCommand(
      snapshot.server_id,
      'deployment.execute',
      {
        deploymentId,
        repositoryFullName:snapshot.repository_full_name,
        commitSha:snapshot.commit_sha,
        sourcePath:snapshot.source_path,
        deploymentType:snapshot.deployment_type,
        githubToken:token,
        runtime:snapshot.deployment_type==='dockerfile'?{
          containerName:snapshot.container_name,
          containerPort:snapshot.container_port,
          hostPort:snapshot.host_port,
          restartPolicy:snapshot.restart_policy
        }:{
          composeProject:snapshot.compose_project
        }
      },
      25*60_000
    ));
    await progressChain;
    await pool.query(
      `UPDATE deployments
       SET image_ref=$2,container_id=$3,previous_container_id=$4
       WHERE id=$1`,
      [deploymentId,result.imageRef,result.containerId,result.previousContainerId??null]
    );
    await advanceTo(deploymentId,'health-checking','Agent completed deployment readiness checks');
    const state=await currentState(deploymentId);
    if(state==='health-checking'){
      await transitionDeployment(deploymentId,'successful',{message:`Deployment activated as ${result.imageRef}`});
    }
    return {status:'successful' as const,...result};
  }catch(error){
    await progressChain.catch(()=>{});
    const message=error instanceof Error?error.message:'Deployment execution failed';
    await failStartedDeployment(deploymentId,message);
    return {status:'failed' as const};
  }finally{
    unregisterDeploymentProgress(deploymentId);
  }
}

export function startDeploymentWorker(){
  if(worker)return worker;
  workerConnection=new Redis(redisUrl(),{
    maxRetriesPerRequest:null,
    enableOfflineQueue:true,
    connectTimeout:5000
  });
  workerConnection.on('error',()=>{});
  worker=new Worker(
    deploymentQueueName,
    async job=>{
      const parsed=z.object({deploymentId:z.uuid()}).strict().parse(job.data);
      return processDeploymentJob(parsed.deploymentId);
    },
    {connection:workerConnection,concurrency:2}
  );
  worker.on('error',()=>{});
  return worker;
}

export async function closeDeploymentWorker(){
  const activeWorker=worker;
  const activeConnection=workerConnection;
  worker=null;
  workerConnection=null;
  if(activeWorker)await activeWorker.close();
  if(activeConnection)activeConnection.disconnect();
}
