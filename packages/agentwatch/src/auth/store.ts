import {Schema} from 'effect';
import {openSync,closeSync,readSync,readFileSync,realpathSync,fstatSync,lstatSync,mkdirSync,renameSync,writeFileSync,unlinkSync,chmodSync,constants,existsSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {CoreError} from '../domain.ts';
import {decodeJwtExpMs,decodeJwtSubject} from './jwt.ts';
import {withAdvisoryLock} from './lock.ts';
import {originUrl} from './urls.ts';

export const IndependentCredentials=Schema.Struct({
  version:Schema.Literal(1),
  backend:Schema.String,
  access_token:Schema.String,
  refresh_token:Schema.optional(Schema.String),
  client_id:Schema.optional(Schema.String),
  expires_at_ms:Schema.optional(Schema.Number),
  updated_at_ms:Schema.optional(Schema.Number),
  account_subject:Schema.optional(Schema.String),
  session_id:Schema.optional(Schema.String),
  revision:Schema.optional(Schema.Number),
  refresh_proof:Schema.optional(Schema.Struct({parent:Schema.String,result:Schema.String})),
  credential_source:Schema.optional(Schema.Literals(['login_poll','refresh'])),
});
export type IndependentCredentials=typeof IndependentCredentials.Type;

export type PendingLogin={generation:string;verifier:string;challenge:string;uuid:string;login_url:string;api_base:string;website:string;started_at_ms:number};

export const authFailure=(message='Agentwatch credentials are unavailable')=>new CoreError('AUTH_NOT_CONFIGURED',message);

export function independentPaths(env:NodeJS.ProcessEnv=process.env,home=env.HOME||homedir()){
  const path=resolve(env.AGENTWATCH_CREDENTIALS??join(home,'.agentwatch','auth','credentials.json'));
  if(path.split(/[\\/]/).some(s=>s==='.gbc'||s==='sand-secrets'))throw authFailure();
  return {file:path,dir:dirname(path),lock:join(dirname(path),'credentials.lock'),exchange:join(dirname(path),'credentials-refresh.lock'),pending:join(dirname(path),'pending-login.json'),generation:join(dirname(path),'login-generation.json')};
}

function rejectUnsafeIndependentPath(path:string){
  if(process.platform==='win32')throw authFailure();
  if(realpathSync(path)!==path)throw authFailure();
  const dir=dirname(path),parent=lstatSync(dir);
  if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid?.()||(parent.mode&0o077)!==0)throw authFailure();
  return parent;
}

export function readIndependentFile(path:string):IndependentCredentials{
  let fd:number|undefined;
  try{
    const parent=rejectUnsafeIndependentPath(path);
    fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.size>16384||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw authFailure();
    const buffer=Buffer.alloc(16385);let size=0;
    for(;;){const n=readSync(fd,buffer,size,buffer.length-size,null);size+=n;if(size>16384)throw authFailure();if(n===0)break;}
    const after=lstatSync(dirname(path));if(parent.dev!==after.dev||parent.ino!==after.ino)throw authFailure();
    const data=Schema.decodeUnknownSync(IndependentCredentials)(JSON.parse(buffer.subarray(0,size).toString('utf8')));
    if(!data.access_token||data.access_token.length>8192||!/^[A-Za-z0-9._~+\/-]+=*$/.test(data.access_token))throw authFailure();
    if(data.refresh_token!==undefined&&(data.refresh_token.length>8192||!/^[A-Za-z0-9._~+\/-]+=*$/.test(data.refresh_token)))throw authFailure();
    if(data.client_id!==undefined&&(data.client_id.length>512||/[\s\x00-\x1f]/.test(data.client_id)))throw authFailure();
    if(data.refresh_proof&&(!/^[a-f0-9]{64}$/.test(data.refresh_proof.parent)||!/^[a-f0-9]{64}$/.test(data.refresh_proof.result)))throw authFailure();
    const expires=data.expires_at_ms??decodeJwtExpMs(data.access_token);
    if(expires!==undefined&&!Number.isSafeInteger(expires))throw authFailure();
    originUrl(data.backend,'credential backend');
    return {...data,expires_at_ms:expires,account_subject:data.account_subject??decodeJwtSubject(data.access_token)};
  }catch(error){if(error instanceof CoreError)throw error;throw authFailure();}
  finally{if(fd!==undefined)closeSync(fd);}
}

export function readIndependentCredentials(env:NodeJS.ProcessEnv=process.env,home?:string):IndependentCredentials{
  return readIndependentFile(independentPaths(env,home).file);
}

export function peekIndependentReady(env:NodeJS.ProcessEnv=process.env,home?:string,now=Date.now()){
  try{
    const data=readIndependentCredentials(env,home);
    return data.expires_at_ms===undefined||data.expires_at_ms>now;
  }catch{return false;}
}

export function resolveClientId(env:NodeJS.ProcessEnv,stored?:string){
  const a=env.AGENTWATCH_CLIENT_ID?.trim()||undefined;
  const b=env.AGENTWATCH_OAUTH_CLIENT_ID?.trim()||undefined;
  if(a&&b&&a!==b)throw authFailure('AGENTWATCH_CLIENT_ID and AGENTWATCH_OAUTH_CLIENT_ID must match');
  const fromEnv=a||b;
  if(fromEnv&&(fromEnv.length>512||/[\s\x00-\x1f]/.test(fromEnv)))throw authFailure();
  if(fromEnv&&stored&&fromEnv!==stored)throw authFailure('Configured client_id does not match the bound credential');
  return fromEnv||stored;
}

export function ensureAuthDir(dir:string){
  mkdirSync(dir,{recursive:true,mode:0o700});
  try{chmodSync(dir,0o700);}catch{}
  const stat=lstatSync(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)))throw authFailure();
}

function atomicWrite(file:string,data:unknown){
  const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp,JSON.stringify(data),{mode:0o600,flag:'wx'});
  try{chmodSync(tmp,0o600);}catch{}
  renameSync(tmp,file);
  try{chmodSync(file,0o600);}catch{}
}

export async function withCredentialLock<T>(env:NodeJS.ProcessEnv,fn:()=>Promise<T>,home?:string,opts?:{waitMs?:number;signal?:AbortSignal}){
  const paths=independentPaths(env,home);
  ensureAuthDir(paths.dir);
  return withAdvisoryLock(paths.lock,fn,opts);
}

export function writeIndependentUnlocked(env:NodeJS.ProcessEnv,data:IndependentCredentials,home?:string){
  const paths=independentPaths(env,home);
  ensureAuthDir(paths.dir);
  originUrl(data.backend,'credential backend');
  atomicWrite(paths.file,data);
}

export function writePendingUnlocked(env:NodeJS.ProcessEnv,pending:PendingLogin,home?:string){
  const paths=independentPaths(env,home);
  ensureAuthDir(paths.dir);
  atomicWrite(paths.pending,pending);
}

export function readPendingLogin(env:NodeJS.ProcessEnv=process.env,home?:string):PendingLogin|undefined{
  const file=independentPaths(env,home).pending;
  try{
    if(!existsSync(file))return undefined;
    rejectUnsafeIndependentPath(file);
    const data=JSON.parse(readFileSync(file,'utf8')) as Partial<PendingLogin>;
    if(typeof data.generation!=='string'||typeof data.verifier!=='string'||typeof data.challenge!=='string'||typeof data.uuid!=='string'||typeof data.login_url!=='string')return undefined;
    return {
      generation:data.generation,verifier:data.verifier,challenge:data.challenge,uuid:data.uuid,login_url:data.login_url,
      api_base:typeof data.api_base==='string'?data.api_base:'',
      website:typeof data.website==='string'?data.website:'',
      started_at_ms:typeof data.started_at_ms==='number'?data.started_at_ms:0,
    };
  }catch{return undefined;}
}

export function clearIndependentUnlocked(env:NodeJS.ProcessEnv,home?:string){
  const paths=independentPaths(env,home);
  for(const file of [paths.file,paths.pending]){
    try{if(existsSync(file))unlinkSync(file);}catch{}
  }
}

export function clearPendingUnlocked(env:NodeJS.ProcessEnv,home?:string){
  const file=independentPaths(env,home).pending;
  try{if(existsSync(file))unlinkSync(file);}catch{}
}

export function tryReadIndependentCredentials(env:NodeJS.ProcessEnv=process.env,home?:string){
  const file=independentPaths(env,home).file;
  if(!existsSync(file))return undefined;
  try{return readIndependentFile(file);}catch{return undefined;}
}

export function credsFromTokens(input:{access:string;refresh?:string;backend:string;clientId?:string;source:'login_poll'|'refresh';previous?:IndependentCredentials;now?:number}):IndependentCredentials{
  const now=input.now??Date.now();
  const subject=decodeJwtSubject(input.access)??input.previous?.account_subject;
  return {
    version:1,
    backend:originUrl(input.backend,'credential backend'),
    access_token:input.access,
    refresh_token:input.refresh||input.previous?.refresh_token,
    client_id:input.clientId||input.previous?.client_id,
    expires_at_ms:decodeJwtExpMs(input.access),
    updated_at_ms:now,
    account_subject:subject,
    session_id:input.source==='login_poll'||!input.previous?randomUUID():credentialSessionId(input.previous),
    revision:(input.previous?.revision??0)+1,
    credential_source:input.source,
  };
}

/** Persistent generation is shared by login/logout processes. Mutation requires the credential lock. */
export function readLoginState(env:NodeJS.ProcessEnv,home?:string):{generation:string;status?:string;message?:string}|undefined{
  const file=independentPaths(env,home).generation;
  if(!existsSync(file))return undefined;
  rejectUnsafeIndependentPath(file);
  const stat=lstatSync(file);
  if(!stat.isFile()||stat.nlink!==1||stat.size>1024||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw authFailure();
  const value=JSON.parse(readFileSync(file,'utf8'));
  if(typeof value.generation!=='string')throw authFailure();
  return {generation:value.generation,status:value.status,message:value.message};
}
export function advanceLoginGeneration(env:NodeJS.ProcessEnv,home?:string){
  const generation=randomUUID();
  atomicWrite(independentPaths(env,home).generation,{generation});
  return generation;
}

export function readLoginGeneration(env:NodeJS.ProcessEnv,home?:string){return readLoginState(env,home)?.generation;}
export function recordLoginFailureUnlocked(env:NodeJS.ProcessEnv,generation:string,message:string,home?:string){
  if(readLoginGeneration(env,home)!==generation)return;
  atomicWrite(independentPaths(env,home).generation,{generation,status:'failed',message});
}

/** Exchange ownership is separate from short mutations so login/logout can supersede an in-flight IdP call. */
export async function withRefreshExchangeLock<T>(env:NodeJS.ProcessEnv,fn:()=>Promise<T>,home?:string){
  const paths=independentPaths(env,home);ensureAuthDir(paths.dir);
  return withAdvisoryLock(paths.exchange,fn);
}
/** A legacy identity binds the FULL normalized credential snapshot, not just an account or absent ID.
 * Persisted only by successful rotation. A new login always receives an unrelated random session ID. */
function credentialSessionId(creds:IndependentCredentials){
  return creds.session_id??`legacy-v1:${createHash('sha256').update(JSON.stringify([
    creds.version,creds.backend,creds.account_subject??null,creds.access_token,creds.refresh_token??null,
    creds.client_id??null,creds.expires_at_ms??null,creds.updated_at_ms??null,creds.revision??null,creds.credential_source??null,
  ])).digest('hex')}`;
}
export function sameCredentialSession(a:IndependentCredentials,b:IndependentCredentials){
  return credentialSessionId(a)===credentialSessionId(b)&&a.backend===b.backend&&a.account_subject===b.account_subject;
}
export function sameCredential(a:IndependentCredentials,b:IndependentCredentials){
  return sameCredentialSession(a,b)&&snapshotHash(a,true)===snapshotHash(b,true);
}
/** Both CAS helpers require the mutation lock. Revocation removes ONLY this credential pair, never login state. */
export function clearCredentialIfUnchangedUnlocked(env:NodeJS.ProcessEnv,expected:IndependentCredentials,home?:string){
  const latest=tryReadIndependentCredentials(env,home);
  if(!latest||!sameCredential(latest,expected))return false;
  unlinkSync(independentPaths(env,home).file);
  return true;
}
export function writeCredentialIfUnchangedUnlocked(env:NodeJS.ProcessEnv,expected:IndependentCredentials,next:IndependentCredentials,home?:string){
  const latest=tryReadIndependentCredentials(env,home);
  if(!latest||!sameCredential(latest,expected))return false;
  writeIndependentUnlocked(env,next,home);
  return true;
}

export type RefreshBinding={generation?:string;clientId?:string};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** All normalized credential fields participate; the result hash excludes its own receipt only. */
function snapshotHash(creds:IndependentCredentials,includeProof:boolean){
  return digest([
    creds.version,creds.backend,creds.account_subject??null,creds.access_token,creds.refresh_token??null,
    creds.client_id??null,creds.expires_at_ms??null,creds.updated_at_ms??null,creds.revision??null,
    creds.credential_source??null,creds.session_id??null,
    ...(includeProof?[creds.refresh_proof?.parent??null,creds.refresh_proof?.result??null]:[]),
  ]);
}
/** Local CAS lineage, not a remote identity attestation or an ambiguous-exchange journal. */
export function attachRefreshProof(previous:IndependentCredentials,next:IndependentCredentials,binding:RefreshBinding):IndependentCredentials{
  const parent=digest(['agentwatch-refresh-parent-v1',snapshotHash(previous,true),binding.generation??null,binding.clientId??null]);
  const result=digest(['agentwatch-refresh-result-v1',parent,snapshotHash(next,false)]);
  return {...next,refresh_proof:{parent,result}};
}
/** Only a direct, exact-snapshot successor may fill optional metadata. Equal session/account alone is insufficient. */
export function isPeerRefresh(previous:IndependentCredentials,current:IndependentCredentials,binding:RefreshBinding){
  if(!binding.clientId||current.client_id!==binding.clientId||current.credential_source!=='refresh'||!current.refresh_proof)return false;
  if(current.backend!==originUrl(previous.backend,'credential backend')||current.session_id!==credentialSessionId(previous))return false;
  if(current.revision!==(previous.revision??0)+1)return false;
  if(previous.account_subject!==undefined&&current.account_subject!==previous.account_subject)return false;
  // A newly populated binding must be exactly the received access JWT sub; opaque/missing sub cannot invent one.
  if(current.account_subject!==decodeJwtSubject(current.access_token))return false;
  const expected=attachRefreshProof(previous,current,binding).refresh_proof!;
  return current.refresh_proof.parent===expected.parent&&current.refresh_proof.result===expected.result;
}
