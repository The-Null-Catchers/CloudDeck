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
