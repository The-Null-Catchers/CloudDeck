import {transaction} from './db.js';
import {createOrganizationNotifications} from './notification-service.js';
// A small single-instance sweep. A distributed worker/leader lease is required before horizontal scaling.
// Synthetic demo workspaces are excluded because their fixture servers have no real heartbeat source.
export async function sweepOffline() {
  return transaction(async client => {
    const stale=await client.query(`UPDATE servers s SET status='offline' WHERE s.status='online' AND s.last_seen_at < now()-interval '90 seconds' AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id=s.organization_id AND o.demo=true) RETURNING s.id,s.organization_id,s.name`);
    for (const server of stale.rows) {
      const alert=await client.query(`INSERT INTO alerts(organization_id,server_id,kind,state) SELECT $1,$2,'server.offline','open' WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE server_id=$2 AND kind='server.offline' AND state IN ('open','acknowledged')) RETURNING id`,[server.organization_id,server.id]);
      if (alert.rowCount) await createOrganizationNotifications(server.organization_id,{alertId:alert.rows[0].id as string,type:'critical',title:`${server.name} is offline`,body:'CloudDeck stopped receiving agent heartbeats beyond the offline threshold.',href:'/alerts'},client);
    }
    return stale.rowCount ?? 0;
  });
}
export function startOfflineSweep() {
  const timer=setInterval(()=>sweepOffline().catch(error=>console.error('offline sweep failed',error)),30_000);
  return () => clearInterval(timer);
}
