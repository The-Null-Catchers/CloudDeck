import {test} from 'node:test';
import assert from 'node:assert/strict';
import {notificationQueueJob} from '../src/notification-queue.ts';

test('notification queue jobs contain only the durable delivery identifier',()=>{
  const job=notificationQueueJob('42');
  assert.equal(job.name,'email');
  assert.deepEqual(job.data,{deliveryId:'42'});
  assert.equal(job.options.jobId,'email-42');
  assert.equal(job.options.attempts,5);
});

test('notification queue rejects malformed identifiers before touching Redis',()=>{
  for(const value of ['0','-1','abc','1.5',''])assert.throws(()=>notificationQueueJob(value));
  assert.doesNotThrow(()=>notificationQueueJob('900719925474099312345'));
});
