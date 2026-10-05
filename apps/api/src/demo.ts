import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {transaction} from './db.js';
import {authenticate,audit} from './security.js';

const demoServers=[
  {name:'Production API',hostname:'prod-api-01',provider:'Oracle Cloud',region:'eu-frankfurt-1',os:'Ubuntu 24.04 LTS',arch:'x86_64',cpu:28,memory:54,disk:62,load:1.42,status:'online'},
  {name:'Database-01',hostname:'db-01',provider:'Hetzner',region:'fsn1',os:'Ubuntu 24.04 LTS',arch:'x86_64',cpu:17,memory:71,disk:68,load:0.84,status:'online'},
  {name:'Worker-01',hostname:'worker-01',provider:'Oracle Cloud',region:'eu-frankfurt-1',os:'Ubuntu 24.04 LTS',arch:'arm64',cpu:43,memory:47,disk:51,load:2.08,status:'online'},
  {name:'Staging',hostname:'staging-01',provider:'DigitalOcean',region:'fra1',os:'Ubuntu 22.04 LTS',arch:'x86_64',cpu:8,memory:35,disk:44,load:0.31,status:'offline'}
] as const;

export function demoMetricPoints(base:number,index:number){
  return Array.from({length:96},(_,i)=>{
    const wave=Math.sin((i+index*5)/7)*7+Math.cos((i+index)/13)*3;
    const cpu=Math.max(2,Math.min(92,base+wave));
    const memory=Math.max(10,Math.min(94,42+index*7+Math.sin(i/11)*5));
    const disk=Math.min(89,46+index*6+i*0.03);
    return {minutesAgo:(95-i)*15,cpu,memory,disk,load:Math.max(0.1,cpu/22)};
  });
}

async function createDemoWorkspace(db:pg.PoolClient,userId:string){
  const existing=await db.query(
    `SELECT o.id,o.name,o.demo
     FROM organizations o
     JOIN organization_members m ON m.organization_id=o.id
     WHERE m.user_id=$1 AND o.demo=true
     ORDER BY o.created_at DESC LIMIT 1`,
    [userId]
  );
  if(existing.rowCount)return {organization:existing.rows[0],created:false};

  const orgResult=await db.query(
    `INSERT INTO organizations(name,personal,demo) VALUES('CloudDeck Demo',false,true)
     RETURNING id,name,demo`,
  );
  const org=orgResult.rows[0];
  await db.query('INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)',[org.id,userId,'owner']);

  const serverIds:string[]=[];
  for(let index=0;index<demoServers.length;index++){
    const spec=demoServers[index];
    const inserted=await db.query(
      `INSERT INTO servers(
         organization_id,name,hostname,provider,region,operating_system,architecture,agent_version,tags,status,last_seen_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $10='online' THEN now() ELSE now()-interval '18 minutes' END)
       RETURNING id`,
      [org.id,spec.name,spec.hostname,spec.provider,spec.region,spec.os,spec.arch,'demo-1.0.0',['demo','simulated'],spec.status]
    );
    const serverId=inserted.rows[0].id as string;
    serverIds.push(serverId);
    for(const point of demoMetricPoints(spec.cpu,index)){
      await db.query(
        `INSERT INTO server_metrics(server_id,bucket_at,cpu_percent,memory_percent,disk_percent,load_1,network_rx_bytes,network_tx_bytes)
         VALUES($1,now()-($2::text||' minutes')::interval,$3,$4,$5,$6,$7,$8)`,
        [serverId,point.minutesAgo,point.cpu,point.memory,point.disk,point.load,2_000_000_000+index*900_000_000+(95-point.minutesAgo/15)*14_000_000,950_000_000+index*300_000_000+(95-point.minutesAgo/15)*9_000_000]
      );
    }
  }

  await db.query(
    `INSERT INTO services(server_id,name,state) VALUES
      ($1,'clouddeck-api','active'),($1,'caddy','active'),
      ($2,'postgresql','active'),($2,'node-exporter','active'),
      ($3,'clouddeck-worker','active'),($3,'redis','active'),
      ($4,'staging-api','inactive')`,
    serverIds
  );

  const appResult=await db.query(
    `INSERT INTO applications(organization_id,server_id,name)
     VALUES($1,$2,'CloudDeck API') RETURNING id`,
    [org.id,serverIds[0]]
  );
  const applicationId=appResult.rows[0].id as string;
  const deploymentSpecs=[
    {sha:'b4f9e92c2a146a1c7d0ad71e7df4c24382e4c101',state:'successful',hours:2},
    {sha:'84d11d70ac7d465f60f1a14818df55b0b8838520',state:'successful',hours:19},
    {sha:'31ff02e9e29ff5760a0d335409da7ea0d70ce499',state:'failed',hours:30}
  ] as const;
  for(const spec of deploymentSpecs){
    const dep=await db.query(
      `INSERT INTO deployments(application_id,commit_sha,branch,state,requested_by,created_at,started_at,finished_at,failure_code)
       VALUES($1,$2,'main',$3,$4,now()-($5::text||' hours')::interval,now()-($5::text||' hours')::interval+interval '1 minute',now()-($5::text||' hours')::interval+interval '4 minutes',CASE WHEN $3='failed' THEN 'HEALTH_CHECK_FAILED' ELSE NULL END)
       RETURNING id`,
      [applicationId,spec.sha,spec.state,userId,spec.hours]
    );
    const depId=dep.rows[0].id as string;
    const states=spec.state==='failed'?['queued','cloning','building','deploying','health-checking','failed']:['queued','cloning','building','deploying','health-checking','successful'];
    for(let index=0;index<states.length;index++){
      await db.query(
        `INSERT INTO deployment_events(deployment_id,state,message,created_at)
         VALUES($1,$2,$3,now()-($4::text||' hours')::interval+($5::text||' minutes')::interval)`,
        [depId,states[index],`Demo deployment ${states[index]}`,spec.hours,index]
      );
    }
  }

  const diskAlert=await db.query(
    `INSERT INTO alerts(organization_id,server_id,kind,state,created_at)
     VALUES($1,$2,'disk_high','open',now()-interval '24 minutes') RETURNING id`,
    [org.id,serverIds[1]]
  );
  await db.query(
    `INSERT INTO alerts(organization_id,server_id,kind,state,created_at)
     VALUES($1,$2,'server_offline','open',now()-interval '16 minutes')`,
    [org.id,serverIds[3]]
  );
  await db.query(
    `INSERT INTO notifications(user_id,alert_id,type,title,body,href,created_at) VALUES
      ($1,$2,'warning','Database disk usage elevated','Database-01 is approaching its configured disk threshold.', '/servers/'||$3, now()-interval '23 minutes'),
      ($1,NULL,'deployment','Deployment completed','CloudDeck API deployed successfully from main.', '/deployments', now()-interval '2 hours')`,
    [userId,diskAlert.rows[0].id,serverIds[1]]
  );

  return {organization:org,created:true,serverIds};
}

export async function demoRoutes(app:FastifyInstance){
  app.post('/demo/workspace',{config:{rateLimit:{max:3,timeWindow:'1 minute'}}},async (request,reply)=>{
    const {userId}=await authenticate(request);
    const result=await transaction(client=>createDemoWorkspace(client,userId));
    await audit(result.organization.id,userId,result.created?'demo.create':'demo.reuse','organization',result.organization.id,request.ip,{simulated:true});
    if(result.created)reply.code(201);
    return result;
  });
}
