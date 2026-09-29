import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, transaction } from './db.js';
import { digest, randomToken } from './security.js';
import {attachAgent,detachAgent,resolveAgentResult,resolveAgentStream,resolveDeploymentProgress} from './commands.js';
import {resolveAgentTerminal} from './terminal.js';
const uuid = z.uuid();
const sample = z.object({type:z.literal('metrics'),cpuPercent:z.number().min(0).max(100),memoryPercent:z.number().min(0).max(100),diskPercent:z.number().min(0).max(100),load1:z.number().min(0).max(100000),networkRxBytes:z.number().int().nonnegative(),networkTxBytes:z.number().int().nonnegative()});
const hello = z.object({type:z.literal('hello'),hostname:z.string().max(255),operatingSystem:z.string().max(100),architecture:z.string().max(50),agentVersion:z.string().max(32)});
async function authorize(serverId:string, token:string) {
  const result = await pool.query('SELECT 1 FROM server_agents WHERE server_id=$1 AND credential_hash=$2 AND revoked_at IS NULL',[serverId,digest(token)]);
  return !!result.rowCount;
}
export async function agentRoutes(app: FastifyInstance) {
  app.post('/pair', async (request,reply) => {
    const {serverId,token} = z.object({serverId:uuid,token:z.string().min(20)}).parse(request.body);
    const credential = randomToken();
    const paired = await pool.query(`UPDATE server_agents SET credential_hash=$1,pairing_hash=NULL,pairing_expires_at=NULL,paired_at=now() WHERE server_id=$2 AND pairing_hash=$3 AND pairing_expires_at>now() AND paired_at IS NULL RETURNING server_id`,[digest(credential),serverId,digest(token)]);
    if (!paired.rowCount) throw Object.assign(new Error('Invalid or expired pairing token'),{statusCode:401});
    reply.code(201); return {credential};
  });
  app.get('/connect/:serverId',{websocket:true}, (socket,request) => {
    const parsed = z.object({serverId:uuid}).safeParse(request.params);
    const credential = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
    if (!parsed.success || !credential) { socket.close(1008,'Unauthorized'); return; }
    const serverId = parsed.data.serverId;
    const authorization=authorize(serverId,credential).catch(()=>false);
    void authorization.then(valid=>{if(!valid)socket.close(1008,'Unauthorized');});
    let lastMessage = Date.now();
    const timer = setInterval(() => { if (Date.now()-lastMessage>90_000) socket.close(1001,'Heartbeat timeout'); },30_000);
    let ready=false;
    socket.on('close', () => {clearInterval(timer);detachAgent(serverId,socket);});
    socket.on('message',async (raw: Buffer) => {
      if(!await authorization)return;
      if (raw.length > 262144) {socket.close(1009,'Message too large');return;}
      let message: unknown;
      try { message=JSON.parse(raw.toString()); } catch {socket.close(1007,'Invalid JSON');return;}
      if ((message as {type?:unknown})?.type==='command.result') {if(!resolveAgentResult(serverId,message))socket.close(1007,'Unknown command result');lastMessage=Date.now();return;}
      if ((message as {type?:unknown})?.type==='stream.data') {if(!resolveAgentStream(serverId,message))socket.close(1007,'Unknown stream result');lastMessage=Date.now();return;}
      if ((message as {type?:unknown})?.type==='deployment.progress') {if(!resolveDeploymentProgress(message))socket.close(1007,'Unknown deployment progress');lastMessage=Date.now();return;}
      if ((message as {type?:unknown})?.type==='terminal.data' || (message as {type?:unknown})?.type==='terminal.exit') {if(!resolveAgentTerminal(serverId,message))socket.close(1007,'Unknown terminal result');lastMessage=Date.now();return;}
      if(raw.length>8192){socket.close(1009,'Message too large');return;}
      const h = hello.safeParse(message);
      const m = sample.safeParse(message);
      if (!h.success && !m.success) {socket.close(1007,'Invalid message');return;}
      lastMessage=Date.now();
      try {
        if (h.success) {if(!ready && !attachAgent(serverId,socket)){socket.close(1008,'Agent already connected');return;}ready=true;await pool.query(`UPDATE servers SET hostname=$2,operating_system=$3,architecture=$4,agent_version=$5,status='online',last_seen_at=now() WHERE id=$1`,[serverId,h.data.hostname,h.data.operatingSystem,h.data.architecture,h.data.agentVersion]);}
        else if (m.success) {if(!ready){socket.close(1008,'Hello required');return;}await transaction(async client => {
          await client.query(`UPDATE servers SET status='online',last_seen_at=now() WHERE id=$1`,[serverId]);
          // A 60-second bucket bounds write frequency; averages absorb multiple samples.
          await client.query(`INSERT INTO server_metrics(server_id,bucket_at,cpu_percent,memory_percent,disk_percent,load_1,network_rx_bytes,network_tx_bytes) VALUES($1,date_trunc('minute',now()),$2,$3,$4,$5,$6,$7) ON CONFLICT(server_id,bucket_at) DO UPDATE SET sample_count=server_metrics.sample_count+1,cpu_percent=(server_metrics.cpu_percent*server_metrics.sample_count+EXCLUDED.cpu_percent)/(server_metrics.sample_count+1),memory_percent=(server_metrics.memory_percent*server_metrics.sample_count+EXCLUDED.memory_percent)/(server_metrics.sample_count+1),disk_percent=(server_metrics.disk_percent*server_metrics.sample_count+EXCLUDED.disk_percent)/(server_metrics.sample_count+1),load_1=EXCLUDED.load_1,network_rx_bytes=EXCLUDED.network_rx_bytes,network_tx_bytes=EXCLUDED.network_tx_bytes`,[serverId,m.data.cpuPercent,m.data.memoryPercent,m.data.diskPercent,m.data.load1,m.data.networkRxBytes,m.data.networkTxBytes]);
        });}
        await pool.query(`UPDATE alerts SET state='resolved' WHERE server_id=$1 AND kind='server.offline' AND state IN ('open','acknowledged')`,[serverId]);
        socket.send(JSON.stringify({type:'ack'}));
      } catch {socket.close(1011,'Storage unavailable');}
    });
  });
}
