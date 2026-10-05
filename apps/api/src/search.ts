import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.js';
import {authenticate,membership} from './security.js';

const paramsSchema=z.object({orgId:z.uuid()});
const querySchema=z.object({q:z.string().trim().min(2).max(120),limit:z.coerce.number().int().min(1).max(40).default(20)}).strict();

export function normalizeSearchQuery(value:string){
  return value.trim().replace(/\s+/g,' ').slice(0,120);
}

export async function searchRoutes(app:FastifyInstance){
  app.get('/organizations/:orgId/search',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=paramsSchema.parse(request.params);
    const parsed=querySchema.parse(request.query);
    await membership(userId,orgId,'server.read');
    const q=normalizeSearchQuery(parsed.q);
    const pattern=`%${q.replaceAll('%','\\%').replaceAll('_','\\_')}%`;
    const result=await pool.query(
      `WITH matches AS (
         SELECT 'server'::text AS kind,s.id::text AS id,s.name AS title,
                COALESCE(s.hostname,s.provider,s.status) AS subtitle,
                '/servers/'||s.id::text AS href,1 AS rank
         FROM servers s
         WHERE s.organization_id=$1 AND (s.name ILIKE $2 ESCAPE '\\' OR COALESCE(s.hostname,'') ILIKE $2 ESCAPE '\\' OR COALESCE(s.provider,'') ILIKE $2 ESCAPE '\\')
         UNION ALL
         SELECT 'service',svc.id::text,svc.name,s.name||' · '||svc.state,
                '/servers/'||s.id::text||'#services',2
         FROM services svc JOIN servers s ON s.id=svc.server_id
         WHERE s.organization_id=$1 AND svc.name ILIKE $2 ESCAPE '\\'
         UNION ALL
         SELECT 'container',c.id::text,c.name,s.name||' · '||c.state,
                '/servers/'||s.id::text||'#docker',2
         FROM containers c JOIN servers s ON s.id=c.server_id
         WHERE s.organization_id=$1 AND c.name ILIKE $2 ESCAPE '\\'
         UNION ALL
         SELECT 'deployment',d.id::text,a.name,
                COALESCE(d.branch,'unknown branch')||' · '||d.state,
                '/deployments?deployment='||d.id::text,3
         FROM deployments d JOIN applications a ON a.id=d.application_id
         WHERE a.organization_id=$1 AND (a.name ILIKE $2 ESCAPE '\\' OR COALESCE(d.branch,'') ILIKE $2 ESCAPE '\\' OR COALESCE(d.commit_sha,'') ILIKE $2 ESCAPE '\\')
         UNION ALL
         SELECT 'domain',dom.id::text,dom.hostname,a.name||' · '||dom.proxy_type,
                '/domains?domain='||dom.id::text,3
         FROM domains dom JOIN applications a ON a.id=dom.application_id
         WHERE a.organization_id=$1 AND (dom.hostname ILIKE $2 ESCAPE '\\' OR a.name ILIKE $2 ESCAPE '\\')
       )
       SELECT kind,id,title,subtitle,href FROM matches
       ORDER BY rank,title
       LIMIT $3`,
      [orgId,pattern,parsed.limit]
    );
    return {query:q,results:result.rows};
  });
}
