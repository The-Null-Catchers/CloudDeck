import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveDomainTargetPort} from '../src/domains.ts';

test('Dockerfile domains are bound to the configured application host port',()=>{
  const app={deployment_type:'dockerfile' as const,host_port:4000};
  assert.equal(resolveDomainTargetPort(app,undefined),4000);
  assert.equal(resolveDomainTargetPort(app,4000),4000);
  assert.throws(()=>resolveDomainTargetPort(app,5000),/must target the application host port/);
});

test('Compose domains require an explicit target port',()=>{
  const app={deployment_type:'compose' as const,host_port:null};
  assert.equal(resolveDomainTargetPort(app,8080),8080);
  assert.throws(()=>resolveDomainTargetPort(app,undefined),/target port is required/);
});
