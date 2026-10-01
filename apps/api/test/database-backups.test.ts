import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseDatabaseBackupSecret} from '../src/backups.ts';

test('database backup secret parser accepts bounded structured credentials',()=>{
  assert.deepEqual(parseDatabaseBackupSecret(JSON.stringify({
    host:'db.internal',
    port:5432,
    username:'backup_user',
    password:'secret-value',
    sslMode:'require'
  })),{
    host:'db.internal',
    port:5432,
    username:'backup_user',
    password:'secret-value',
    sslMode:'require'
  });
});

test('database backup secret parser rejects URI and option injection shapes',()=>{
  for(const value of [
    'postgres://user:pass@db/app',
    ...['secret\nextra','secret\rextra','secret\0extra'].map(password=>JSON.stringify({host:'db.internal',port:5432,username:'backup',password,sslMode:'require'})),
    JSON.stringify({host:'db.internal;touch /tmp/x',port:5432,username:'backup',password:'secret',sslMode:'require'}),
    JSON.stringify({host:'db.internal',port:5432,username:'bad user',password:'secret',sslMode:'require'}),
    JSON.stringify({host:'db.internal',port:5432,username:'backup',password:'secret',sslMode:'require',extra:'--flag'})
  ])assert.throws(()=>parseDatabaseBackupSecret(value),/invalid/);
});
