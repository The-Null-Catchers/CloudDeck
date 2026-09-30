import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';

export type EncryptedSecret = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
};

function masterKey(){
  const raw=process.env.CLOUDDECK_MASTER_KEY;
  if(!raw)throw Object.assign(new Error('Encrypted secret storage is not configured'),{statusCode:503});
  let key:Buffer;
  try{key=Buffer.from(raw,'base64');}catch{throw Object.assign(new Error('Invalid secret encryption key configuration'),{statusCode:500});}
  if(key.length!==32)throw Object.assign(new Error('CLOUDDECK_MASTER_KEY must decode to exactly 32 bytes'),{statusCode:500});
  return key;
}

export function encryptSecretValue(value:string):EncryptedSecret{
  if(value.length<1||value.length>16384)throw Object.assign(new Error('Secret value must contain 1 to 16384 characters'),{statusCode:400});
  const iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',masterKey(),iv);
  const ciphertext=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return {ciphertext,iv,authTag:cipher.getAuthTag(),keyVersion:1};
}

export function decryptSecretValue(input:EncryptedSecret){
  if(input.keyVersion!==1)throw Object.assign(new Error('Unsupported secret key version'),{statusCode:500});
  const decipher=createDecipheriv('aes-256-gcm',masterKey(),input.iv);
  decipher.setAuthTag(input.authTag);
  return Buffer.concat([decipher.update(input.ciphertext),decipher.final()]).toString('utf8');
}
