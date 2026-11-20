import {CoreError} from '../domain.ts';
import {awaitSignal} from './http.ts';
import {authMode,authPlatform,independentHint,loginUnsupportedOnDesktop} from './platform.ts';
import {desktopConnectBackend,loadDesktopAccess,peekDesktopReady} from './desktop.ts';
import {buildLoginUrl,generateLoginChallenge,loginApiBase,loginWebsite,pollForLogin,pollOutcomeError,type PollHooks} from './login.ts';
import {RefreshError,refreshDecision,refreshIndependentTokens} from './refresh.ts';
import {withRefreshExchangeLock,attachRefreshProof,isPeerRefresh,sameCredential,clearCredentialIfUnchangedUnlocked,writeCredentialIfUnchangedUnlocked,advanceLoginGeneration,readLoginGeneration,readLoginState,recordLoginFailureUnlocked,authFailure,clearIndependentUnlocked,clearPendingUnlocked,credsFromTokens,peekIndependentReady,readIndependentCredentials,readPendingLogin,resolveClientId,tryReadIndependentCredentials,withCredentialLock,writeIndependentUnlocked,writePendingUnlocked,type IndependentCredentials,type PendingLogin} from './store.ts';

export type Access={backend:string;accessToken:string;clientId?:string};

let testPoll:PollHooks|undefined;
export function setAuthPollHooksForTests(hooks?:PollHooks){testPoll=hooks;}

export type SessionOptions={
  platform?:NodeJS.Platform;
  env?:NodeJS.ProcessEnv;
  home?:string;
  now?:()=>number;
  fetch?:typeof fetch;
  poll?:PollHooks;
};

export type LoginBegin={login_url:string;uuid:string;reused:boolean};
export type LoginStatus={status:'idle'|'pending'|'completed'|'failed';uuid?:string;message?:string};

export function createAuthSession(opts:SessionOptions={}){
  const env=()=>opts.env??process.env;
  const platform=()=>opts.platform??authPlatform();
  const now=()=>(opts.now??Date.now)();
  const home=()=>opts.home??env().HOME;
  let refreshInflight:Promise<Access>|undefined;
  let login:{promise:Promise<IndependentCredentials>;uuid:string}|undefined;
  let lastLoginError:CoreError|undefined;
  let pollAbort:AbortController|undefined;

  function requireIndependent(){
    if(authMode(platform())!=='independent')throw authFailure(loginUnsupportedOnDesktop());
  }

  function toAccess(creds:IndependentCredentials):Access{
    return {backend:creds.backend,accessToken:creds.access_token,clientId:resolveClientId(env(),creds.client_id)};
  }

  function ensurePolling(pending:PendingLogin){
    if(login?.uuid===pending.uuid)return;
    pollAbort?.abort();
    pollAbort=new AbortController();
    const hooks:PollHooks={...opts.poll,...testPoll,fetch:testPoll?.fetch??opts.poll?.fetch??opts.fetch,signal:pollAbort.signal,sleep:testPoll?.sleep??opts.poll?.sleep,maxTries:testPoll?.maxTries??opts.poll?.maxTries,maxConsecutiveErrors:testPoll?.maxConsecutiveErrors??opts.poll?.maxConsecutiveErrors};
    const promise=pollForLogin({apiBase:pending.api_base||loginApiBase(env()),uuid:pending.uuid,verifier:pending.verifier,...hooks}).then(async outcome=>{
      if(outcome.status!=='success')throw pollOutcomeError(outcome);
      const creds=credsFromTokens({
        access:outcome.tokens.accessToken,
        refresh:outcome.tokens.refreshToken,
        backend:pending.api_base||loginApiBase(env()),
        clientId:resolveClientId(env()),
        source:'login_poll',
        now:now(),
      });
      await withCredentialLock(env(),async()=>{
        const current=readPendingLogin(env(),home());
        if(readLoginGeneration(env(),home())!==pending.generation||current?.uuid!==pending.uuid||current.verifier!==pending.verifier)throw authFailure('Login was canceled or superseded');
        writeIndependentUnlocked(env(),creds,home());
        clearPendingUnlocked(env(),home());
      },home());
      lastLoginError=undefined;
      return creds;
    }).catch(async error=>{
      const known=error instanceof CoreError?error:authFailure();
      await withCredentialLock(env(),async()=>{
        if(readLoginGeneration(env(),home())===pending.generation&&readPendingLogin(env(),home())?.uuid===pending.uuid){
          clearPendingUnlocked(env(),home());
          recordLoginFailureUnlocked(env(),pending.generation,known.message,home());
        }
      },home());
      if(login?.uuid===pending.uuid)lastLoginError=known;
      throw known;
    }).finally(()=>{if(login?.promise===promise)login=undefined;});
    login={promise,uuid:pending.uuid};
    lastLoginError=undefined;
    void promise.catch(()=>{});
  }

  async function beginLogin():Promise<LoginBegin>{
    requireIndependent();
    const selected=await withCredentialLock(env(),async()=>{
      const existing=readPendingLogin(env(),home());
      if(existing&&existing.generation===readLoginGeneration(env(),home())&&existing.started_at_ms+20*60_000>now())return {pending:existing,reused:true};
      const challenge=generateLoginChallenge();
      const website=loginWebsite(env());
      const login_url=buildLoginUrl(website,challenge);
      const generation=advanceLoginGeneration(env(),home());
      const pending:PendingLogin={generation,...challenge,login_url,api_base:loginApiBase(env()),website,started_at_ms:now()};
      writePendingUnlocked(env(),pending,home());
      return {pending,reused:false};
    },home());
    ensurePolling(selected.pending);
    return {login_url:selected.pending.login_url,uuid:selected.pending.uuid,reused:selected.reused};
  }

  function loginStatus():LoginStatus{
    if(authMode(platform())!=='independent')return {status:'idle'};
    const persisted=readLoginState(env(),home());
    if(persisted?.status==='failed')return {status:'failed',message:persisted.message};
    const pending=readPendingLogin(env(),home());
    if(pending&&pending.generation===persisted?.generation)return {status:'pending',uuid:pending.uuid};
    if(lastLoginError)return {status:'failed',message:lastLoginError.message};
    if(tryReadIndependentCredentials(env(),home()))return {status:'completed'};
    return {status:'idle'};
  }

  async function waitForLogin(){
    requireIndependent();
    const pending=readPendingLogin(env(),home());
    if(pending)ensurePolling(pending);
    if(login)return login.promise;
    const creds=tryReadIndependentCredentials(env(),home());
    if(creds)return creds;
    if(lastLoginError)throw lastLoginError;
    throw authFailure('No login is in progress');
  }

  async function logout(){
    requireIndependent();
    pollAbort?.abort();
    pollAbort=undefined;
    login=undefined;
    lastLoginError=undefined;
    await withCredentialLock(env(),async()=>{advanceLoginGeneration(env(),home());clearIndependentUnlocked(env(),home());},home());
    return {removed:true};
  }

  async function loadIndependent():Promise<Access>{
    // Validate before lock setup can create/chmod the directory; preserve unsafe-path rejection.
    try{readIndependentCredentials(env(),home());}
    catch{throw authFailure('Not signed in to independent agentwatch credentials');}
    const initial=await withCredentialLock(env(),async()=>{
      let creds:IndependentCredentials;
      try{creds=readIndependentCredentials(env(),home());}
      catch{throw authFailure('Not signed in to independent agentwatch credentials');}
      const clientId=resolveClientId(env(),creds.client_id);
      const decision=refreshDecision(creds,{now:now(),clientId});
      return {creds,decision,clientId,generation:readLoginGeneration(env(),home())};
    },home());
    const {creds,decision}=initial;
    if(decision==='ok')return toAccess(creds);
    if(decision==='need_client_id'){
      if(creds.expires_at_ms===undefined||creds.expires_at_ms>now())return toAccess(creds);
      throw authFailure('Access token expired and no OAuth client_id is configured');
    }
    const next=await withRefreshExchangeLock(env(),async()=>{
      const snapshot=await withCredentialLock(env(),async()=>{
        const current=readIndependentCredentials(env(),home());
        const client=resolveClientId(env(),current.client_id);
        const binding={generation:initial.generation,clientId:initial.clientId};
        if(readLoginGeneration(env(),home())!==initial.generation||client!==initial.clientId||(!sameCredential(creds,current)&&!isPeerRefresh(creds,current,binding)))throw authFailure('Credential session changed while waiting for refresh');
        return {current,client,decision:refreshDecision(current,{now:now(),clientId:client}),generation:readLoginGeneration(env(),home())};
      },home());
      const {current,client,decision,generation}=snapshot;
      if(decision==='ok')return current;
      if(decision==='need_client_id')throw authFailure('Access token expired and no OAuth client_id is configured');
      let rotated:IndependentCredentials|undefined,exchangeError:unknown;
      try{rotated=await refreshIndependentTokens(current,client??'',{fetch:opts.fetch,now});}
      catch(error){exchangeError=error;}
      // Only short CAS mutations hold the login/logout lock; network exchange retains its separate lock.
      return withCredentialLock(env(),async()=>{
        const latest=tryReadIndependentCredentials(env(),home());
        if(!latest||!sameCredential(latest,current)||readLoginGeneration(env(),home())!==generation)throw authFailure('Credential session or login generation changed during refresh');
        if(rotated){
          rotated=attachRefreshProof(current,rotated,{generation,clientId:client});
          if(!writeCredentialIfUnchangedUnlocked(env(),current,rotated,home()))throw authFailure('Credential changed before refresh writeback');
          return rotated;
        }
        if(exchangeError instanceof RefreshError&&exchangeError.details.revoked){
          clearCredentialIfUnchangedUnlocked(env(),current,home());
          throw exchangeError;
        }
        if(exchangeError instanceof RefreshError&&exchangeError.details.canFallback&&(latest.expires_at_ms===undefined||latest.expires_at_ms>now()))return latest;
        throw exchangeError instanceof CoreError?exchangeError:authFailure();
      },home());
    },home());
    return toAccess(next);
  }

  async function getAccessToken(signal?:AbortSignal):Promise<Access>{
    signal?.throwIfAborted();
    if(authMode(platform())==='desktop'){
      const token=loadDesktopAccess({platform:platform(),home:home(),env:env(),now:now()});
      return {backend:desktopConnectBackend(env()),accessToken:token.token};
    }
    refreshInflight??=loadIndependent().finally(()=>{refreshInflight=undefined;});
    // A caller owns only its wait. The shared exchange keeps its own 20s budget and writes back.
    return signal?awaitSignal(refreshInflight,signal):refreshInflight;
  }

  function peekReady(){
    if(authMode(platform())==='desktop')return peekDesktopReady({platform:platform(),home:home(),env:env(),now:now()});
    return peekIndependentReady(env(),home(),now());
  }

  return {getAccessToken,peekReady,beginLogin,loginStatus,waitForLogin,logout,platform,env};
}

const production=createAuthSession();
export function defaultAuthSession(){return production;}
export function getAccessToken(signal?:AbortSignal){return production.getAccessToken(signal);}
export function peekAuthReady(){return production.peekReady();}
export function beginLogin(){return production.beginLogin();}
export function loginStatus(){return production.loginStatus();}
export function waitForLogin(){return production.waitForLogin();}
export function logout(){return production.logout();}
