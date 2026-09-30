import {promises as dns} from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import {domainToASCII} from 'node:url';
import {isPublicHealthAddress} from './health-probe.js';

const label=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeDomainHostname(input:string){
  const raw=input.trim().replace(/[.]$/,'').toLowerCase();
  if(!raw||/[\\/:@?#\s]/u.test(raw))throw Object.assign(new Error('Invalid domain hostname'),{statusCode:400});
  const hostname=domainToASCII(raw).toLowerCase();
  if(!hostname||hostname.length>253||net.isIP(hostname))throw Object.assign(new Error('Domain must be a DNS hostname'),{statusCode:400});
  const labels=hostname.split('.');
  if(labels.length<2||labels.some(part=>!label.test(part)))throw Object.assign(new Error('Invalid domain hostname'),{statusCode:400});
  if(hostname==='localhost'||hostname.endsWith('.localhost'))throw Object.assign(new Error('Localhost domains are not supported'),{statusCode:400});
  return hostname;
}

async function resolvePublicDomain(hostname:string){
  const answers=await dns.lookup(hostname,{all:true,verbatim:true});
  if(!answers.length)throw new Error('Domain did not resolve');
  if(answers.some(answer=>!isPublicHealthAddress(answer.address)))throw new Error('Domain resolves to a private or reserved address');
  return answers[0];
}

function issuerLabel(issuer:tls.PeerCertificate['issuer']){
  if(!issuer)return null;
  const value=issuer.O||issuer.CN||issuer.OU||null;
  return typeof value==='string'?value.slice(0,300):null;
}

export type DomainTlsProbe={
  status:'valid'|'invalid'|'unreachable';
  certificateExpiresAt:string|null;
  certificateIssuer:string|null;
  error:string|null;
  responseMs:number;
};

export async function probeDomainTls(hostnameInput:string,timeoutMs=8000):Promise<DomainTlsProbe>{
  const hostname=normalizeDomainHostname(hostnameInput);
  const started=Date.now();
  try{
    const resolved=await resolvePublicDomain(hostname);
    return await new Promise(resolve=>{
      let settled=false;
      const socket=tls.connect({
        host:resolved.address,
        port:443,
        servername:hostname,
        rejectUnauthorized:false
      });
      const finish=(result:DomainTlsProbe)=>{
        if(settled)return;
        settled=true;
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(Math.max(1000,Math.min(15000,Math.trunc(timeoutMs))));
      socket.once('secureConnect',()=>{
        const certificate=socket.getPeerCertificate();
        const parsed=certificate.valid_to?new Date(certificate.valid_to):null;
        const expiresAt=parsed&&!Number.isNaN(parsed.getTime())?parsed.toISOString():null;
        const authorized=socket.authorized;
        finish({
          status:authorized?'valid':'invalid',
          certificateExpiresAt:expiresAt,
          certificateIssuer:issuerLabel(certificate.issuer),
          error:authorized?null:String(socket.authorizationError||'TLS certificate validation failed').slice(0,500),
          responseMs:Date.now()-started
        });
      });
      socket.once('timeout',()=>finish({
        status:'unreachable',certificateExpiresAt:null,certificateIssuer:null,
        error:'TLS connection timed out',responseMs:Date.now()-started
      }));
      socket.once('error',error=>finish({
        status:'unreachable',certificateExpiresAt:null,certificateIssuer:null,
        error:error.message.slice(0,500),responseMs:Date.now()-started
      }));
    });
  }catch(error){
    return {
      status:'unreachable',
      certificateExpiresAt:null,
      certificateIssuer:null,
      error:(error instanceof Error?error.message:'TLS probe failed').slice(0,500),
      responseMs:Date.now()-started
    };
  }
}

export function certificateDaysRemaining(expiresAt:string|null,now=Date.now()){
  if(!expiresAt)return null;
  const timestamp=new Date(expiresAt).getTime();
  if(Number.isNaN(timestamp))return null;
  const days=Math.ceil((timestamp-now)/86_400_000);
  return Object.is(days,-0)?0:days;
}
