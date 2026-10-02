import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';

const base32Alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const recoveryAlphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function encodeBase32(input:Buffer){
  let bits=0;
  let value=0;
  let output='';
  for(const byte of input){
    value=(value<<8)|byte;
    bits+=8;
    while(bits>=5){
      output+=base32Alphabet[(value>>>(bits-5))&31];
      bits-=5;
    }
  }
  if(bits>0)output+=base32Alphabet[(value<<(5-bits))&31];
  return output;
}

export function decodeBase32(value:string){
  const normalized=value.replace(/=+$/,'').toUpperCase();
  if(!/^[A-Z2-7]+$/.test(normalized))throw new Error('Invalid base32 value');
  let bits=0;
  let buffer=0;
  const bytes:number[]=[];
  for(const character of normalized){
    const index=base32Alphabet.indexOf(character);
    if(index<0)throw new Error('Invalid base32 value');
    buffer=(buffer<<5)|index;
    bits+=5;
    if(bits>=8){
      bytes.push((buffer>>>(bits-8))&255);
      bits-=8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(){
  return encodeBase32(randomBytes(20));
}

function hotp(secret:string,counter:number){
  const key=decodeBase32(secret);
  const buffer=Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hash=createHmac('sha1',key).update(buffer).digest();
  const offset=hash[hash.length-1]&0x0f;
  const binary=((hash[offset]&0x7f)<<24)|(hash[offset+1]<<16)|(hash[offset+2]<<8)|hash[offset+3];
  return String(binary%1_000_000).padStart(6,'0');
}

export function verifyTotpCode(secret:string,code:string,now=Date.now()){
  if(!/^\d{6}$/.test(code))return false;
  const counter=Math.floor(now/30_000);
  for(const delta of [-1,0,1]){
    const expected=Buffer.from(hotp(secret,counter+delta));
    const received=Buffer.from(code);
    if(expected.length===received.length&&timingSafeEqual(expected,received))return true;
  }
  return false;
}

export function totpUri(email:string,secret:string){
  const label=encodeURIComponent(`CloudDeck:${email}`);
  const params=new URLSearchParams({
    secret,
    issuer:'CloudDeck',
    algorithm:'SHA1',
    digits:'6',
    period:'30'
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function normalizeRecoveryCode(value:string){
  return value.replace(/[^A-Za-z0-9]/g,'').toUpperCase();
}

export function generateRecoveryCodes(count=10){
  if(count<1||count>20)throw new Error('Invalid recovery code count');
  return Array.from({length:count},()=>{
    let value='';
    while(value.length<16){
      const byte=randomBytes(1)[0];
      if(byte>=recoveryAlphabet.length*8)continue;
      value+=recoveryAlphabet[byte%recoveryAlphabet.length];
    }
    return value.match(/.{1,4}/g)!.join('-');
  });
}
