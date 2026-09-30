import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decryptSecretValue,encryptSecretValue} from '../src/secret-crypto.ts';

test('secret encryption uses randomized authenticated encryption',()=>{
  const previous=process.env.CLOUDDECK_MASTER_KEY;
  process.env.CLOUDDECK_MASTER_KEY=Buffer.alloc(32,7).toString('base64');
  try{
    const first=encryptSecretValue('super-secret-value');
    const second=encryptSecretValue('super-secret-value');
    assert.equal(first.iv.length,12);
    assert.equal(first.authTag.length,16);
    assert.notDeepEqual(first.iv,second.iv);
    assert.notDeepEqual(first.ciphertext,second.ciphertext);
    assert.equal(decryptSecretValue(first),'super-secret-value');
  }finally{
    if(previous===undefined)delete process.env.CLOUDDECK_MASTER_KEY;
    else process.env.CLOUDDECK_MASTER_KEY=previous;
  }
});

test('secret decryption rejects tampered ciphertext',()=>{
  const previous=process.env.CLOUDDECK_MASTER_KEY;
  process.env.CLOUDDECK_MASTER_KEY=Buffer.alloc(32,11).toString('base64');
  try{
    const encrypted=encryptSecretValue('do-not-leak');
    encrypted.ciphertext=Buffer.from(encrypted.ciphertext);
    encrypted.ciphertext[0]^=1;
    assert.throws(()=>decryptSecretValue(encrypted));
  }finally{
    if(previous===undefined)delete process.env.CLOUDDECK_MASTER_KEY;
    else process.env.CLOUDDECK_MASTER_KEY=previous;
  }
});

test('secret encryption requires a 32-byte configured master key',()=>{
  const previous=process.env.CLOUDDECK_MASTER_KEY;
  try{
    delete process.env.CLOUDDECK_MASTER_KEY;
    assert.throws(()=>encryptSecretValue('value'),/not configured/);
    process.env.CLOUDDECK_MASTER_KEY=Buffer.alloc(31).toString('base64');
    assert.throws(()=>encryptSecretValue('value'),/exactly 32 bytes/);
  }finally{
    if(previous===undefined)delete process.env.CLOUDDECK_MASTER_KEY;
    else process.env.CLOUDDECK_MASTER_KEY=previous;
  }
});
