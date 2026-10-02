import {pool,transaction} from './db.js';

function boundedInteger(value:string|undefined,fallback:number,min:number,max:number){
  if(value===undefined||value.trim()==='')return fallback;
  const parsed=Number(value);
  if(!Number.isInteger(parsed)||parsed<min||parsed>max)return fallback;
  return parsed;
}

export function metricRetentionConfig(env:NodeJS.ProcessEnv=process.env){
  return {
    rawHours:boundedInteger(env.METRICS_RAW_RETENTION_HOURS,48,24,168),
    hourlyDays:boundedInteger(env.METRICS_HOURLY_RETENTION_DAYS,90,30,365)
  };
}

export async function runMetricRollup(now=new Date()){
  const config=metricRetentionConfig();
  return transaction(async db=>{
    const rollup=await db.query(
      `INSERT INTO server_metrics_hourly(
         server_id,bucket_at,sample_count,cpu_percent,memory_percent,disk_percent,load_1,network_rx_bytes,network_tx_bytes
       )
       SELECT
         server_id,
         date_trunc('hour',bucket_at) AS bucket_at,
         sum(sample_count)::bigint AS sample_count,
         round(sum(cpu_percent*sample_count)/sum(sample_count),2) AS cpu_percent,
         round(sum(memory_percent*sample_count)/sum(sample_count),2) AS memory_percent,
         round(sum(disk_percent*sample_count)/sum(sample_count),2) AS disk_percent,
         round(avg(load_1),2) AS load_1,
         (array_agg(network_rx_bytes ORDER BY bucket_at DESC) FILTER (WHERE network_rx_bytes IS NOT NULL))[1] AS network_rx_bytes,
         (array_agg(network_tx_bytes ORDER BY bucket_at DESC) FILTER (WHERE network_tx_bytes IS NOT NULL))[1] AS network_tx_bytes
       FROM server_metrics
       WHERE bucket_at < date_trunc('hour',$1::timestamptz)
       GROUP BY server_id,date_trunc('hour',bucket_at)
       ON CONFLICT(server_id,bucket_at) DO UPDATE SET
         sample_count=EXCLUDED.sample_count,
         cpu_percent=EXCLUDED.cpu_percent,
         memory_percent=EXCLUDED.memory_percent,
         disk_percent=EXCLUDED.disk_percent,
         load_1=EXCLUDED.load_1,
         network_rx_bytes=EXCLUDED.network_rx_bytes,
         network_tx_bytes=EXCLUDED.network_tx_bytes`,
      [now]
    );
    const raw=await db.query(
      `DELETE FROM server_metrics m
       WHERE m.bucket_at < $1::timestamptz - $2::interval
         AND EXISTS (
           SELECT 1 FROM server_metrics_hourly h
           WHERE h.server_id=m.server_id
             AND h.bucket_at=date_trunc('hour',m.bucket_at)
         )`,
      [now,`${config.rawHours} hours`]
    );
    const hourly=await db.query(
      'DELETE FROM server_metrics_hourly WHERE bucket_at < $1::timestamptz - $2::interval',
      [now,`${config.hourlyDays} days`]
    );
    return {rolledUp:rollup.rowCount??0,rawDeleted:raw.rowCount??0,hourlyDeleted:hourly.rowCount??0,config};
  });
}

export function startMetricRollupRunner(){
  const intervalMs=10*60_000;
  let running=false;
  let stopped=false;
  const tick=async()=>{
    if(stopped||running)return;
    running=true;
    try{await runMetricRollup()}
    catch(error){void error}
    finally{running=false}
  };
  void tick();
  const timer=setInterval(()=>void tick(),intervalMs);
  timer.unref?.();
  return ()=>{stopped=true;clearInterval(timer)};
}

export function metricResolution(range:'1h'|'6h'|'24h'|'7d'|'30d'){
  return range==='7d'||range==='30d'?'hour':'minute';
}

export async function queryServerMetrics(serverId:string,range:'1h'|'6h'|'24h'|'7d'|'30d'){
  const ranges={'1h':'1 hour','6h':'6 hours','24h':'24 hours','7d':'7 days','30d':'30 days'} as const;
  if(metricResolution(range)==='minute'){
    const result=await pool.query(
      `SELECT bucket_at,cpu_percent,memory_percent,disk_percent,load_1,network_rx_bytes,network_tx_bytes
       FROM server_metrics
       WHERE server_id=$1 AND bucket_at > now()-$2::interval
       ORDER BY bucket_at ASC
       LIMIT 10080`,
      [serverId,ranges[range]]
    );
    return {resolution:'minute' as const,points:result.rows};
  }

  const result=await pool.query(
    `WITH persisted AS (
       SELECT bucket_at,cpu_percent,memory_percent,disk_percent,load_1,network_rx_bytes,network_tx_bytes
       FROM server_metrics_hourly
       WHERE server_id=$1 AND bucket_at > now()-$2::interval
     ),
     raw_fallback AS (
       SELECT
         date_trunc('hour',m.bucket_at) AS bucket_at,
         round(sum(m.cpu_percent*m.sample_count)/sum(m.sample_count),2) AS cpu_percent,
         round(sum(m.memory_percent*m.sample_count)/sum(m.sample_count),2) AS memory_percent,
         round(sum(m.disk_percent*m.sample_count)/sum(m.sample_count),2) AS disk_percent,
         round(avg(m.load_1),2) AS load_1,
         (array_agg(m.network_rx_bytes ORDER BY m.bucket_at DESC) FILTER (WHERE m.network_rx_bytes IS NOT NULL))[1] AS network_rx_bytes,
         (array_agg(m.network_tx_bytes ORDER BY m.bucket_at DESC) FILTER (WHERE m.network_tx_bytes IS NOT NULL))[1] AS network_tx_bytes
       FROM server_metrics m
       WHERE m.server_id=$1
         AND m.bucket_at > now()-$2::interval
         AND NOT EXISTS (
           SELECT 1 FROM server_metrics_hourly h
           WHERE h.server_id=m.server_id
             AND h.bucket_at=date_trunc('hour',m.bucket_at)
         )
       GROUP BY date_trunc('hour',m.bucket_at)
     )
     SELECT * FROM persisted
     UNION ALL
     SELECT * FROM raw_fallback
     ORDER BY bucket_at ASC
     LIMIT 1000`,
    [serverId,ranges[range]]
  );
  return {resolution:'hour' as const,points:result.rows};
}
