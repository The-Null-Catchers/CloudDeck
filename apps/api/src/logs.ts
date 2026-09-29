import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.js';
import {authenticate,membership,audit} from './security.js';
import {sendAgentCommand} from './commands.js';

const params=z.object({serverId:z.uuid()});
const query=z.object({
  unit:z.string().regex(/^[A-Za-z0-9@_.:-]+\.service$/).max(180),
  limit:z.coerce.number().int().min(1).max(500).default(200)
}).strict();

export async function logRoutes(app:FastifyInstance) {
  app.get('/servers/:serverId/logs/systemd',async request=>{
    const {userId}=await authenticate(request);
    const {serverId}=params.parse(request.params);
    const {unit,limit}=query.parse(request.query);
    const server=await pool.query('SELECT organization_id FROM servers WHERE id=$1',[serverId]);
    if(!server.rowCount)throw Object.assign(new Error('Server not found'),{statusCode:404});
    const organizationId=server.rows[0].organization_id as string;
    await membership(userId,organizationId,'server.read');
    await audit(organizationId,userId,'logs.systemd.read','service',unit,request.ip,{serverId,limit});
    const result=z.object({
      lines:z.array(z.string().max(4000)).max(500),
      truncated:z.boolean()
    }).parse(await sendAgentCommand(serverId,'systemd.tailLogs',{serviceName:unit,limit}));
    return result;
  });
}
