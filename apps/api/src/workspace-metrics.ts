import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.js';
import {authenticate,membership} from './security.js';
import {metricResolution} from './metrics-retention.js';

const params=z.object({orgId:z.uuid()});
const query=z.object({range:z.enum(['1h','6h','24h','7d','30d']).default('24h')});
const intervals={'1h':'1 hour','6h':'6 hours','24h':'24 hours','7d':'7 days','30d':'30 days'} as const;

export async function workspaceMetricRoutes(app:FastifyInstance){
  app.get('/organizations/:orgId/metrics',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=params.parse(request.params);
    const {range}=query.parse(request.query);
    await membership(userId,orgId,'metrics.read');

    const current=await pool.query(`
      SELECT s.id,s.name,s.hostname,s.status,s.last_seen_at AS "lastSeenAt",
             m.cpu_percent AS "cpuPercent",m.memory_percent AS "memoryPercent",
             m.disk_percent AS "diskPercent",m.load_1 AS "load1",
             m.network_rx_bytes AS "networkRxBytes",m.network_tx_bytes AS "networkTxBytes"
      FROM servers s
      LEFT JOIN LATERAL (
        SELECT cpu_percent,memory_percent,disk_percent,load_1,network_rx_bytes,network_tx_bytes
        FROM server_metrics WHERE server_id=s.id ORDER BY bucket_at DESC LIMIT 1
      ) m ON true
      WHERE s.organization_id=$1
      ORDER BY s.name ASC
      LIMIT 200`,[orgId]);

    const resolution=metricResolution(range);
    const interval=intervals[range];
    const points=resolution==='minute'
      ? await pool.query(`
          SELECT m.bucket_at,
                 round(avg(m.cpu_percent),2) AS cpu_percent,
                 round(avg(m.memory_percent),2) AS memory_percent,
                 round(avg(m.disk_percent),2) AS disk_percent,
                 round(avg(m.load_1),2) AS load_1,
                 sum(m.network_rx_bytes)::bigint AS network_rx_bytes,
                 sum(m.network_tx_bytes)::bigint AS network_tx_bytes,
                 count(DISTINCT m.server_id)::integer AS reporting_servers
          FROM server_metrics m
          JOIN servers s ON s.id=m.server_id
          WHERE s.organization_id=$1 AND m.bucket_at>now()-$2::interval
          GROUP BY m.bucket_at
          ORDER BY m.bucket_at ASC
          LIMIT 10080`,[orgId,interval])
      : await pool.query(`
          WITH persisted AS (
            SELECT h.server_id,h.bucket_at,h.cpu_percent,h.memory_percent,h.disk_percent,h.load_1,h.network_rx_bytes,h.network_tx_bytes
            FROM server_metrics_hourly h JOIN servers s ON s.id=h.server_id
            WHERE s.organization_id=$1 AND h.bucket_at>now()-$2::interval
          ), raw_fallback AS (
            SELECT m.server_id,date_trunc('hour',m.bucket_at) AS bucket_at,
                   round(sum(m.cpu_percent*m.sample_count)/sum(m.sample_count),2) AS cpu_percent,
                   round(sum(m.memory_percent*m.sample_count)/sum(m.sample_count),2) AS memory_percent,
                   round(sum(m.disk_percent*m.sample_count)/sum(m.sample_count),2) AS disk_percent,
                   round(avg(m.load_1),2) AS load_1,
                   (array_agg(m.network_rx_bytes ORDER BY m.bucket_at DESC) FILTER(WHERE m.network_rx_bytes IS NOT NULL))[1] AS network_rx_bytes,
                   (array_agg(m.network_tx_bytes ORDER BY m.bucket_at DESC) FILTER(WHERE m.network_tx_bytes IS NOT NULL))[1] AS network_tx_bytes
            FROM server_metrics m JOIN servers s ON s.id=m.server_id
            WHERE s.organization_id=$1 AND m.bucket_at>now()-$2::interval
              AND NOT EXISTS(SELECT 1 FROM server_metrics_hourly h WHERE h.server_id=m.server_id AND h.bucket_at=date_trunc('hour',m.bucket_at))
            GROUP BY m.server_id,date_trunc('hour',m.bucket_at)
          ), combined AS (SELECT * FROM persisted UNION ALL SELECT * FROM raw_fallback)
          SELECT bucket_at,round(avg(cpu_percent),2) AS cpu_percent,round(avg(memory_percent),2) AS memory_percent,
                 round(avg(disk_percent),2) AS disk_percent,round(avg(load_1),2) AS load_1,
                 sum(network_rx_bytes)::bigint AS network_rx_bytes,sum(network_tx_bytes)::bigint AS network_tx_bytes,
                 count(DISTINCT server_id)::integer AS reporting_servers
          FROM combined GROUP BY bucket_at ORDER BY bucket_at ASC LIMIT 1000`,[orgId,interval]);

    return {range,resolution,servers:current.rows,points:points.rows};
  });
}
