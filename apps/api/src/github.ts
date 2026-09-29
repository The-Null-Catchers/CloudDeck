import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {SignJWT,importPKCS8} from 'jose';
import {pool,transaction} from './db.js';
import {authenticate,membership,audit,digest,randomToken} from './security.js';

const uuid=z.uuid();
const connectParams=z.object({orgId:uuid});
const setupQuery=z.object({
  state:z.string().min(20).max(200),
  installation_id:z.coerce.number().int().positive(),
  setup_action:z.string().max(40).optional()
}).strict();
const oauthQuery=z.object({state:z.string().min(20).max(200),code:z.string().min(8).max(500)}).strict();
const repositoryParams=z.object({orgId:uuid,connectionId:uuid});
const pageQuery=z.object({page:z.coerce.number().int().min(1).max(1000).default(1),perPage:z.coerce.number().int().min(1).max(100).default(50)}).strict();
const repoParams=z.object({
  orgId:uuid,
  connectionId:uuid,
  owner:z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
  repo:z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/)
});
const installationSchema=z.object({
  id:z.number().int().positive(),
  account:z.object({login:z.string().min(1).max(255),type:z.string().min(1).max(50)}),
  repository_selection:z.string().max(30).optional(),
  permissions:z.record(z.string(),z.string()).optional()
});

function config(){
  const slug=process.env.GITHUB_APP_SLUG;
  const clientId=process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret=process.env.GITHUB_APP_CLIENT_SECRET;
  const callback=process.env.GITHUB_APP_OAUTH_CALLBACK_URL;
  if(!slug||!clientId||!clientSecret||!callback){
    throw Object.assign(new Error('GitHub App integration is not configured'),{statusCode:503});
  }
  return {slug,clientId,clientSecret,callback};
}

export function githubInstallUrl(slug:string,state:string){
  const url=new URL(`https://github.com/apps/${slug}/installations/new`);
  url.searchParams.set('state',state);
  return url.toString();
}

export function githubAuthorizeUrl(clientId:string,callback:string,state:string){
  const url=new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id',clientId);
  url.searchParams.set('redirect_uri',callback);
  url.searchParams.set('state',state);
  return url.toString();
}

async function consumeState(token:string,phase:'install'|'oauth'){
  const result=await pool.query(
    `UPDATE github_connection_states
     SET consumed_at=now()
     WHERE token_hash=$1 AND phase=$2 AND consumed_at IS NULL AND expires_at>now()
     RETURNING organization_id,user_id,installation_id`,
    [digest(token),phase]
  );
  if(!result.rowCount)throw Object.assign(new Error('Invalid or expired GitHub connection state'),{statusCode:401});
  return result.rows[0] as {organization_id:string;user_id:string;installation_id:number|null};
}

async function exchangeUserToken(code:string){
  const {clientId,clientSecret,callback}=config();
  const response=await fetch('https://github.com/login/oauth/access_token',{
    method:'POST',
    headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded','User-Agent':'CloudDeck'},
    body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,code,redirect_uri:callback})
  });
  if(!response.ok)throw Object.assign(new Error('GitHub authorization failed'),{statusCode:502});
  const body=z.object({access_token:z.string().min(1).optional(),error:z.string().optional()}).parse(await response.json());
  if(!body.access_token)throw Object.assign(new Error('GitHub authorization was not granted'),{statusCode:401});
  return body.access_token;
}


let appKeyPromise:ReturnType<typeof importPKCS8>|null=null;
function appAuthConfig(){
  const base=config();
  const privateKey=process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g,'\n');
  if(!privateKey)throw Object.assign(new Error('GitHub App private key is not configured'),{statusCode:503});
  return {...base,privateKey};
}
async function githubAppJwt(){
  const {clientId,privateKey}=appAuthConfig();
  appKeyPromise??=importPKCS8(privateKey,'RS256');
  const key=await appKeyPromise;
  const now=Math.floor(Date.now()/1000);
  return new SignJWT({})
    .setProtectedHeader({alg:'RS256'})
    .setIssuedAt(now-60)
    .setExpirationTime(now+9*60)
    .setIssuer(clientId)
    .sign(key);
}
export async function createInstallationToken(installationId:number){
  const jwt=await githubAppJwt();
  const response=await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`,{
    method:'POST',
    headers:{
      Accept:'application/vnd.github+json',
      Authorization:`Bearer ${jwt}`,
      'X-GitHub-Api-Version':'2026-03-10',
      'User-Agent':'CloudDeck'
    }
  });
  if(!response.ok)throw Object.assign(new Error('GitHub installation token request failed'),{statusCode:502});
  const body=z.object({token:z.string().min(1),expires_at:z.string()}).parse(await response.json());
  return body.token;
}
async function linkedInstallation(orgId:string,connectionId:string){
  const result=await pool.query(
    'SELECT id,installation_id,account_login FROM github_installations WHERE id=$1 AND organization_id=$2',
    [connectionId,orgId]
  );
  if(!result.rowCount)throw Object.assign(new Error('GitHub installation link not found'),{statusCode:404});
  return {id:result.rows[0].id as string,installationId:Number(result.rows[0].installation_id),accountLogin:result.rows[0].account_login as string};
}
async function installationRequest(installationId:number,url:string){
  const token=await createInstallationToken(installationId);
  return fetch(url,{
    headers:{
      Accept:'application/vnd.github+json',
      Authorization:`Bearer ${token}`,
      'X-GitHub-Api-Version':'2026-03-10',
      'User-Agent':'CloudDeck'
    }
  });
}

export async function verifyGitHubSource(orgId:string,connectionId:string,repositoryFullName:string,branch:string,sourcePath:string){
  const parts=repositoryFullName.split('/');
  if(parts.length!==2||!/^[A-Za-z0-9-]{1,100}$/.test(parts[0])||!/^[A-Za-z0-9_.-]{1,100}$/.test(parts[1])){
    throw Object.assign(new Error('Invalid GitHub repository name'),{statusCode:400});
  }
  if(!branch||branch.length>255)throw Object.assign(new Error('Invalid GitHub branch'),{statusCode:400});
  const pathParts=sourcePath.split('/');
  if(!sourcePath||sourcePath.startsWith('/')||sourcePath.length>240||pathParts.some(part=>!part||part==='.'||part==='..'||!/^[A-Za-z0-9._-]+$/.test(part))){
    throw Object.assign(new Error('Invalid deployment source path'),{statusCode:400});
  }
  const installation=await linkedInstallation(orgId,connectionId);
  const [owner,repo]=parts;
  const branchResponse=await installationRequest(
    installation.installationId,
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`
  );
  if(branchResponse.status===404)throw Object.assign(new Error('Repository or branch is not accessible through this GitHub installation'),{statusCode:400});
  if(!branchResponse.ok)throw Object.assign(new Error('Unable to verify GitHub branch'),{statusCode:502});
  const branchData=z.object({name:z.string(),commit:z.object({sha:z.string().regex(/^[a-f0-9]{40}$/i)})}).parse(await branchResponse.json());
  const encodedPath=pathParts.map(encodeURIComponent).join('/');
  const fileResponse=await installationRequest(
    installation.installationId,
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(branchData.commit.sha)}`
  );
  if(fileResponse.status===404)throw Object.assign(new Error('Deployment source file was not found on the selected branch'),{statusCode:400});
  if(!fileResponse.ok)throw Object.assign(new Error('Unable to verify deployment source file'),{statusCode:502});
  const file=z.object({type:z.literal('file'),path:z.string(),sha:z.string()}).parse(await fileResponse.json());
  return {commitSha:branchData.commit.sha,sourcePath:file.path,connectionId:installation.id};
}

async function findAccessibleInstallation(token:string,installationId:number){
  for(let page=1;page<=10;page++){
    const response=await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`,{
      headers:{
        Accept:'application/vnd.github+json',
        Authorization:`Bearer ${token}`,
        'X-GitHub-Api-Version':'2026-03-10',
        'User-Agent':'CloudDeck'
      }
    });
    if(!response.ok)throw Object.assign(new Error('GitHub installation verification failed'),{statusCode:502});
    const payload=z.object({installations:z.array(installationSchema).max(100)}).parse(await response.json());
    const match=payload.installations.find(item=>item.id===installationId);
    if(match)return match;
    if(payload.installations.length<100)break;
  }
  throw Object.assign(new Error('GitHub installation is not accessible to the authorizing user'),{statusCode:403});
}

export async function githubRoutes(app:FastifyInstance){
  app.post('/organizations/:orgId/github/connect',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=connectParams.parse(request.params);
    await membership(userId,orgId,'deployment.manage');
    const {slug}=config();
    const state=randomToken();
    await pool.query('DELETE FROM github_connection_states WHERE expires_at<=now() OR consumed_at IS NOT NULL');
    await pool.query(
      `INSERT INTO github_connection_states(token_hash,organization_id,user_id,phase,expires_at)
       VALUES($1,$2,$3,'install',now()+interval '10 minutes')`,
      [digest(state),orgId,userId]
    );
    await audit(orgId,userId,'github.connection.started','organization',orgId,request.ip);
    return {url:githubInstallUrl(slug,state),expiresInSeconds:600};
  });

  app.get('/github/setup',async (request,reply)=>{
    const query=setupQuery.parse(request.query);
    const state=await consumeState(query.state,'install');
    const oauthState=randomToken();
    await pool.query(
      `INSERT INTO github_connection_states(token_hash,organization_id,user_id,phase,installation_id,expires_at)
       VALUES($1,$2,$3,'oauth',$4,now()+interval '10 minutes')`,
      [digest(oauthState),state.organization_id,state.user_id,query.installation_id]
    );
    const {clientId,callback}=config();
    return reply.redirect(githubAuthorizeUrl(clientId,callback,oauthState));
  });

  app.get('/github/oauth/callback',async (request,reply)=>{
    const query=oauthQuery.parse(request.query);
    const state=await consumeState(query.state,'oauth');
    if(!state.installation_id)throw Object.assign(new Error('GitHub installation is missing'),{statusCode:400});
    const userToken=await exchangeUserToken(query.code);
    const installation=await findAccessibleInstallation(userToken,Number(state.installation_id));
    const linked=await transaction(async client=>{
      const existing=await client.query('SELECT id,organization_id FROM github_installations WHERE installation_id=$1',[installation.id]);
      if(existing.rowCount&&existing.rows[0].organization_id!==state.organization_id){
        throw Object.assign(new Error('GitHub installation is already linked to another workspace'),{statusCode:409});
      }
      if(existing.rowCount){
        const updated=await client.query(
          `UPDATE github_installations
           SET account_login=$2,account_type=$3,repository_selection=$4,permissions=$5,linked_by=$6,updated_at=now()
           WHERE installation_id=$1
           RETURNING id`,
          [installation.id,installation.account.login,installation.account.type,installation.repository_selection??null,JSON.stringify(installation.permissions??{}),state.user_id]
        );
        return updated.rows[0].id as string;
      }
      const created=await client.query(
        `INSERT INTO github_installations(organization_id,installation_id,account_login,account_type,repository_selection,permissions,linked_by)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [state.organization_id,installation.id,installation.account.login,installation.account.type,installation.repository_selection??null,JSON.stringify(installation.permissions??{}),state.user_id]
      );
      return created.rows[0].id as string;
    });
    await audit(state.organization_id,state.user_id,'github.installation.connected','github_installation',linked,request.ip,{installationId:installation.id,account:installation.account.login});
    const destination=new URL('/dashboard',process.env.APP_ORIGIN??'http://localhost:3000');
    destination.searchParams.set('github','connected');
    return reply.redirect(destination.toString());
  });

  app.get('/organizations/:orgId/github/installations',async request=>{
    const {userId}=await authenticate(request);
    const {orgId}=connectParams.parse(request.params);
    await membership(userId,orgId,'deployment.read');
    const rows=await pool.query(
      `SELECT id,installation_id,account_login,account_type,repository_selection,permissions,linked_at,updated_at
       FROM github_installations
       WHERE organization_id=$1
       ORDER BY linked_at DESC`,
      [orgId]
    );
    return {installations:rows.rows};
  });

  app.get('/organizations/:orgId/github/installations/:connectionId/repositories',async request=>{
    const {userId}=await authenticate(request);
    const {orgId,connectionId}=repositoryParams.parse(request.params);
    const {page,perPage}=pageQuery.parse(request.query);
    await membership(userId,orgId,'deployment.read');
    const installation=await linkedInstallation(orgId,connectionId);
    const response=await installationRequest(
      installation.installationId,
      `https://api.github.com/installation/repositories?per_page=${perPage}&page=${page}`
    );
    if(!response.ok)throw Object.assign(new Error('Unable to list GitHub repositories'),{statusCode:response.status===404?404:502});
    const payload=z.object({
      total_count:z.number().int().nonnegative(),
      repositories:z.array(z.object({
        id:z.number().int().positive(),
        name:z.string(),
        full_name:z.string(),
        private:z.boolean(),
        archived:z.boolean().optional(),
        disabled:z.boolean().optional(),
        default_branch:z.string()
      })).max(100)
    }).parse(await response.json());
    return {page,perPage,total:payload.total_count,repositories:payload.repositories};
  });

  app.get('/organizations/:orgId/github/installations/:connectionId/repositories/:owner/:repo/branches',async request=>{
    const {userId}=await authenticate(request);
    const {orgId,connectionId,owner,repo}=repoParams.parse(request.params);
    const {page,perPage}=pageQuery.parse(request.query);
    await membership(userId,orgId,'deployment.read');
    const installation=await linkedInstallation(orgId,connectionId);
    const response=await installationRequest(
      installation.installationId,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=${perPage}&page=${page}`
    );
    if(!response.ok)throw Object.assign(new Error('Unable to list GitHub branches'),{statusCode:response.status===404?404:502});
    const branches=z.array(z.object({
      name:z.string().min(1).max(255),
      commit:z.object({sha:z.string().regex(/^[a-f0-9]{40}$/i)})
    })).max(100).parse(await response.json());
    return {page,perPage,branches};
  });

  app.delete('/organizations/:orgId/github/installations/:connectionId',async request=>{
    const {userId}=await authenticate(request);
    const {orgId,connectionId}=z.object({orgId:uuid,connectionId:uuid}).parse(request.params);
    await membership(userId,orgId,'deployment.manage');
    const deleted=await pool.query('DELETE FROM github_installations WHERE id=$1 AND organization_id=$2 RETURNING installation_id,account_login',[connectionId,orgId]);
    if(!deleted.rowCount)throw Object.assign(new Error('GitHub installation link not found'),{statusCode:404});
    await audit(orgId,userId,'github.installation.disconnected','github_installation',connectionId,request.ip,{installationId:deleted.rows[0].installation_id,account:deleted.rows[0].account_login});
    return {ok:true};
  });
}
