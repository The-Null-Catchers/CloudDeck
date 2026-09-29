import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canTransitionDeployment,deploymentStates,type DeploymentState} from '../src/deployments.ts';

test('deployment state machine allows only forward orchestration transitions',()=>{
  const allowed:[DeploymentState,DeploymentState][]=[
    ['queued','cloning'],
    ['cloning','building'],
    ['building','deploying'],
    ['deploying','health-checking'],
    ['health-checking','successful'],
    ['queued','failed'],
    ['cloning','failed'],
    ['building','failed'],
    ['deploying','failed'],
    ['health-checking','failed'],
    ['successful','rolled-back']
  ];
  for(const [from,to] of allowed)assert.equal(canTransitionDeployment(from,to),true,`${from} -> ${to}`);
});

test('deployment state machine rejects skips, retries and terminal-state mutation',()=>{
  for(const from of deploymentStates){
    assert.equal(canTransitionDeployment(from,from),false,`self transition ${from}`);
  }
  assert.equal(canTransitionDeployment('queued','deploying'),false);
  assert.equal(canTransitionDeployment('building','successful'),false);
  assert.equal(canTransitionDeployment('failed','queued'),false);
  assert.equal(canTransitionDeployment('rolled-back','queued'),false);
  assert.equal(canTransitionDeployment('successful','failed'),false);
});
