import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../src/index.ts';
import {pool} from '../src/db.ts';

test('native mobile refresh tokens rotate and can be revoked without cookies',async()=>{
  const app=buildApp();
  await app.ready();
  const suffix=crypto.randomUUID();
  const email=`mobile-${suffix}@example.com`;
  const password='mobile secure passphrase 2026';
  const register=await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{email,password}});
  assert.equal(register.statusCode,201,register.body);

  const login=await app.inject({
    method:'POST',
    url:'/api/v1/auth/mobile/login',
    payload:{email,password,deviceName:'Pixel test device'}
  });
  assert.equal(login.statusCode,200,login.body);
  const session=login.json();
  assert.ok(session.accessToken);
  assert.ok(session.refreshToken);
  assert.equal(session.expiresIn,600);
  assert.equal(login.cookies.length,0);

  const refresh=await app.inject({
    method:'POST',
    url:'/api/v1/auth/mobile/refresh',
    payload:{refreshToken:session.refreshToken}
  });
  assert.equal(refresh.statusCode,200,refresh.body);
  const rotated=refresh.json();
  assert.notEqual(rotated.refreshToken,session.refreshToken);

  const reused=await app.inject({
    method:'POST',
    url:'/api/v1/auth/mobile/refresh',
    payload:{refreshToken:session.refreshToken}
  });
  assert.equal(reused.statusCode,401);

  const logout=await app.inject({
    method:'POST',
    url:'/api/v1/auth/mobile/logout',
    payload:{refreshToken:rotated.refreshToken}
  });
  assert.equal(logout.statusCode,200,logout.body);

  const afterLogout=await app.inject({
    method:'POST',
    url:'/api/v1/auth/mobile/refresh',
    payload:{refreshToken:rotated.refreshToken}
  });
  assert.equal(afterLogout.statusCode,401);

  await pool.query('DELETE FROM users WHERE email=$1',[email]);
  await app.close();
});
