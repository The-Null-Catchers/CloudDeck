import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSearchQuery,searchPattern} from '../src/search.js';

test('global search normalizes whitespace without changing search text',()=>{
  assert.equal(normalizeSearchQuery('  Production   API  '),'Production API');
});

test('global search bounds normalized queries',()=>{
  assert.equal(normalizeSearchQuery('x'.repeat(200)).length,120);
});

test('global search treats wildcard and escape characters literally',()=>{
  assert.equal(searchPattern('db_100%\\primary'),'%db\\_100\\%\\\\primary%');
});
