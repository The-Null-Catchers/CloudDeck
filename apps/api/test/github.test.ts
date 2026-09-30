import {test} from 'node:test';
import assert from 'node:assert/strict';
import {githubAuthorizeUrl,githubInstallUrl,parseGitHubConnectReturnTo} from '../src/github.ts';

test('GitHub install URL carries opaque state',()=>{
  const url=new URL(githubInstallUrl('clouddeck-app','opaque-state'));
  assert.equal(url.origin,'https://github.com');
  assert.equal(url.pathname,'/apps/clouddeck-app/installations/new');
  assert.equal(url.searchParams.get('state'),'opaque-state');
});

test('GitHub OAuth URL pins callback and state',()=>{
  const url=new URL(githubAuthorizeUrl('Iv1.client','https://api.example.com/api/v1/github/oauth/callback','opaque-state'));
  assert.equal(url.origin,'https://github.com');
  assert.equal(url.pathname,'/login/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'),'Iv1.client');
  assert.equal(url.searchParams.get('redirect_uri'),'https://api.example.com/api/v1/github/oauth/callback');
  assert.equal(url.searchParams.get('state'),'opaque-state');
});


test('GitHub connect return path is restricted to internal allowlist',()=>{
  assert.equal(parseGitHubConnectReturnTo({}),'/dashboard');
  assert.equal(parseGitHubConnectReturnTo({returnTo:'/applications/new'}),'/applications/new');
  assert.throws(()=>parseGitHubConnectReturnTo({returnTo:'https://evil.example'}));
  assert.throws(()=>parseGitHubConnectReturnTo({returnTo:'//evil.example'}));
  assert.throws(()=>parseGitHubConnectReturnTo({returnTo:'/applications/new?next=https://evil.example'}));
});
