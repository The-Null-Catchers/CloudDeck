import {promises as dns} from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export type HealthKind='http'|'https'|'tcp';
export type HealthProbeResult={success:boolean;responseMs:number;statusCode:number|null;error:string|null};

function ipv4Parts(address:string){
  const parts=address.split('.').map(Number);
  if(parts.length!==4||parts.some(part=>!Number.isInteger(part)||part<0||part>255))return null;
  return parts as [number,number,number,number];
}

function isPublicIPv4(address:string){
  const parts=ipv4Parts(address);if(!parts)return false;
  const [a,b,c]=parts;
  if(a===0||a===10||a===127||a>=224)return false;
  if(a===100&&b>=64&&b<=127)return false;
  if(a===169&&b===254)return false;
  if(a===172&&b>=16&&b<=31)return false;
  if(a===192&&(b===168||(b===0&&c===0)||(b===0&&c===2)||(b===88&&c===99)))return false;
  if(a===198&&(b===18||b===19))return false;
  if(a===198&&b===51&&c===100)return false;
  if(a===203&&b===0&&c===113)return false;
  return true;
}

function parseIPv6(address:string){
  let input=address.toLowerCase();
  if(input.includes('%'))return null;
  if(input.includes('.')){
    const colon=input.lastIndexOf(':');
    if(colon<0)return null;
    const v4=ipv4Parts(input.slice(colon+1));if(!v4)return null;
    input=input.slice(0,colon)+':'+((v4[0]<<8)|v4[1]).toString(16)+':'+((v4[2]<<8)|v4[3]).toString(16);
  }
  if((input.match(/::/g)??[]).length>1)return null;
  const [leftRaw,rightRaw]=input.split('::');
  const left=leftRaw?leftRaw.split(':'):[];
  const right=rightRaw?rightRaw.split(':'):[];
  if(left.some(part=>!/^[0-9a-f]{1,4}$/.test(part))||right.some(part=>!/^[0-9a-f]{1,4}$/.test(part)))return null;
  const missing=input.includes('::')?8-left.length-right.length:0;
  if((input.includes('::')&&missing<1)||(!input.includes('::')&&left.length!==8))return null;
  const parts=[...left,...Array(missing).fill('0'),...right].map(part=>parseInt(part,16));
  return parts.length===8?parts:null;
}

function isPublicIPv6(address:string){
  const parts=parseIPv6(address);if(!parts)return false;
  if(parts.every(part=>part===0))return false;
  if(parts.slice(0,7).every(part=>part===0)&&parts[7]===1)return false;
  if((parts[0]&0xfe00)===0xfc00)return false;
  if((parts[0]&0xffc0)===0xfe80)return false;
  if((parts[0]&0xff00)===0xff00)return false;
  if(parts[0]===0x2001&&parts[1]===0x0db8)return false;
  const mapped=parts.slice(0,5).every(part=>part===0)&&parts[5]===0xffff;
  const compatible=parts.slice(0,6).every(part=>part===0);
  if(mapped||compatible){
    const a=parts[6]>>8,b=parts[6]&255,c=parts[7]>>8,d=parts[7]&255;
    return isPublicIPv4(`${a}.${b}.${c}.${d}`);
  }
  return true;
}

export function isPublicHealthAddress(address:string){
  const version=net.isIP(address);
  return version===4?isPublicIPv4(address):version===6?isPublicIPv6(address):false;
}

export function normalizeHealthTarget(kind:HealthKind,target:string){
  const value=target.trim();
  if(kind==='http'||kind==='https'){
    let parsed:URL;
    try{parsed=new URL(value)}catch{throw Object.assign(new Error('Invalid health check URL'),{statusCode:400})}
    if(parsed.protocol!==kind+':')throw Object.assign(new Error(`Health check URL must use ${kind}://`),{statusCode:400});
    if(parsed.username||parsed.password||parsed.hash)throw Object.assign(new Error('Health check URL cannot contain credentials or fragments'),{statusCode:400});
    if(!parsed.hostname||parsed.port&&(Number(parsed.port)<1||Number(parsed.port)>65535))throw Object.assign(new Error('Invalid health check URL'),{statusCode:400});
    return parsed.toString();
  }
  let parsed:URL;
  try{parsed=new URL('tcp://'+value)}catch{throw Object.assign(new Error('TCP target must be host:port'),{statusCode:400})}
  if(!parsed.hostname||!parsed.port||parsed.username||parsed.password||parsed.search||parsed.hash||(parsed.pathname&&parsed.pathname!=='/'))throw Object.assign(new Error('TCP target must be host:port'),{statusCode:400});
  const port=Number(parsed.port);
  if(!Number.isInteger(port)||port<1||port>65535)throw Object.assign(new Error('Invalid TCP port'),{statusCode:400});
  return value;
}

async function resolvePublic(hostname:string){
  if(net.isIP(hostname)){
    if(!isPublicHealthAddress(hostname))throw new Error('Health checks cannot target private or reserved addresses');
    return {address:hostname,family:net.isIP(hostname)};
  }
  const answers=await dns.lookup(hostname,{all:true,verbatim:true});
  if(!answers.length)throw new Error('Health check hostname did not resolve');
  if(answers.some(answer=>!isPublicHealthAddress(answer.address)))throw new Error('Health check hostname resolves to a private or reserved address');
  return answers[0];
}

async function httpProbe(kind:'http'|'https',target:string,timeoutSeconds:number,expectedStatus:number|null):Promise<HealthProbeResult>{
  const url=new URL(target);
  const started=Date.now();
  try{
    const resolved=await resolvePublic(url.hostname);
    const transport=kind==='https'?https:http;
    return await new Promise(resolve=>{
      let settled=false;
      const finish=(result:HealthProbeResult)=>{if(settled)return;settled=true;resolve(result)};
      const req=transport.request({
        host:resolved.address,
        port:url.port?Number(url.port):(kind==='https'?443:80),
        method:'GET',
        path:url.pathname+url.search,
        servername:kind==='https'&&!net.isIP(url.hostname)?url.hostname:undefined,
        headers:{Host:url.host,'User-Agent':'CloudDeck-Health/1.0',Accept:'*/*',Connection:'close'},
        timeout:timeoutSeconds*1000
      },res=>{
        const status=res.statusCode??0;
        res.resume();
        const success=expectedStatus!==null?status===expectedStatus:status>=200&&status<400;
        finish({success,responseMs:Date.now()-started,statusCode:status,error:success?null:`Unexpected HTTP status ${status}`});
        req.destroy();
      });
      req.on('timeout',()=>req.destroy(new Error('Health check timed out')));
      req.on('error',error=>finish({success:false,responseMs:Date.now()-started,statusCode:null,error:error.message.slice(0,500)}));
      req.end();
    });
  }catch(error){
    return {success:false,responseMs:Date.now()-started,statusCode:null,error:(error instanceof Error?error.message:'Health check failed').slice(0,500)};
  }
}

async function tcpProbe(target:string,timeoutSeconds:number):Promise<HealthProbeResult>{
  const parsed=new URL('tcp://'+target);
  const started=Date.now();
  try{
    const resolved=await resolvePublic(parsed.hostname);
    return await new Promise(resolve=>{
      let settled=false;
      const socket=net.createConnection({host:resolved.address,port:Number(parsed.port)});
      const finish=(success:boolean,error:string|null)=>{if(settled)return;settled=true;socket.destroy();resolve({success,responseMs:Date.now()-started,statusCode:null,error})};
      socket.setTimeout(timeoutSeconds*1000);
      socket.once('connect',()=>finish(true,null));
      socket.once('timeout',()=>finish(false,'Health check timed out'));
      socket.once('error',error=>finish(false,error.message.slice(0,500)));
    });
  }catch(error){
    return {success:false,responseMs:Date.now()-started,statusCode:null,error:(error instanceof Error?error.message:'Health check failed').slice(0,500)};
  }
}

export async function probeHealthTarget(kind:HealthKind,target:string,timeoutSeconds:number,expectedStatus:number|null){
  const normalized=normalizeHealthTarget(kind,target);
  return kind==='tcp'?tcpProbe(normalized,timeoutSeconds):httpProbe(kind,normalized,timeoutSeconds,expectedStatus);
}
