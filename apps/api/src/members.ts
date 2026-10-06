import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool,transaction} from './db.js';
import {authenticate,membership,audit,randomToken,digest} from './security.js';
import {sendWorkspaceInvitation} from './mail.js';

const id=z.uuid();
const orgParams=z.object({orgId:id});
const memberParams=z.object({orgId:id,memberId:id});
const invitationParams=z.object({orgId:id,invitationId:id});
const roleSchema=z.enum(['admin','operator','viewer']);
const inviteSchema=z.object({email:z.email().max(320).transform(value=>value.toLowerCase()),role:roleSchema}).strict();
const roleBody=z.object({role:roleSchema}).strict();
const transferBody=z.object({memberId:id,confirm:z.literal(true)}).strict();
const acceptBody=z.object({token:z.string().min(20).max(256)}).strict();

export async function memberRoutes(app:FastifyInstance){
  app.get('/organizations/:orgId/members',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=orgParams.parse(request.params);
    await membership(userId,orgId,'server.read');
    const result=await pool.query(
      `SELECT u.id,u.email,u.email_verified_at,m.role,
              m.user_id=$2 AS is_current
       FROM organization_members m
       JOIN users u ON u.id=m.user_id
       WHERE m.organization_id=$1
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END,u.email`,
      [orgId,userId]
    );
    return {members:result.rows};
  });

  app.get('/organizations/:orgId/invitations',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=orgParams.parse(request.params);
    await membership(userId,orgId,'member.manage');
    const result=await pool.query(
      `SELECT i.id,i.email,i.role,i.expires_at,i.accepted_at,i.revoked_at,i.created_at,u.email AS invited_by_email
       FROM organization_invitations i
       LEFT JOIN users u ON u.id=i.invited_by
       WHERE i.organization_id=$1
       ORDER BY i.created_at DESC
       LIMIT 100`,
      [orgId]
    );
    return {invitations:result.rows};
  });

  app.post('/organizations/:orgId/invitations',{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async (request,reply)=>{
    const {userId}=await authenticate(request);
    const {orgId}=orgParams.parse(request.params);
    const input=inviteSchema.parse(request.body);
    await membership(userId,orgId,'member.manage');

    const existing=await pool.query(
      `SELECT 1 FROM organization_members m JOIN users u ON u.id=m.user_id
       WHERE m.organization_id=$1 AND lower(u.email)=lower($2)`,
      [orgId,input.email]
    );
    if(existing.rowCount)throw Object.assign(new Error('This user is already a workspace member'),{statusCode:409});

    const token=randomToken();
    const invitation=await transaction(async client=>{
      await client.query(
        `UPDATE organization_invitations SET revoked_at=now()
         WHERE organization_id=$1 AND lower(email)=lower($2) AND accepted_at IS NULL AND revoked_at IS NULL`,
        [orgId,input.email]
      );
      const result=await client.query(
        `INSERT INTO organization_invitations(organization_id,email,role,token_hash,invited_by,expires_at)
         VALUES($1,$2,$3,$4,$5,now()+interval '7 days')
         RETURNING id,email,role,expires_at,created_at`,
        [orgId,input.email,input.role,digest(token),userId]
      );
      return result.rows[0];
    });

    const org=await pool.query('SELECT name FROM organizations WHERE id=$1',[orgId]);
    await sendWorkspaceInvitation(input.email,org.rows[0]?.name??'CloudDeck workspace',input.role,token);
    await audit(orgId,userId,'member.invite','organization_invitation',invitation.id,request.ip,{email:input.email,role:input.role});
    reply.code(201);
    return invitation;
  });

  app.delete('/organizations/:orgId/invitations/:invitationId',async request=>{
    const {userId}=await authenticate(request);
    const {orgId,invitationId}=invitationParams.parse(request.params);
    await membership(userId,orgId,'member.manage');
    const result=await pool.query(
      `UPDATE organization_invitations SET revoked_at=now()
       WHERE id=$1 AND organization_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL
       RETURNING id,email,role`,
      [invitationId,orgId]
    );
    if(!result.rowCount)throw Object.assign(new Error('Active invitation not found'),{statusCode:404});
    await audit(orgId,userId,'member.invite.revoke','organization_invitation',invitationId,request.ip,{email:result.rows[0].email,role:result.rows[0].role});
    return {ok:true};
  });

  app.post('/invitations/accept',async request=>{
    const {userId}=await authenticate(request);
    const {token}=acceptBody.parse(request.body);
    const invitation=await transaction(async client=>{
      const result=await client.query(
        `SELECT i.id,i.organization_id,i.email,i.role,u.email AS user_email
         FROM organization_invitations i
         JOIN users u ON u.id=$2
         WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()
         FOR UPDATE`,
        [digest(token),userId]
      );
      if(!result.rowCount)throw Object.assign(new Error('Invalid or expired invitation'),{statusCode:400});
      const row=result.rows[0];
      if(row.email.toLowerCase()!==row.user_email.toLowerCase())throw Object.assign(new Error('Invitation email does not match your account'),{statusCode:403});
      await client.query(
        `INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)
         ON CONFLICT(organization_id,user_id) DO NOTHING`,
        [row.organization_id,userId,row.role]
      );
      await client.query('UPDATE organization_invitations SET accepted_at=now() WHERE id=$1',[row.id]);
      return row;
    });
    await audit(invitation.organization_id,userId,'member.invite.accept','organization_invitation',invitation.id,request.ip,{role:invitation.role});
    return {ok:true,organizationId:invitation.organization_id};
  });

  app.post('/organizations/:orgId/owner-transfer',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=orgParams.parse(request.params);
    const {memberId}=transferBody.parse(request.body);
    if(memberId===userId)throw Object.assign(new Error('You already own this workspace'),{statusCode:409});

    const transfer=await transaction(async client=>{
      const rows=await client.query(
        `SELECT m.user_id,m.role,u.email
         FROM organization_members m
         JOIN users u ON u.id=m.user_id
         WHERE m.organization_id=$1 AND m.user_id IN ($2,$3)
         FOR UPDATE`,
        [orgId,userId,memberId]
      );
      const current=rows.rows.find(row=>row.user_id===userId);
      const target=rows.rows.find(row=>row.user_id===memberId);
      if(!current)throw Object.assign(new Error('Workspace membership not found'),{statusCode:404});
      if(current.role!=='owner')throw Object.assign(new Error('Only the current workspace owner can transfer ownership'),{statusCode:403});
      if(!target)throw Object.assign(new Error('Target member not found'),{statusCode:404});
      if(target.role==='owner')throw Object.assign(new Error('Target member already owns this workspace'),{statusCode:409});

      await client.query('UPDATE organization_members SET role=$1 WHERE organization_id=$2 AND user_id=$3',['admin',orgId,userId]);
      await client.query('UPDATE organization_members SET role=$1 WHERE organization_id=$2 AND user_id=$3',['owner',orgId,memberId]);
      return {previousOwnerEmail:current.email as string,newOwnerEmail:target.email as string,previousTargetRole:target.role as string};
    });

    await audit(orgId,userId,'organization.owner.transfer','user',memberId,request.ip,{
      previousOwner:userId,
      previousOwnerEmail:transfer.previousOwnerEmail,
      newOwner:memberId,
      newOwnerEmail:transfer.newOwnerEmail,
      previousTargetRole:transfer.previousTargetRole,
      previousOwnerNewRole:'admin'
    });
    return {ok:true,ownerId:memberId,currentUserRole:'admin'};
  });

  app.patch('/organizations/:orgId/members/:memberId',async request=>{
    const {userId}=await authenticate(request);
    const {orgId,memberId}=memberParams.parse(request.params);
    const {role}=roleBody.parse(request.body);
    await membership(userId,orgId,'member.manage');
    const current=await pool.query('SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2',[orgId,memberId]);
    if(!current.rowCount)throw Object.assign(new Error('Member not found'),{statusCode:404});
    if(current.rows[0].role==='owner')throw Object.assign(new Error('Workspace owner role cannot be changed here'),{statusCode:409});
    await pool.query('UPDATE organization_members SET role=$1 WHERE organization_id=$2 AND user_id=$3',[role,orgId,memberId]);
    await audit(orgId,userId,'member.role.update','user',memberId,request.ip,{from:current.rows[0].role,to:role});
    return {ok:true,role};
  });

  app.delete('/organizations/:orgId/members/:memberId',async request=>{
    const {userId}=await authenticate(request);
    const {orgId,memberId}=memberParams.parse(request.params);
    await membership(userId,orgId,'member.manage');
    const current=await pool.query('SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2',[orgId,memberId]);
    if(!current.rowCount)throw Object.assign(new Error('Member not found'),{statusCode:404});
    if(current.rows[0].role==='owner')throw Object.assign(new Error('Workspace owner cannot be removed'),{statusCode:409});
    await pool.query('DELETE FROM organization_members WHERE organization_id=$1 AND user_id=$2',[orgId,memberId]);
    await audit(orgId,userId,'member.remove','user',memberId,request.ip,{role:current.rows[0].role});
    return {ok:true};
  });
}
