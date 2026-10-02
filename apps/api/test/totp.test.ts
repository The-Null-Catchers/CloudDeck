import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateRecoveryCodes,normalizeRecoveryCode,verifyTotpCode} from '../src/totp.ts';

test('TOTP verification matches RFC 6238 SHA1 8-digit vector truncated to CloudDeck 6 digits',()=>{
  const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(verifyTotpCode(secret,'287082',59_000),true);
  assert.equal(verifyTotpCode(secret,'287083',59_000),false);
});

test('recovery codes are unique, normalized, and omit ambiguous characters',()=>{
  const codes=generateRecoveryCodes(10);
  assert.equal(codes.length,10);
  assert.equal(new Set(codes).size,10);
  for(const code of codes){
    assert.match(code,/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/);
    assert.equal(normalizeRecoveryCode(code).length,16);
    assert.doesNotMatch(code,/[01IO]/);
  }
});
