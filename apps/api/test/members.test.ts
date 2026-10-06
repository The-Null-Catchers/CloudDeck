import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../src/index.ts';
import {pool} from '../src/db.ts';

test('workspace owners can invite, manage, and remove non-owner members',async()=>{
  const app=buildApp();
  await app.ready();
  const suffix=crypto.randomUUID();
  const ownerEmail=`owner-${suffix}@example.com`;
  const memberEmail=`member-${suffix}@example.com`;
  const owner=await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{email:ownerEmail,password:'a secure owner passphrase 2026'}});
  const member=await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{email:memberEmail,password:'a secure member passphrase 2026'}});
  assert.equal(owner.statusCode,201,owner.body);assert.equal(member.statusCode,201,member.body);
  const ownerData=owner.json();const token=ownerData.accessToken as string;const orgId=ownerData.organizationId as string;

  const invite=await app.inject({method:'POST',url:`/api/v1/organizations/${orgId}/invitations`,headers:{authorization:`Bearer ${token}`},payload:{email:`pending-${suffix}@example.com`,role:'viewer'}});
  assert.equal(invite.statusCode,201,invite.body);
  const invitations=await app.inject({method:'GET',url:`/api/v1/organizations/${orgId}/invitations`,headers:{authorization:`Bearer ${token}`}});
  assert.equal(invitations.statusCode,200,invitations.body);assert.equal(invitations.json().invitations.length,1);
  const revoke=await app.inject({method:'DELETE',url:`/api/v1/organizations/${orgId}/invitations/${invite.json().id}`,headers:{authorization:`Bearer ${token}`}});
  assert.equal(revoke.statusCode,200,revoke.body);

  const memberRow=await pool.query('SELECT id FROM users WHERE email=$1',[memberEmail]);
  await pool.query('INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)',[orgId,memberRow.rows[0].id,'viewer']);
  const update=await app.inject({method:'PATCH',url:`/api/v1/organizations/${orgId}/members/${memberRow.rows[0].id}`,headers:{authorization:`Bearer ${token}`},payload:{role:'operator'}});
  assert.equal(update.statusCode,200,update.body);assert.equal(update.json().role,'operator');
  const remove=await app.inject({method:'DELETE',url:`/api/v1/organizations/${orgId}/members/${memberRow.rows[0].id}`,headers:{authorization:`Bearer ${token}`}});
  assert.equal(remove.statusCode,200,remove.body);
  const ownerRow=await pool.query('SELECT id FROM users WHERE email=$1',[ownerEmail]);
  const ownerRemoval=await app.inject({method:'DELETE',url:`/api/v1/organizations/${orgId}/members/${ownerRow.rows[0].id}`,headers:{authorization:`Bearer ${token}`}});
  assert.equal(ownerRemoval.statusCode,409,ownerRemoval.body);

  await pool.query('DELETE FROM users WHERE email=$1',[memberEmail]);
  await pool.query('DELETE FROM users WHERE email=$1',[ownerEmail]);
  await app.close();
});

test('only the current owner can explicitly transfer workspace ownership',async()=>{
  const app=buildApp();
  await app.ready();
  const suffix=crypto.randomUUID();
  const ownerEmail=`transfer-owner-${suffix}@example.com`;
  const targetEmail=`transfer-target-${suffix}@example.com`;
  const otherEmail=`transfer-other-${suffix}@example.com`;
  const password='a secure ownership transfer passphrase 2026';

  const owner=await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{email:ownerEmail,password}});
  const target=await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{email:targetEmail,password}});
  const other=await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{email:otherEmail,password}});
  assert.equal(owner.statusCode,201,owner.body);assert.equal(target.statusCode,201,target.body);assert.equal(other.statusCode,201,other.body);

  const ownerData=owner.json();
  const orgId=ownerData.organizationId as string;
  const ownerToken=ownerData.accessToken as string;
  const targetToken=target.json().accessToken as string;
  const otherToken=other.json().accessToken as string;
  const targetRow=await pool.query('SELECT id FROM users WHERE email=$1',[targetEmail]);
  const otherRow=await pool.query('SELECT id FROM users WHERE email=$1',[otherEmail]);
  const ownerRow=await pool.query('SELECT id FROM users WHERE email=$1',[ownerEmail]);
  const targetId=targetRow.rows[0].id as string;
  const otherId=otherRow.rows[0].id as string;
  const ownerId=ownerRow.rows[0].id as string;
  await pool.query('INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3),($1,$4,$5)',[orgId,targetId,'operator',otherId,'admin']);

  const missingConfirm=await app.inject({method:'POST',url:`/api/v1/organizations/${orgId}/owner-transfer`,headers:{authorization:`Bearer ${ownerToken}`},payload:{memberId:targetId}});
  assert.equal(missingConfirm.statusCode,400,missingConfirm.body);

  const nonOwnerAttempt=await app.inject({method:'POST',url:`/api/v1/organizations/${orgId}/owner-transfer`,headers:{authorization:`Bearer ${otherToken}`},payload:{memberId:targetId,confirm:true}});
  assert.equal(nonOwnerAttempt.statusCode,403,nonOwnerAttempt.body);

  const transfer=await app.inject({method:'POST',url:`/api/v1/organizations/${orgId}/owner-transfer`,headers:{authorization:`Bearer ${ownerToken}`},payload:{memberId:targetId,confirm:true}});
  assert.equal(transfer.statusCode,200,transfer.body);
  assert.equal(transfer.json().ownerId,targetId);
  assert.equal(transfer.json().currentUserRole,'admin');

  const roles=await pool.query('SELECT user_id,role FROM organization_members WHERE organization_id=$1 AND user_id IN ($2,$3,$4)',[orgId,ownerId,targetId,otherId]);
  const roleByUser=new Map(roles.rows.map(row=>[row.user_id,row.role]));
  assert.equal(roleByUser.get(ownerId),'admin');
  assert.equal(roleByUser.get(targetId),'owner');
  assert.equal(roleByUser.get(otherId),'admin');
  assert.equal(roles.rows.filter(row=>row.role==='owner').length,1);

  const oldOwnerRetry=await app.inject({method:'POST',url:`/api/v1/organizations/${orgId}/owner-transfer`,headers:{authorization:`Bearer ${ownerToken}`},payload:{memberId:otherId,confirm:true}});
  assert.equal(oldOwnerRetry.statusCode,403,oldOwnerRetry.body);

  const targetTransferBack=await app.inject({method:'POST',url:`/api/v1/organizations/${orgId}/owner-transfer`,headers:{authorization:`Bearer ${targetToken}`},payload:{memberId:ownerId,confirm:true}});
  assert.equal(targetTransferBack.statusCode,200,targetTransferBack.body);

  const audit=await pool.query("SELECT action,resource_id FROM audit_logs WHERE organization_id=$1 AND action='organization.owner.transfer' ORDER BY id DESC",[orgId]);
  assert.ok(audit.rowCount&&audit.rowCount>=2);

  await pool.query('DELETE FROM users WHERE email IN ($1,$2,$3)',[ownerEmail,targetEmail,otherEmail]);
  await app.close();
});
