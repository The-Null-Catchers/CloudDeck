import {createHmac} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../src/index.ts';
import {pool} from '../src/db.ts';

const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function decodeBase32(value:string){
  let bits=0,buffer=0;const bytes:number[]=[];
  for(const character of value){
    buffer=(buffer<<5)|alphabet.indexOf(character);
    bits+=5;
    if(bits>=8){bytes.push((buffer>>>(bits-8))&255);bits-=8}
  }
  return Buffer.from(bytes);
}
function currentTotp(secret:string,now=Date.now()){
  const counter=Math.floor(now/30_000);
  const buffer=Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hash=createHmac('sha1',decodeBase32(secret)).update(buffer).digest();
  const offset=hash[hash.length-1]&15;
  const binary=((hash[offset]&0x7f)<<24)|(hash[offset+1]<<16)|(hash[offset+2]<<8)|hash[offset+3];
  return String(binary%1_000_000).padStart(6,'0');
}

test('enabled TOTP blocks password-only web login and recovery codes are one-time',async()=>{
  process.env.CLOUDDECK_MASTER_KEY=Buffer.alloc(32,7).toString('base64');
  const app=buildApp();await app.ready();
  const suffix=crypto.randomUUID();
  const email=`totp-${suffix}@example.com`;
  const password='TOTP secure passphrase 2026';
  const register=await app.inject({method:'POST',url:'/api/v1/auth/register',payload:{email,password}});
  assert.equal(register.statusCode,201,register.body);
  const registration=register.json();
  const bearer={authorization:`Bearer ${registration.accessToken}`};

  const setup=await app.inject({
    method:'POST',url:'/api/v1/auth/2fa/setup',headers:bearer,payload:{password}
  });
  assert.equal(setup.statusCode,200,setup.body);
  const secret=setup.json().secret as string;
  assert.ok(secret);

  const enable=await app.inject({
    method:'POST',url:'/api/v1/auth/2fa/enable',headers:bearer,payload:{code:currentTotp(secret)}
  });
  assert.equal(enable.statusCode,200,enable.body);
  const recovery=enable.json().recoveryCodes as string[];
  assert.equal(recovery.length,10);

  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email,password}});
  assert.equal(login.statusCode,202,login.body);
  assert.equal(login.json().twoFactorRequired,true);
  assert.equal(login.cookies.find(cookie=>cookie.name==='clouddeck_refresh'),undefined);

  const complete=await app.inject({
    method:'POST',url:'/api/v1/auth/2fa/complete',
    payload:{challengeToken:login.json().challengeToken,code:currentTotp(secret)}
  });
  assert.equal(complete.statusCode,200,complete.body);
  assert.ok(complete.json().accessToken);
  assert.ok(complete.cookies.find(cookie=>cookie.name==='clouddeck_refresh'));

  const recoveryLogin=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email,password}});
  assert.equal(recoveryLogin.statusCode,202,recoveryLogin.body);
  const useRecovery=await app.inject({
    method:'POST',url:'/api/v1/auth/2fa/complete',
    payload:{challengeToken:recoveryLogin.json().challengeToken,code:recovery[0]}
  });
  assert.equal(useRecovery.statusCode,200,useRecovery.body);

  const reuseLogin=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email,password}});
  assert.equal(reuseLogin.statusCode,202,reuseLogin.body);
  const reuseRecovery=await app.inject({
    method:'POST',url:'/api/v1/auth/2fa/complete',
    payload:{challengeToken:reuseLogin.json().challengeToken,code:recovery[0]}
  });
  assert.equal(reuseRecovery.statusCode,401,reuseRecovery.body);

  const status=await app.inject({
    method:'GET',url:'/api/v1/auth/2fa/status',
    headers:{authorization:`Bearer ${useRecovery.json().accessToken}`}
  });
  assert.equal(status.statusCode,200,status.body);
  assert.equal(status.json().enabled,true);
  assert.equal(status.json().recoveryCodesRemaining,9);

  await pool.query('DELETE FROM users WHERE email=$1',[email]);
  await pool.query('DELETE FROM organizations WHERE id=$1',[registration.organizationId]);
  await app.close();
});
