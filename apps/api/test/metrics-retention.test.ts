import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '../src/db.ts';
import {metricResolution,metricRetentionConfig,runMetricRollup} from '../src/metrics-retention.ts';

test('metric retention config is bounded and long ranges use hourly resolution',()=>{
  assert.deepEqual(metricRetentionConfig({
    METRICS_RAW_RETENTION_HOURS:'72',
    METRICS_HOURLY_RETENTION_DAYS:'120'
  } as NodeJS.ProcessEnv),{rawHours:72,hourlyDays:120});
  assert.deepEqual(metricRetentionConfig({
    METRICS_RAW_RETENTION_HOURS:'2',
    METRICS_HOURLY_RETENTION_DAYS:'9999'
  } as NodeJS.ProcessEnv),{rawHours:48,hourlyDays:90});
  assert.equal(metricResolution('24h'),'minute');
  assert.equal(metricResolution('7d'),'hour');
  assert.equal(metricResolution('30d'),'hour');
});

test('rollup preserves weighted utilization and latest network counters before raw deletion',async()=>{
  const org=await pool.query("INSERT INTO organizations(name) VALUES('Metrics rollup test') RETURNING id");
  const server=await pool.query(
    "INSERT INTO servers(organization_id,name,status) VALUES($1,'metrics-test','offline') RETURNING id",
    [org.rows[0].id]
  );
  const serverId=server.rows[0].id as string;
  const now=new Date();
  const first=new Date(now.getTime()-50*60*60*1000);
  first.setUTCMinutes(5,0,0);
  const second=new Date(first.getTime()+20*60*1000);
  try{
    await pool.query(
      `INSERT INTO server_metrics(server_id,bucket_at,sample_count,cpu_percent,memory_percent,disk_percent,load_1,network_rx_bytes,network_tx_bytes)
       VALUES
       ($1,$2,1,10,40,60,1.0,100,150),
       ($1,$3,3,30,80,80,3.0,200,250)`,
      [serverId,first,second]
    );
    const result=await runMetricRollup(now);
    assert.ok(result.rolledUp>=1);
    assert.ok(result.rawDeleted>=2);
    const hourly=await pool.query(
      `SELECT sample_count,cpu_percent,memory_percent,disk_percent,load_1,network_rx_bytes,network_tx_bytes
       FROM server_metrics_hourly WHERE server_id=$1`,
      [serverId]
    );
    assert.equal(hourly.rowCount,1);
    const row=hourly.rows[0];
    assert.equal(Number(row.sample_count),4);
    assert.equal(Number(row.cpu_percent),25);
    assert.equal(Number(row.memory_percent),70);
    assert.equal(Number(row.disk_percent),75);
    assert.equal(Number(row.load_1),2);
    assert.equal(Number(row.network_rx_bytes),200);
    assert.equal(Number(row.network_tx_bytes),250);
    const raw=await pool.query('SELECT count(*)::integer AS count FROM server_metrics WHERE server_id=$1',[serverId]);
    assert.equal(raw.rows[0].count,0);
  }finally{
    await pool.query('DELETE FROM organizations WHERE id=$1',[org.rows[0].id]);
  }
});
