import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nextBackupRun,backupSchedule} from '../src/backups.ts';

const base=new Date('2026-10-01T09:00:00.000Z');

test('backup schedule validation accepts supported cadences',()=>{
  for(const value of ['manual','hourly','daily','weekly'])assert.equal(backupSchedule.parse(value),value);
  assert.throws(()=>backupSchedule.parse('*/5 * * * *'));
});

test('manual backups do not receive an automatic next run',()=>{
  assert.equal(nextBackupRun('manual',base),null);
});

test('recurring backup schedules advance from the supplied instant',()=>{
  assert.equal(nextBackupRun('hourly',base)?.toISOString(),'2026-10-01T10:00:00.000Z');
  assert.equal(nextBackupRun('daily',base)?.toISOString(),'2026-10-02T09:00:00.000Z');
  assert.equal(nextBackupRun('weekly',base)?.toISOString(),'2026-10-08T09:00:00.000Z');
});
