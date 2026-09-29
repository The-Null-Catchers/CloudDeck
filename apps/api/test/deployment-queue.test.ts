import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deploymentQueueJob,deploymentQueueName} from '../src/deployment-queue.ts';

test('deployment queue jobs contain only the deployment identifier',()=>{
  const id='123e4567-e89b-12d3-a456-426614174000';
  const job=deploymentQueueJob(id);
  assert.equal(deploymentQueueName,'clouddeck-deployments');
  assert.equal(job.name,'execute');
  assert.deepEqual(job.data,{deploymentId:id});
  assert.equal(job.options.jobId,id);
  assert.equal(job.options.attempts,5);
  assert.deepEqual(job.options.backoff,{type:'exponential',delay:5000});
});

test('deployment queue rejects invalid identifiers before touching Redis',()=>{
  assert.throws(()=>deploymentQueueJob('not-a-uuid'));
});
