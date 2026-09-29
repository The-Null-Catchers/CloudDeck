import {transaction} from './db.js';
// A small single-instance sweep. A distributed worker/leader lease is required before horizontal scaling.
export async function sweepOffline() {
  return transaction(async client => {
    const stale=await client.query(`UPDATE servers SET status='offline' WHERE status='online' AND last_seen_at < now()-interval '90 seconds' RETURNING id,organization_id,name`);
    for (const server of stale.rows) {
      const alert=await client.query(`INSERT INTO alerts(organization_id,server_id,kind,state) SELECT $1,$2,'server.offline','open' WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE server_id=$2 AND kind='server.offline' AND state IN ('open','acknowledged')) RETURNING id`,[server.organization_id,server.id]);
      if (alert.rowCount) await client.query(`INSERT INTO notifications(user_id,alert_id,type,title) SELECT user_id,$1,'critical',$2 FROM organization_members WHERE organization_id=$3`,[alert.rows[0].id,`${server.name} is offline`,server.organization_id]);
    }
    return stale.rowCount ?? 0;
  });
}
export function startOfflineSweep() {
  const timer=setInterval(()=>sweepOffline().catch(error=>console.error('offline sweep failed',error)),30_000);
  return () => clearInterval(timer);
}
