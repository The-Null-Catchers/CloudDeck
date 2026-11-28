// Local synthetic authenticated reads only; refuses external infrastructure.
import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
const base=process.env.CLOUDDECK_BENCH_URL??'http://127.0.0.1:4000';
const endpoint=new URL(base);
if(endpoint.hostname!=='127.0.0.1'||endpoint.protocol!=='http:')throw new Error('Use an isolated loopback HTTP API');
const count=60,concurrency=4,warmup=10;
const email=process.env.CLOUDDECK_BENCH_EMAIL,password=process.env.CLOUDDECK_BENCH_PASSWORD;
if(!email||!password)throw new Error('Set synthetic benchmark account credentials in the environment');
const login=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});
if(!login.ok)throw new Error(`Synthetic login failed: ${login.status}`);
const {accessToken}=await login.json();
const headers={Authorization:`Bearer ${accessToken}`};
const orgs=await fetch(base+'/api/v1/organizations',{headers}).then(r=>r.json());
const org=orgs.organizations.find(o=>o.demo);
if(!org)throw new Error('Load a synthetic demo workspace first');
const paths=[`/api/v1/organizations/${org.id}/dashboard`,`/api/v1/organizations/${org.id}/servers`];
async function request(i){const start=performance.now();const response=await fetch(base+paths[i%paths.length],{headers});await response.arrayBuffer();return {ms:performance.now()-start,status:response.status};}
for(let i=0;i<warmup;i++)await request(i);
let next=0;const samples=[];const start=performance.now();
await Promise.all(Array.from({length:concurrency},async()=>{while(next<count){const i=next++;try{samples.push(await request(i));}catch{samples.push({ms:0,status:0});}}}));
const durationMs=performance.now()-start;
const ordered=samples.map(s=>s.ms).sort((a,b)=>a-b);const percentile=p=>ordered[Math.ceil(p*ordered.length)-1];
const statuses={};for(const sample of samples)statuses[sample.status]=(statuses[sample.status]??0)+1;
console.log(JSON.stringify({sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0,node:process.version,os:`${os.type()} ${os.release()} ${os.arch()}`,cpu:os.cpus()[0].model,logicalCPUs:os.cpus().length,ramBytes:os.totalmem(),scope:'local synthetic dashboard/fleet reads; PostgreSQL17 Redis7; one API; four fixture servers; no live agents',count,concurrency,warmup,durationMs,throughputPerSecond:count/(durationMs/1000),p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),errors:samples.filter(s=>s.status<200||s.status>=300).length,statuses},null,2));
