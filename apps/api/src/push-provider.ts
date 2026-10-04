import {importPKCS8,SignJWT} from 'jose';
import {z} from 'zod';

const tokenResponse=z.object({access_token:z.string().min(10),expires_in:z.number().int().positive().default(3600),token_type:z.string().optional()}).passthrough();

type PushMessage={token:string;title:string;body?:string|null;href?:string|null;type:string};
type CachedToken={value:string;expiresAt:number};
let cached:CachedToken|null=null;

function config(){
  const projectId=process.env.FCM_PROJECT_ID?.trim();
  const clientEmail=process.env.FCM_CLIENT_EMAIL?.trim();
  const privateKey=process.env.FCM_PRIVATE_KEY?.replace(/\\n/g,'\n').trim();
  if(!projectId&&!clientEmail&&!privateKey)throw new Error('FCM push delivery is not configured');
  if(!projectId||!clientEmail||!privateKey)throw new Error('FCM_PROJECT_ID, FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY must be configured together');
  if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,200}$/.test(projectId))throw new Error('Invalid FCM project ID');
  if(clientEmail.length>320||!clientEmail.includes('@'))throw new Error('Invalid FCM client email');
  return {projectId,clientEmail,privateKey};
}

async function accessToken(force=false){
  if(!force&&cached&&cached.expiresAt>Date.now()+60_000)return cached.value;
  const current=config();
  const key=await importPKCS8(current.privateKey,'RS256');
  const now=Math.floor(Date.now()/1000);
  const assertion=await new SignJWT({scope:'https://www.googleapis.com/auth/firebase.messaging'})
    .setProtectedHeader({alg:'RS256',typ:'JWT'})
    .setIssuer(current.clientEmail)
    .setSubject(current.clientEmail)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now)
    .setExpirationTime(now+3600)
    .sign(key);
  const body=new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion});
  const response=await fetch('https://oauth2.googleapis.com/token',{
    method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded'},
    body,
    signal:AbortSignal.timeout(10_000)
  });
  if(!response.ok)throw new Error(`FCM OAuth token request failed with HTTP ${response.status}`);
  const parsed=tokenResponse.parse(await response.json());
  cached={value:parsed.access_token,expiresAt:Date.now()+parsed.expires_in*1000};
  return parsed.access_token;
}

function isUnregistered(status:number,text:string){
  return status===404||text.includes('UNREGISTERED')||text.includes('registration-token-not-registered');
}

async function sendOnce(message:PushMessage,forceToken=false){
  const current=config();
  const bearer=await accessToken(forceToken);
  const data:Record<string,string>={type:message.type.slice(0,100)};
  if(message.href)data.href=message.href.slice(0,500);
  const response=await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(current.projectId)}/messages:send`,{
    method:'POST',
    headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json'},
    body:JSON.stringify({message:{token:message.token,notification:{title:message.title.slice(0,200),body:(message.body??'').slice(0,1000)},data,android:{priority:'high'},apns:{headers:{'apns-priority':'10'},payload:{aps:{sound:'default'}}}}}),
    signal:AbortSignal.timeout(10_000)
  });
  const text=await response.text();
  if(response.ok)return 'sent' as const;
  if(isUnregistered(response.status,text))return 'invalid_token' as const;
  if(response.status===401&&!forceToken){cached=null;return sendOnce(message,true);}
  throw new Error(`FCM push request failed with HTTP ${response.status}`);
}

export async function sendPushNotification(message:PushMessage){
  if(message.token.length<20||message.token.length>4096)throw new Error('Invalid push token');
  return sendOnce(message);
}

export function resetPushProviderCache(){cached=null;}
