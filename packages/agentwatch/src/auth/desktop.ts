import {execFileSync} from 'node:child_process';
import {existsSync,openSync,closeSync,readSync,fstatSync,lstatSync,realpathSync,constants} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname,posix,win32} from 'node:path';
import {createDecipheriv} from 'node:crypto';
import {CoreError} from '../domain.ts';
import {authMode,desktopRejectedOnMac,independentHint} from './platform.ts';
import {decodeJwtExpMs} from './jwt.ts';
import {LINUX_BASIC_PASSWORD,LINUX_PBKDF2_ITERATIONS,decryptOscrypt,peekOscryptPrefix} from './oscrypt.ts';
import {originUrl,resolveApiBase} from './urls.ts';
import {authFailure} from './store.ts';

export type DesktopVariant='Grok Bot'|'Grok Bot Research'|'override';
export type DesktopAccess={token:string;source:string;secretsPath:string;variant:DesktopVariant;expiresAtMs?:number};

export function listSecretsCandidates(opts:{platform:NodeJS.Platform;home:string;env?:NodeJS.ProcessEnv}){
  const env=opts.env??process.env;
  const joinPath=opts.platform==='win32'?win32.join:posix.join;
  const file=env.AGENTWATCH_SECRETS_FILE?.trim();
  if(file)return [{path:file,variant:'override' as const}];
  const userData=env.AGENTWATCH_USER_DATA?.trim();
  if(userData)return [{path:joinPath(userData,'sand-secrets.json'),variant:'override' as const}];
  const dirs:{dir:string;variant:Exclude<DesktopVariant,'override'>}[]=[];
  if(opts.platform==='win32'){
    const appdata=env.APPDATA||joinPath(opts.home,'AppData','Roaming');
    dirs.push({dir:joinPath(appdata,'Grok Bot'),variant:'Grok Bot'},{dir:joinPath(appdata,'Grok Bot Research'),variant:'Grok Bot Research'});
  }else{
    const xdg=env.XDG_CONFIG_HOME?.trim()||joinPath(opts.home,'.config');
    dirs.push({dir:joinPath(xdg,'Grok Bot'),variant:'Grok Bot'},{dir:joinPath(xdg,'Grok Bot Research'),variant:'Grok Bot Research'});
  }
  return dirs.map(d=>({path:joinPath(d.dir,'sand-secrets.json'),variant:d.variant}));
}

function asString(value:unknown){return typeof value==='string'&&value.length>0?value:undefined;}

export function parseSandSecrets(raw:string,path:string,variant:DesktopVariant){
  let data:unknown;
  try{data=JSON.parse(raw);}catch{throw authFailure('Official credential file is not valid JSON');}
  if(!data||typeof data!=='object')throw authFailure('Official credential file is invalid');
  const rec=data as Record<string,unknown>;
  let accountsWrap:unknown=rec['cursor-accounts'];
  if(typeof accountsWrap==='string'){
    try{accountsWrap=JSON.parse(accountsWrap);}catch{throw authFailure('Official cursor-accounts field is not valid JSON');}
  }
  if(!accountsWrap||typeof accountsWrap!=='object')throw authFailure('Official credential file has no cursor-accounts');
  const wrap=accountsWrap as Record<string,unknown>;
  const accounts=(wrap.accounts&&typeof wrap.accounts==='object'?wrap.accounts:{}) as Record<string,unknown>;
  const active=typeof wrap.active==='string'?wrap.active:'';
  const id=active&&accounts[active]?active:Object.keys(accounts)[0];
  if(!id)throw authFailure('Official credential file has no account');
  const row=accounts[id];
  if(!row||typeof row!=='object')throw authFailure('Official credential account is invalid');
  const access=asString((row as Record<string,unknown>)['cursor-access-token']);
  if(!access)throw authFailure('Official credential account has no access token');
  return {path,variant,activeId:id,accessTokenCipher:access};
}

function readSecretsFile(path:string){
  let fd:number|undefined;
  try{
    if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw authFailure();
    const resolved=realpathSync(path);
    fd=openSync(resolved,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.size>262144)throw authFailure();
    const buffer=Buffer.alloc(262145);let size=0;
    for(;;){const n=readSync(fd,buffer,size,buffer.length-size,null);size+=n;if(size>262144)throw authFailure();if(n===0)break;}
    return buffer.subarray(0,size).toString('utf8');
  }catch(error){if(error instanceof CoreError)throw error;throw authFailure('Official credential file could not be read');}
  finally{if(fd!==undefined)closeSync(fd);}
}

export function isPlausibleSecret(pt:Buffer){
  if(pt.length===0)return false;
  const text=pt.toString('utf8').trim();
  try{
    if(text.startsWith('{')||text.startsWith('[')){JSON.parse(text);return true;}
    const parts=text.split('.');
    if(parts.length===3&&parts.every(p=>p.length>0&&/^[A-Za-z0-9_-]+$/.test(p)))return true;
    return text.length>=8&&/^[\x09\x0a\x0d\x20-\x7e]+$/.test(text);
  }catch{return false;}
}

function which(bin:string,env:NodeJS.ProcessEnv){
  const sep=process.platform==='win32'?';':':';
  for(const dir of (env.PATH??'').split(sep)){
    const candidate=join(dir,bin);
    if(existsSync(candidate))return candidate;
  }
}

function secretToolLookup(attrs:Record<string,string>,env:NodeJS.ProcessEnv){
  const bin=which('secret-tool',env);
  if(!bin)return;
  try{
    const stdout=execFileSync(bin,['lookup',...Object.entries(attrs).flat()],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:3000,env});
    const password=stdout.replace(/\n$/,'');
    return password.length>0?password:undefined;
  }catch{return;}
}

function decryptLinux(blob:Buffer,env:NodeJS.ProcessEnv){
  if(!peekOscryptPrefix(blob))throw authFailure('Official Linux credential ciphertext is missing the OSCrypt prefix');
  const passwords:[string,string][]=[];
  for(const app of ['Grok Bot','Grok Bot Research']){
    const password=secretToolLookup({application:app},env);
    if(password)passwords.push([`linux-libsecret:${app}`,password]);
  }
  passwords.push(['linux-basic-text',LINUX_BASIC_PASSWORD]);
  for(const [backend,password] of passwords){
    const plain=decryptOscrypt(blob,password,LINUX_PBKDF2_ITERATIONS);
    if(plain&&isPlausibleSecret(plain))return {plaintext:plain,source:backend};
  }
  throw authFailure('Unable to decrypt the official Grok Bot access token');
}

/** Only the DPAPI system call is injectable; no environment/CLI auth bypass. */
export type WindowsDecryptOptions={unprotect?:(blob:Buffer)=>Buffer|undefined};
function windowsDpapiUnprotect(blob:Buffer,env:NodeJS.ProcessEnv):Buffer|undefined{
  if(process.platform!=='win32')return undefined;
  // The ciphertext travels through stdin, never argv. Plaintext is captured in a private pipe only.
  const script="Add-Type -AssemblyName System.Security; $blob=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $plain=[System.Security.Cryptography.ProtectedData]::Unprotect($blob,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($plain))";
  try{
    const binary=win32.join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const output=execFileSync(binary,['-NoProfile','-NonInteractive','-Command',script],{input:blob.toString('base64'),encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:8000,maxBuffer:262144,windowsHide:true,env});
    const text=output.trim();
    if(!text||!(/^[A-Za-z0-9+/]+=*$/.test(text)))return undefined;
    return Buffer.from(text,'base64');
  }catch{return undefined;}
}
function decryptWindows(blob:Buffer,secretsFile:string,env:NodeJS.ProcessEnv,options:WindowsDecryptOptions={}){
  const unprotect=options.unprotect??((value:Buffer)=>windowsDpapiUnprotect(value,env));
  if(peekOscryptPrefix(blob)){
    // Only the matching application's Local State, not another installed variant's key.
    try{
      const state=JSON.parse(readSecretsFile(join(dirname(secretsFile),'Local State')));
      const encoded=state.os_crypt?.encrypted_key;
      if(typeof encoded==='string'){
        const wrapped=Buffer.from(encoded,'base64');
        if(wrapped.subarray(0,5).toString()==='DPAPI'){
          const key=unprotect(wrapped.subarray(5));
          if(key?.length===32&&blob.length>=3+12+16){
            const decipher=createDecipheriv('aes-256-gcm',key,blob.subarray(3,15));
            decipher.setAuthTag(blob.subarray(-16));
            const plaintext=Buffer.concat([decipher.update(blob.subarray(15,-16)),decipher.final()]);
            if(isPlausibleSecret(plaintext))return {plaintext,source:'windows-os-crypt-gcm'};
          }
        }
      }
    }catch{/* Try the direct DPAPI format below; never guess a key. */}
    for(const value of [blob.subarray(3),blob]){
      const plaintext=unprotect(value);
      if(plaintext&&isPlausibleSecret(plaintext))return {plaintext,source:'windows-dpapi'};
    }
  }else{
    const plaintext=unprotect(blob);
    if(plaintext&&isPlausibleSecret(plaintext))return {plaintext,source:'windows-dpapi'};
  }
  throw authFailure('Unable to decrypt official Windows credentials; open and sign in to Grok Bot in the same Windows user session');
}

function decryptAccessCipher(cipher:string,platform:NodeJS.Platform,env:NodeJS.ProcessEnv,secretsFile:string,windows?:WindowsDecryptOptions){
  let blob:Buffer;
  try{blob=Buffer.from(cipher,'base64');}catch{throw authFailure('Official credential ciphertext is not valid base64');}
  if(blob.length===0)throw authFailure('Official credential ciphertext is empty');
  if(platform==='win32')return decryptWindows(blob,secretsFile,env,windows);
  return decryptLinux(blob,env);
}

export function loadDesktopAccess(opts:{platform?:NodeJS.Platform;home?:string;env?:NodeJS.ProcessEnv;now?:number;windows?:WindowsDecryptOptions}={}):DesktopAccess{
  const platform=opts.platform??process.platform;
  if(authMode(platform)==='independent')throw authFailure(desktopRejectedOnMac());
  const env=opts.env??process.env;
  const home=opts.home??env.HOME??homedir();
  const candidates=listSecretsCandidates({platform,home,env});
  const existing=candidates.filter(c=>existsSync(c.path));
  if(existing.length===0)throw authFailure(independentHint());
  let last:CoreError|undefined;
  for(const candidate of existing){
    try{
      const parsed=parseSandSecrets(readSecretsFile(candidate.path),candidate.path,candidate.variant);
      const {plaintext,source}=decryptAccessCipher(parsed.accessTokenCipher,platform,env,parsed.path,opts.windows);
      const token=plaintext.toString('utf8').trim();
      if(!token)throw authFailure('Decrypted official access token is empty');
      const expiresAtMs=decodeJwtExpMs(token);
      if(expiresAtMs!==undefined&&expiresAtMs<=(opts.now??Date.now()))throw authFailure(independentHint());
      return {token,source,secretsPath:parsed.path,variant:parsed.variant,expiresAtMs};
    }catch(error){
      if(error instanceof CoreError){last=error;continue;}
      throw error;
    }
  }
  throw last??authFailure(independentHint());
}

export function peekDesktopReady(opts:{platform?:NodeJS.Platform;home?:string;env?:NodeJS.ProcessEnv;now?:number}={}){
  try{loadDesktopAccess(opts);desktopConnectBackend(opts.env??process.env);return true;}catch{return false;}
}

export function desktopConnectBackend(env:NodeJS.ProcessEnv=process.env){
  return originUrl(resolveApiBase(env),'API base');
}
