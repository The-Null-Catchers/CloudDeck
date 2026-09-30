import {test} from 'node:test';
import assert from 'node:assert/strict';
import {certificateDaysRemaining,normalizeDomainHostname} from '../src/domain-tls.ts';

test('domain hostname normalization accepts DNS names and canonicalizes IDN',()=>{
  assert.equal(normalizeDomainHostname('Example.COM.'),'example.com');
  assert.equal(normalizeDomainHostname('bücher.example'),'xn--bcher-kva.example');
});

test('domain hostname normalization rejects local, IP, malformed, and injection-shaped input',()=>{
  for(const value of [
    'localhost','service.localhost','127.0.0.1','::1','-bad.example','bad-.example',
    'bad..example','https://example.com','example.com/path','example.com\nnext'
  ])assert.throws(()=>normalizeDomainHostname(value),value);
});

test('certificate expiry calculations round conservatively to whole days',()=>{
  const now=Date.UTC(2026,8,30,12,0,0);
  assert.equal(certificateDaysRemaining(new Date(now+13.2*86_400_000).toISOString(),now),14);
  assert.equal(certificateDaysRemaining(new Date(now-1000).toISOString(),now),0);
  assert.equal(certificateDaysRemaining(null,now),null);
});
