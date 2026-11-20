import {CoreError} from '../domain.ts';
import {deadline as exchangeDeadline,fetchJsonBounded} from './http.ts';
import {decodeJwtSubject} from './jwt.ts';
import {refreshEndpoint} from './login.ts';
import {authFailure,credsFromTokens,type IndependentCredentials} from './store.ts';

export const REFRESH_EARLY_MS=300_000;
export const REFRESH_DEADLINE_MS=20_000;

export type RefreshDecision='ok'|'refresh'|'need_client_id';
export function refreshDecision(creds:IndependentCredentials,opts:{now?:number;clientId?:string}):RefreshDecision{
  const now=opts.now??Date.now();
  const exp=creds.expires_at_ms;
  if(exp!==undefined&&exp>now){
    if(opts.clientId&&exp-REFRESH_EARLY_MS<=now)return 'refresh';
    return 'ok';
  }
  return opts.clientId?'refresh':'need_client_id';
}

export class RefreshError extends CoreError{
  constructor(message:string,readonly details:{kind:string;canFallback:boolean;revoked?:boolean;ambiguous?:boolean}){
    super('AUTH_NOT_CONFIGURED',message);
  }
}

type RefreshBody={access_token?:unknown;refresh_token?:unknown;shouldLogout?:unknown;error?:unknown};

export type RefreshHttp={fetch?:typeof fetch;deadlineMs?:number;signal?:AbortSignal;now?:()=>number};

let ambiguous:{session_id?:string;refresh_token:string;until_ms:number}|undefined;
export function rememberAmbiguous(sessionId:string|undefined,refreshToken:string,now:number){
  ambiguous={session_id:sessionId,refresh_token:refreshToken,until_ms:now+120_000};
}
export function isAmbiguousProtect(sessionId:string|undefined,refreshToken:string,now:number){
  return !!ambiguous&&ambiguous.refresh_token===refreshToken&&ambiguous.session_id===sessionId&&ambiguous.until_ms>now;
}
export function clearAmbiguousForTests(){ambiguous=undefined;}

export async function refreshIndependentTokens(creds:IndependentCredentials,clientId:string,http:RefreshHttp={}):Promise<IndependentCredentials>{
  if(!clientId)throw new RefreshError('Access token expired and no OAuth client_id is configured',{kind:'unconfigured',canFallback:false});
  if(!creds.refresh_token)throw new RefreshError('No refresh token is stored; sign in again',{kind:'revoked',canFallback:false,revoked:true});
  const url=refreshEndpoint(creds.backend);
  const doFetch=http.fetch??fetch;
  const deadline=http.deadlineMs??REFRESH_DEADLINE_MS;
  const clock=http.now??Date.now;
  const bounded=exchangeDeadline(deadline,http.signal);
  let response:Awaited<ReturnType<typeof fetchJsonBounded>>;
  try{
    bounded.signal.throwIfAborted();
    response=await fetchJsonBounded(doFetch,url,{
      method:'POST',
      redirect:'error',
      headers:{'content-type':'application/json',accept:'application/json'},
      body:JSON.stringify({client_id:clientId,grant_type:'refresh_token',refresh_token:creds.refresh_token}),
    },bounded.signal);
  }catch(error){
    const timeout=bounded.signal.aborted||(error instanceof Error&&(error.name==='TimeoutError'||error.name==='AbortError'));
    // Headers are not an exchange outcome. A lost/timed-out body may hide a successful RT rotation,
    // just like a connection loss before headers; never treat a later invalid_grant as proof of revocation.
    rememberAmbiguous(creds.session_id,creds.refresh_token,clock());
    const still=creds.expires_at_ms===undefined||creds.expires_at_ms>clock();
    throw new RefreshError(timeout?'Token refresh timed out; credentials were kept':'Token refresh connection or response failure; credentials were kept',{kind:timeout?'timeout':'network',canFallback:still,ambiguous:true});
  }finally{bounded.dispose();}
  const body=response.body as RefreshBody|undefined;
  const stillValid=()=>creds.expires_at_ms===undefined||creds.expires_at_ms>clock();
  const terminal=body?.shouldLogout===true||body?.error==='sign_in_policy_violation'||body?.error==='invalid_grant';
  if(terminal){
    if(body?.shouldLogout!==true&&body?.error==='invalid_grant'&&isAmbiguousProtect(creds.session_id,creds.refresh_token,clock())){
      throw new RefreshError('invalid_grant after an ambiguous refresh timeout; credentials were kept',{kind:'timeout',canFallback:stillValid(),ambiguous:true});
    }
    throw new RefreshError('Token refresh was revoked; stored credentials were not reused',{kind:'revoked',canFallback:false,revoked:true});
  }
  if(response.status===429||response.status>=500){
    throw new RefreshError(`Token refresh failed with HTTP ${response.status}; credentials were kept`,{kind:response.status===429?'rate_limited':'failed',canFallback:stillValid()});
  }
  if(body?.error||!response.ok)throw new RefreshError(`Token refresh failed with HTTP ${response.status}; credentials were kept`,{kind:'failed',canFallback:stillValid()});
  if(typeof body?.access_token!=='string'||!body.access_token)throw new RefreshError('Token refresh response had no access_token; credentials were kept',{kind:'malformed',canFallback:stillValid()});
  if(body.refresh_token!==undefined&&(typeof body.refresh_token!=='string'||!body.refresh_token))throw new RefreshError('Token refresh response had an invalid refresh_token; credentials were kept',{kind:'malformed',canFallback:stillValid()});
  const next=credsFromTokens({
    access:body.access_token,
    refresh:typeof body.refresh_token==='string'?body.refresh_token:undefined,
    backend:creds.backend,
    clientId,
    source:'refresh',
    previous:creds,
  });
  if(creds.account_subject){
    const subject=decodeJwtSubject(next.access_token);
    if(!subject||subject!==creds.account_subject)throw new RefreshError('Refreshed access token subject does not match the bound account',{kind:'subject_mismatch',canFallback:stillValid()});
  }
  return next;
}
