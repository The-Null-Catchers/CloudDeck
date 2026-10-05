import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeAuditMetadata} from '../src/audit-logs.js';

test('audit metadata redacts secret-like fields recursively',()=>{
  assert.deepEqual(
    sanitizeAuditMetadata({serverId:'srv-1',token:'abc',nested:{password:'pw',status:'ok'},values:[{credential:'secret'},'safe']}),
    {serverId:'srv-1',token:'[redacted]',nested:{password:'[redacted]',status:'ok'},values:[{credential:'[redacted]'},'safe']}
  );
});

test('audit metadata bounds oversized strings',()=>{
  const result=sanitizeAuditMetadata({message:'x'.repeat(1200)}) as {message:string};
  assert.equal(result.message.length,1001);
  assert.ok(result.message.endsWith('…'));
});
