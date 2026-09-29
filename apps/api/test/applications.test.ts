import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseApplicationRuntime} from '../src/applications.ts';

test('docker runtime accepts a bounded container target',()=>{
  assert.deepEqual(
    parseApplicationRuntime('dockerfile',{
      containerName:'clouddeck-api',
      containerPort:4000,
      hostPort:14000,
      restartPolicy:'unless-stopped'
    }),
    {
      containerName:'clouddeck-api',
      containerPort:4000,
      hostPort:14000,
      restartPolicy:'unless-stopped',
      composeProject:null
    }
  );
});

test('docker runtime rejects host publication without a container port',()=>{
  assert.throws(
    ()=>parseApplicationRuntime('dockerfile',{containerName:'api',hostPort:8080}),
    /containerPort is required/
  );
});

test('runtime identifiers reject shell-like or path-like values',()=>{
  assert.throws(()=>parseApplicationRuntime('dockerfile',{containerName:'api;rm -rf'}));
  assert.throws(()=>parseApplicationRuntime('compose',{composeProject:'../../prod'}));
});

test('compose runtime cannot smuggle dockerfile runtime fields',()=>{
  assert.throws(()=>parseApplicationRuntime('compose',{composeProject:'production',hostPort:8080}));
});
