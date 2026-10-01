import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseS3BackupSecret} from '../src/backups.ts';

test('S3 backup secret parser accepts HTTPS S3-compatible configuration',()=>{
  assert.deepEqual(parseS3BackupSecret(JSON.stringify({
    endpoint:'https://s3.example.com',
    region:'us-east-1',
    bucket:'clouddeck-backups',
    accessKey:'ACCESS123',
    secretKey:'super-secret',
    prefix:'production/api'
  })),{
    endpoint:'https://s3.example.com',
    region:'us-east-1',
    bucket:'clouddeck-backups',
    accessKey:'ACCESS123',
    secretKey:'super-secret',
    sessionToken:'',
    prefix:'production/api'
  });
});

test('S3 backup secret parser permits HTTP only for loopback development endpoints',()=>{
  const parsed=parseS3BackupSecret(JSON.stringify({
    endpoint:'http://127.0.0.1:9000',
    region:'us-east-1',
    bucket:'clouddeck-backups',
    accessKey:'access',
    secretKey:'secret'
  }));
  assert.equal(parsed.endpoint,'http://127.0.0.1:9000');
  assert.throws(()=>parseS3BackupSecret(JSON.stringify({
    endpoint:'http://minio.internal:9000',
    region:'us-east-1',
    bucket:'clouddeck-backups',
    accessKey:'access',
    secretKey:'secret'
  })),/invalid/);
});

test('S3 backup secret parser rejects credential and object-key injection shapes',()=>{
  for(const value of [
    {endpoint:'https://user:pass@s3.example.com',region:'us-east-1',bucket:'clouddeck-backups',accessKey:'access',secretKey:'secret'},
    {endpoint:'https://s3.example.com/path',region:'us-east-1',bucket:'clouddeck-backups',accessKey:'access',secretKey:'secret'},
    {endpoint:'https://s3.example.com',region:'us-east-1',bucket:'CloudDeck',accessKey:'access',secretKey:'secret'},
    {endpoint:'https://s3.example.com',region:'us-east-1',bucket:'clouddeck-backups',accessKey:'bad key',secretKey:'secret'},
    {endpoint:'https://s3.example.com',region:'us-east-1',bucket:'clouddeck-backups',accessKey:'access',secretKey:'secret',prefix:'../escape'},
    {endpoint:'https://s3.example.com',region:'us-east-1',bucket:'clouddeck-backups',accessKey:'access',secretKey:'secret\nnext'}
  ])assert.throws(()=>parseS3BackupSecret(JSON.stringify(value)),/invalid/);
});
