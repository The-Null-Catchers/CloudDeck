import {createHmac} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyGitHubWebhookSignature} from '../src/github-webhook.ts';

test('GitHub webhook signature accepts exact HMAC body',()=>{
  const secret='s'.repeat(32);
  const body=Buffer.from('{"ref":"refs/heads/main"}');
  const signature='sha256='+createHmac('sha256',secret).update(body).digest('hex');
  assert.equal(verifyGitHubWebhookSignature(body,signature,secret),true);
});

test('GitHub webhook signature rejects tampered bodies and malformed signatures',()=>{
  const secret='s'.repeat(32);
  const body=Buffer.from('{"ref":"refs/heads/main"}');
  const signature='sha256='+createHmac('sha256',secret).update(body).digest('hex');
  assert.equal(verifyGitHubWebhookSignature(Buffer.from('{"ref":"refs/heads/dev"}'),signature,secret),false);
  assert.equal(verifyGitHubWebhookSignature(body,'sha256=bad',secret),false);
  assert.equal(verifyGitHubWebhookSignature(body,undefined,secret),false);
});
