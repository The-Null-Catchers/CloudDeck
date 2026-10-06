import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '../src/db.ts';
import {acquireDeploymentLease,releaseDeploymentLease,renewDeploymentLease} from '../src/deployment-leases.ts';

test('deployment leases serialize concurrent application execution and fence stale owners',async()=>{
  const suffix=randomUUID();
  const org=await pool.query('INSERT INTO organizations(name) VALUES($1) RETURNING id',[`lease-test-${suffix}`]);
  const organizationId=org.rows[0].id as string;
  const application=await pool.query(
    'INSERT INTO applications(organization_id,name) VALUES($1,$2) RETURNING id',
    [organizationId,`app-${suffix}`]
  );
  const applicationId=application.rows[0].id as string;
  const firstDeploymentId=randomUUID();
  const secondDeploymentId=randomUUID();

  await pool.query(
    `INSERT INTO deployments(id,application_id,state) VALUES($1,$3,'queued'),($2,$3,'queued')`,
    [firstDeploymentId,secondDeploymentId,applicationId]
  );

  try{
    const [firstToken,secondToken]=await Promise.all([
      acquireDeploymentLease(applicationId,firstDeploymentId),
      acquireDeploymentLease(applicationId,secondDeploymentId)
    ]);

    const acquired=[firstToken,secondToken].filter((value):value is string=>Boolean(value));
    assert.equal(acquired.length,1,'exactly one concurrent deployment must acquire the application lease');

    const winnerId=firstToken?firstDeploymentId:secondDeploymentId;
    const loserId=firstToken?secondDeploymentId:firstDeploymentId;
    const winnerToken=(firstToken??secondToken)!;

    const lease=await pool.query(
      'SELECT deployment_id,lease_token FROM deployment_execution_leases WHERE application_id=$1',
      [applicationId]
    );
    assert.equal(lease.rowCount,1);
    assert.equal(lease.rows[0].deployment_id,winnerId);
    assert.equal(lease.rows[0].lease_token,winnerToken);

    assert.equal(await renewDeploymentLease(applicationId,loserId,winnerToken),false,'another deployment cannot renew the active lease');
    assert.equal(await releaseDeploymentLease(applicationId,loserId,winnerToken),false,'another deployment cannot release the active lease');
    assert.equal(await renewDeploymentLease(applicationId,winnerId,winnerToken),true,'the active owner can renew its lease');
    assert.equal(await acquireDeploymentLease(applicationId,loserId),null,'an unexpired lease blocks later acquisition attempts');

    await pool.query(
      `UPDATE deployment_execution_leases SET expires_at=now()-interval '1 second' WHERE application_id=$1`,
      [applicationId]
    );
    const replacementToken=await acquireDeploymentLease(applicationId,loserId);
    assert.ok(replacementToken,'an expired lease can be atomically replaced');

    assert.equal(await renewDeploymentLease(applicationId,winnerId,winnerToken),false,'the stale owner is fenced after replacement');
    assert.equal(await releaseDeploymentLease(applicationId,winnerId,winnerToken),false,'the stale owner cannot delete the replacement lease');
    assert.equal(await releaseDeploymentLease(applicationId,loserId,replacementToken),true,'the replacement owner can release its lease');
  }finally{
    await pool.query('DELETE FROM deployments WHERE id=ANY($1::uuid[])',[[firstDeploymentId,secondDeploymentId]]);
    await pool.query('DELETE FROM applications WHERE id=$1',[applicationId]);
    await pool.query('DELETE FROM organizations WHERE id=$1',[organizationId]);
  }
});
