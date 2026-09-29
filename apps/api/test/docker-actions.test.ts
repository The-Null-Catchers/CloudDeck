import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedActions} from '@clouddeck/shared';

test('docker lifecycle uses explicit allowlisted actions',()=>{
  for(const action of [
    'docker.startContainer','docker.stopContainer','docker.restartContainer',
    'docker.pauseContainer','docker.unpauseContainer','docker.removeContainer',
    'docker.listComposeProjects'
  ]) assert.ok((allowedActions as readonly string[]).includes(action));
  assert.equal((allowedActions as readonly string[]).includes('docker.exec'),false);
  assert.equal((allowedActions as readonly string[]).includes('docker.run'),false);
});
