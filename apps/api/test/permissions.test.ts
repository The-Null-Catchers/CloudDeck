import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can } from '../src/security.ts';
test('viewers cannot operate servers or manage members', () => {
  assert.equal(can('viewer','server.read'),true);
  assert.equal(can('viewer','server.action'),false);
  assert.equal(can('viewer','member.manage'),false);
});
test('operators can act but cannot add servers', () => {
  assert.equal(can('operator','server.action'),true);
  assert.equal(can('operator','server.create'),false);
});
