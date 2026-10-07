import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '../src/db.ts';
import {transitionDeployment} from '../src/deployments.ts';

async function fixture(state:'queued'|'health-checking'){
  const suffix=crypto.randomUUID();
  const user=await pool.query(
    `INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id`,
    [`transition-race-${suffix}@example.com`,'test-hash']
  );
  const org=await pool.query(
    `INSERT INTO organizations(name) VALUES($1) RETURNING id`,
    [`transition-race-${suffix}`]
  );
  await pool.query(
    `INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')`,
    [org.rows[0].id,user.rows[0].id]
  );
  const app=await pool.query(
    `INSERT INTO applications(organization_id,name) VALUES($1,$2) RETURNING id`,
    [org.rows[0].id,`app-${suffix}`]
  );
  const deployment=await pool.query(
    `INSERT INTO deployments(application_id,state,requested_by) VALUES($1,$2,$3) RETURNING id`,
    [app.rows[0].id,state,user.rows[0].id]
  );
  return {
    deploymentId:deployment.rows[0].id as string,
    async cleanup(){
      await pool.query('DELETE FROM deployments WHERE id=$1',[deployment.rows[0].id]);
      await pool.query('DELETE FROM applications WHERE id=$1',[app.rows[0].id]);
      await pool.query('DELETE FROM organizations WHERE id=$1',[org.rows[0].id]);
      await pool.query('DELETE FROM users WHERE id=$1',[user.rows[0].id]);
    }
  };
}

function statusCode(reason:unknown){
  return typeof reason==='object'&&reason!==null&&'statusCode' in reason
    ?(reason as {statusCode?:unknown}).statusCode
    :undefined;
}

test('concurrent worker claims cannot transition the same queued deployment twice',async()=>{
  const data=await fixture('queued');
  try{
    const results=await Promise.allSettled([
      transitionDeployment(data.deploymentId,'cloning',{message:'worker-a claimed'}),
      transitionDeployment(data.deploymentId,'cloning',{message:'worker-b claimed'})
    ]);
    const fulfilled=results.filter(result=>result.status==='fulfilled');
    const rejected=results.filter(result=>result.status==='rejected');
    assert.equal(fulfilled.length,1);
    assert.equal(rejected.length,1);
    assert.equal(statusCode((rejected[0] as PromiseRejectedResult).reason),409);

    const row=await pool.query('SELECT state,started_at,finished_at FROM deployments WHERE id=$1',[data.deploymentId]);
    assert.equal(row.rows[0].state,'cloning');
    assert.ok(row.rows[0].started_at);
    assert.equal(row.rows[0].finished_at,null);
    const events=await pool.query(
      `SELECT state,message FROM deployment_events WHERE deployment_id=$1 ORDER BY id`,
      [data.deploymentId]
    );
    assert.equal(events.rowCount,1);
    assert.equal(events.rows[0].state,'cloning');
  }finally{await data.cleanup();}
});

test('success and cancellation races produce exactly one terminal deployment outcome',async()=>{
  const data=await fixture('health-checking');
  try{
    const results=await Promise.allSettled([
      transitionDeployment(data.deploymentId,'successful',{message:'readiness passed'}),
      transitionDeployment(data.deploymentId,'cancelled',{message:'operator cancelled'})
    ]);
    const fulfilled=results.filter(result=>result.status==='fulfilled');
    const rejected=results.filter(result=>result.status==='rejected');
    assert.equal(fulfilled.length,1);
    assert.equal(rejected.length,1);
    assert.equal(statusCode((rejected[0] as PromiseRejectedResult).reason),409);

    const row=await pool.query('SELECT state,finished_at FROM deployments WHERE id=$1',[data.deploymentId]);
    assert.ok(['successful','cancelled'].includes(row.rows[0].state));
    assert.ok(row.rows[0].finished_at);
    const events=await pool.query(
      `SELECT state FROM deployment_events WHERE deployment_id=$1 ORDER BY id`,
      [data.deploymentId]
    );
    assert.equal(events.rowCount,1);
    assert.equal(events.rows[0].state,row.rows[0].state);
  }finally{await data.cleanup();}
});
