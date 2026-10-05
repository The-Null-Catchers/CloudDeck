import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSearchQuery} from '../src/search.js';

test('global search normalizes whitespace without changing search text',()=>{
  assert.equal(normalizeSearchQuery('  Production   API  '),'Production API');
});

test('global search bounds normalized queries',()=>{
  assert.equal(normalizeSearchQuery('x'.repeat(200)).length,120);
});
