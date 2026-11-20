import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {CoreError} from '../domain.ts';
import {awaitSignal,deadline,fetchJsonBounded} from './http.ts';
import {originUrl,resolveApiBase,resolveWebsite,stripSlash} from './urls.ts';

export const POLICY_VIOLATION='sign_in_policy_violation';
export const POLL_BASE_MS=1000;
export const POLL_FACTOR=1.2;
export const POLL_CAP_MS=10_000;
export const POLL_MAX_TRIES=150;
export const POLL_MAX_CONSECUTIVE_ERRORS=3;

export type LoginChallenge={verifier:string;challenge:string;uuid:string};
export function generateLoginChallenge():LoginChallenge{
  const verifier=randomBytes(32).toString('base64url');
  return {verifier,challenge:createHash('sha256').update(verifier).digest().toString('base64url'),uuid:randomUUID()};
}
export function buildLoginUrl(website:string,params:{challenge:string;uuid:string}){
  const url=new URL('/loginDeepControl',originUrl(website,'website')+'/');
  url.searchParams.set('challenge',params.challenge);
  url.searchParams.set('uuid',params.uuid);
  url.searchParams.set('mode','login');
  url.searchParams.set('redirectTarget','cli');
  return url.toString();
}
export function pollUrl(apiBase:string,uuid:string,verifier:string){
  const url=new URL('/auth/poll',originUrl(apiBase,'API base')+'/');
  url.searchParams.set('uuid',uuid);
  url.searchParams.set('verifier',verifier);
  return url.toString();
}
export function pollDelayMs(attemptIndex:number){return Math.min(POLL_CAP_MS,POLL_BASE_MS*POLL_FACTOR**attemptIndex);}

export type PollTokens={accessToken:string;refreshToken:string};
export type PollOutcome=
  |{status:'success';tokens:PollTokens}
  |{status:'pending'}
  |{status:'timeout'}
  |{status:'policy'}
  |{status:'unsupported';message:string}
  |{status:'failed';message:string};

export type PollHooks={fetch?:typeof fetch;sleep?:(ms:number)=>Promise<void>;maxTries?:number;maxConsecutiveErrors?:number;signal?:AbortSignal;requestDeadlineMs?:number;totalDeadlineMs?:number};

export async function pollOnce(opts:{apiBase:string;uuid:string;verifier:string}&PollHooks):Promise<Exclude<PollOutcome,{status:'timeout'}>>{
  const bounded=deadline(opts.requestDeadlineMs??10_000,opts.signal);
  try{
    const response=await fetchJsonBounded(opts.fetch??fetch,pollUrl(opts.apiBase,opts.uuid,opts.verifier),{method:'GET',redirect:'error',headers:{accept:'application/json'}},bounded.signal);
    if(response.status===404)return {status:'pending'};
    const body=response.body;
    if(response.status===403){
      if(body?.error===POLICY_VIOLATION)return {status:'policy'};
      return {status:'failed',message:'Login poll returned 403'};
    }
    if(!response.ok)return {status:'failed',message:`Login poll returned HTTP ${response.status}`};
    if(typeof body?.xaiAccessToken==='string')return {status:'unsupported',message:'xAI identity is not supported'};
    if(typeof body?.accessToken!=='string'||!body.accessToken)return {status:'failed',message:'Login poll did not return an access token'};
    if(body.refreshToken!==undefined&&(typeof body.refreshToken!=='string'||!body.refreshToken))return {status:'failed',message:'Login poll returned an invalid refresh token'};
    return {status:'success',tokens:{accessToken:body.accessToken,refreshToken:typeof body.refreshToken==='string'?body.refreshToken:''}};
  }catch{
    return {status:'failed',message:opts.signal?.aborted?'Login poll was canceled':'Login poll network or deadline failure'};
  }finally{bounded.dispose();}
}

export async function pollForLogin(opts:{apiBase:string;uuid:string;verifier:string}&PollHooks):Promise<PollOutcome>{
  const sleep=opts.sleep??((ms:number)=>new Promise<void>(r=>setTimeout(r,ms)));
  const total=deadline(opts.totalDeadlineMs??20*60_000,opts.signal);
  const maxTries=opts.maxTries??POLL_MAX_TRIES,maxErrors=opts.maxConsecutiveErrors??POLL_MAX_CONSECUTIVE_ERRORS;
  let consecutive=0;
  try{
    for(let i=0;i<maxTries;i++){
      total.signal.throwIfAborted();
      const step=await pollOnce({...opts,signal:total.signal});
      total.signal.throwIfAborted();
      if(step.status==='success'||step.status==='policy'||step.status==='unsupported')return step;
      if(step.status==='pending')consecutive=0;
      else if(++consecutive>=maxErrors)return {status:'failed',message:step.message};
      if(i+1<maxTries){
        if(opts.sleep)await awaitSignal(sleep(pollDelayMs(i)),total.signal);
        else await new Promise<void>((resolve,reject)=>{
          const abort=()=>{clearTimeout(timer);reject(total.signal.reason);};
          const timer=setTimeout(()=>{total.signal.removeEventListener('abort',abort);resolve();},pollDelayMs(i));
          total.signal.addEventListener('abort',abort,{once:true});
          if(total.signal.aborted){total.signal.removeEventListener('abort',abort);abort();}
        });
      }
    }
    return {status:'timeout'};
  }catch{
    return opts.signal?.aborted?{status:'failed',message:'Login poll was canceled'}:{status:'timeout'};
  }finally{total.dispose();}
}

export function pollOutcomeError(outcome:PollOutcome){
  if(outcome.status==='policy')return new CoreError('AUTH_NOT_CONFIGURED','Sign-in was rejected by organization policy');
  if(outcome.status==='timeout')return new CoreError('AUTH_NOT_CONFIGURED','Timed out waiting for browser login; open the new URL on stderr and retry');
  if(outcome.status==='unsupported')return new CoreError('AUTH_NOT_CONFIGURED',outcome.message);
  if(outcome.status==='failed')return new CoreError('AUTH_NOT_CONFIGURED',outcome.message);
  return new CoreError('AUTH_NOT_CONFIGURED','Login did not complete');
}

export function loginWebsite(env:NodeJS.ProcessEnv=process.env){return originUrl(resolveWebsite(env),'website');}
export function loginApiBase(env:NodeJS.ProcessEnv=process.env){return originUrl(resolveApiBase(env),'API base');}
export function refreshEndpoint(backend:string){return new URL('/oauth/token',stripSlash(backend)+'/').toString();}
