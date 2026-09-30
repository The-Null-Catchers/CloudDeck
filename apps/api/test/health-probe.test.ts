import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isPublicHealthAddress,normalizeHealthTarget} from '../src/health-probe.ts';

test('health probes reject private and reserved address ranges',()=>{
  for(const address of [
    '127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254',
    '100.64.0.1','192.0.2.1','198.51.100.1','203.0.113.1','224.0.0.1',
    '::1','fe80::1','fc00::1','2001:db8::1','::ffff:127.0.0.1'
  ]) assert.equal(isPublicHealthAddress(address),false,address);
  assert.equal(isPublicHealthAddress('1.1.1.1'),true);
  assert.equal(isPublicHealthAddress('2606:4700:4700::1111'),true);
});

test('health target normalization pins protocol and strips unsafe forms',()=>{
  assert.equal(normalizeHealthTarget('https','https://example.com/health'),'https://example.com/health');
  assert.equal(normalizeHealthTarget('tcp','example.com:443'),'example.com:443');
  assert.throws(()=>normalizeHealthTarget('https','http://example.com'));
  assert.throws(()=>normalizeHealthTarget('http','http://user:pass@example.com'));
  assert.throws(()=>normalizeHealthTarget('tcp','example.com'));
});
