import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.js';
import {authenticate,membership,audit,digest,randomToken} from './security.js';

const uuid=z.uuid();
const params=z.object({deploymentId:uuid});
const historyQuery=z.object({
  after:z.coerce.number().int().nonnegative().default(0),
  limit:z.coerce.number().int().min(1).max(500).default(200)
}).strict();
const ticketBody=z.object({
  afterId:z.number().int().nonnegative().default(0)
}).strict();
const streamQuery=z.object({ticket:z.string().min(20),afterId:z.coerce.number().int().nonnegative().default(0)}).strict();
const terminalStates=new Set(['successful','failed','rolled-back']);

async function deploymentAccess(deploymentId:string,userId:string){
  const result=await pool.query(
    `SELECT a.organization_id
     FROM deployments d
     JOIN applications a ON a.id=d.application_id
     WHERE d.id=$1`,
    [deploymentId]
  );
  if(!result.rowCount)throw Object.assign(new Error('Deployment not found'),{statusCode:404});
  const organizationId=result.rows[0].organization_id as string;
  await membership(userId,organizationId,'deployment.read');
  return organizationId;
}

async function readLogs(deploymentId:string,after:number,limit:number){
  const rows=await pool.query(
    `SELECT id,stage,stream,line,created_at
     FROM deployment_logs
     WHERE deployment_id=$1 AND id>$2
     ORDER BY id ASC
     LIMIT $3`,
    [deploymentId,after,limit]
  );
  return rows.rows;
}

export async function deploymentLogRoutes(app:FastifyInstance){
  app.get('/deployments/:deploymentId/logs',async request=>{
    const {userId}=await authenticate(request);
    const {deploymentId}=params.parse(request.params);
    const {after,limit}=historyQuery.parse(request.query);
    await deploymentAccess(deploymentId,userId);
    const logs=await readLogs(deploymentId,after,limit);
    return {
      logs,
      nextAfter:logs.length?Number(logs[logs.length-1].id):after
    };
  });

  app.post('/deployments/:deploymentId/logs/ticket',async request=>{
    const {userId}=await authenticate(request);
    const {deploymentId}=params.parse(request.params);
    const {afterId}=ticketBody.parse(request.body??{});
    const organizationId=await deploymentAccess(deploymentId,userId);
    await pool.query('DELETE FROM deployment_log_tickets WHERE expires_at<=now() OR consumed_at IS NOT NULL');
    const token=randomToken();
    await pool.query(
      `INSERT INTO deployment_log_tickets(token_hash,deployment_id,user_id,expires_at)
       VALUES($1,$2,$3,now()+interval '30 seconds')`,
      [digest(token),deploymentId,userId]
    );
    await audit(organizationId,userId,'deployment.logs.stream.ticket','deployment',deploymentId,request.ip,{afterId});
    return {ticket:token,afterId,expiresInSeconds:30};
  });

  app.get('/deployment-logs/stream',{websocket:true},(socket,request)=>{
    const parsed=streamQuery.safeParse(request.query);
    if(!parsed.success){socket.close(1008,'Invalid ticket');return;}
    const tokenHash=digest(parsed.data.ticket);
    let closed=false;
    let cursor=parsed.success?parsed.data.afterId:0;
    let timer:ReturnType<typeof setTimeout>|null=null;
    const finish=(code=1000,reason='Deployment log stream closed')=>{
      if(closed)return;
      closed=true;
      if(timer)clearTimeout(timer);
      if(socket.readyState===1)socket.close(code,reason);
    };
    socket.on('close',()=>finish());
    socket.on('error',()=>finish());

    void (async()=>{
      const consumed=await pool.query(
        `UPDATE deployment_log_tickets
         SET consumed_at=now()
         WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now()
         RETURNING deployment_id,user_id`,
        [tokenHash]
      );
      if(!consumed.rowCount){finish(1008,'Expired ticket');return;}
      const deploymentId=consumed.rows[0].deployment_id as string;
      const userId=consumed.rows[0].user_id as string;
      const access=await pool.query(
        `SELECT d.state,a.organization_id
         FROM deployments d
         JOIN applications a ON a.id=d.application_id
         JOIN organization_members m ON m.organization_id=a.organization_id AND m.user_id=$2
         WHERE d.id=$1`,
        [deploymentId,userId]
      );
      if(!access.rowCount){finish(1008,'Access denied');return;}
      socket.send(JSON.stringify({type:'ready',deploymentId,afterId:cursor}));

      const poll=async()=>{
        if(closed)return;
        try{
          const [logs,state]=await Promise.all([
            readLogs(deploymentId,cursor,200),
            pool.query('SELECT state FROM deployments WHERE id=$1',[deploymentId])
          ]);
          for(const row of logs){
            cursor=Number(row.id);
            if(socket.readyState!==1){finish();return;}
            socket.send(JSON.stringify({
              type:'log',
              id:cursor,
              stage:row.stage,
              stream:row.stream,
              line:row.line,
              createdAt:row.created_at
            }));
          }
          const current=state.rows[0]?.state as string|undefined;
          if(current&&terminalStates.has(current)&&logs.length===0){
            if(socket.readyState===1)socket.send(JSON.stringify({type:'done',state:current,afterId:cursor}));
            finish(1000,'Deployment completed');
            return;
          }
          timer=setTimeout(()=>void poll(),700);
        }catch{
          finish(1011,'Deployment log storage unavailable');
        }
      };
      await poll();
    })().catch(()=>finish(1011,'Deployment log stream unavailable'));
  });
}
