import {CoreError} from '../domain.ts';
export const DEFAULT_WEBSITE='https://cursor.com';
export const DEFAULT_API_BASE='https://api2.cursor.sh';
export function stripSlash(s:string){return s.replace(/\/+$/,'');}
export function resolveWebsite(env:NodeJS.ProcessEnv=process.env){return stripSlash(env.AGENTWATCH_WEBSITE?.trim()||DEFAULT_WEBSITE);}
export function resolveApiBase(env:NodeJS.ProcessEnv=process.env){return stripSlash(env.AGENTWATCH_API_BASE?.trim()||DEFAULT_API_BASE);}
export function originUrl(raw:string,label:string){
  let url:URL;
  try{url=new URL(raw);}catch{throw new CoreError('AUTH_NOT_CONFIGURED',`Invalid ${label}`);}
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname))))throw new CoreError('AUTH_NOT_CONFIGURED',`Untrusted ${label}`);
  return url.origin;
}
