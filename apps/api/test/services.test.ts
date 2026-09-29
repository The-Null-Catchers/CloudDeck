import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedActions} from '@clouddeck/shared';

test('agent allowlist includes explicit systemd operations only',()=>{
  assert.ok(allowedActions.includes('systemd.listServices'));
  assert.ok(allowedActions.includes('systemd.restartService'));
  assert.ok(allowedActions.includes('systemd.tailLogs'));
  assert.equal((allowedActions as readonly string[]).includes('systemd.exec'),false);
  assert.equal((allowedActions as readonly string[]).includes('shell.exec'),false);
});
