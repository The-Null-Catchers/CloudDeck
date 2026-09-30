import type pg from 'pg';

export type OrganizationNotification={
  alertId?:string|null;
  type:string;
  title:string;
  body?:string|null;
  href?:string|null;
};

export async function createOrganizationNotifications(
  organizationId:string,
  notification:OrganizationNotification,
  db:Pick<pg.PoolClient,'query'>
){
  const result=await db.query(
    `WITH inserted AS (
       INSERT INTO notifications(user_id,alert_id,type,title,body,href)
       SELECT m.user_id,$2,$3,$4,$5,$6
       FROM organization_members m
       WHERE m.organization_id=$1
       RETURNING id,user_id
     ),
     deliveries AS (
       INSERT INTO notification_deliveries(notification_id,channel)
       SELECT i.id,'email'
       FROM inserted i
       JOIN users u ON u.id=i.user_id
       WHERE u.email_verified_at IS NOT NULL
       ON CONFLICT(notification_id,channel) DO NOTHING
       RETURNING notification_id
     )
     SELECT
       (SELECT count(*)::integer FROM inserted) AS notifications,
       (SELECT count(*)::integer FROM deliveries) AS email_deliveries`,
    [
      organizationId,
      notification.alertId??null,
      notification.type,
      notification.title.slice(0,200),
      notification.body?.slice(0,1000)??null,
      notification.href?.slice(0,500)??null
    ]
  );
  return {
    notifications:Number(result.rows[0]?.notifications??0),
    emailDeliveries:Number(result.rows[0]?.email_deliveries??0)
  };
}
