import { mkdtempSync,mkdirSync,existsSync,appendFileSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,dirname } from 'node:path';
import { readRegistration,request,type Registration } from '../src/service.ts';
import { encryptOscryptV10,LINUX_BASIC_PASSWORD,LINUX_PBKDF2_ITERATIONS } from '../src/auth/oscrypt.ts';
export const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export function alive(pid:number) {try{return !readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1]!.startsWith('Z');}catch{return false;}}
export async function until<A>(fn:()=>Promise<A>,predicate:(a:A)=>boolean,timeout=8000):Promise<A> {
  const end=Date.now()+timeout;for(;;){const value=await fn();if(predicate(value))return value;if(Date.now()>end)throw new Error('Condition timed out');await sleep(20);}
}
export function commandHarness(cli:readonly string[],host:readonly string[],env:NodeJS.ProcessEnv=process.env) {
  const root=mkdtempSync(join(tmpdir(),'aw core-')),state=join(root,'状态 space'),cwd=join(root,'项目 空格');
  mkdirSync(state,{mode:0o700});mkdirSync(cwd,{mode:0o700});
  const home=join(root,'home'),bin=join(root,'bin'),xdg=join(home,'.config'),appdata=join(home,'AppData','Roaming');
  mkdirSync(home);mkdirSync(bin);mkdirSync(xdg,{recursive:true});mkdirSync(appdata,{recursive:true});
  env={...env,HOME:home,PATH:bin,XDG_CONFIG_HOME:xdg,APPDATA:appdata};
  delete env.AGENTWATCH_SECRETS_FILE;delete env.AGENTWATCH_USER_DATA;delete env.AGENTWATCH_API_BASE;delete env.AGENTWATCH_WEBSITE;delete env.AGENTWATCH_AUTH_MODE;delete env.AGENTWATCH_OAUTH_CLIENT_ID;
  const owned=new Set<number>();
  function receipts():Array<{request_id:string;pid:number}> {
    const file=join(cwd,'fixture-spawns.jsonl');return existsSync(file)?readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
  }
  const authDir=join(home,'.agentwatch','auth'),credentials=join(authDir,'credentials.json');
  delete env.AGENTWATCH_CREDENTIALS;delete env.AGENTWATCH_CLIENT_ID;
  type Reply={body?:unknown;status?:number;hang?:boolean;lost?:boolean;oversized?:boolean;headers?:Record<string,string>};
  type Handler=(body:any,count:number)=>Reply;
  let lookup:Handler=()=>({body:{agents:[{agentId:'test-bot'}]}}),send:Handler=()=>({body:{dispatched:true,delivery:'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL',workflowId:'workflow-fixture'}}),status:Handler=()=>({body:{status:'GROK_BOT_SEND_STATUS_NOT_FOUND'}});
  const calls:{method:string;body:any;authorization:string|null;headers:Record<string,string>}[]=[],active=new Set<number>();let sequence=0;
  const oauthCalls:{url:string;body:any}[]=[],pollCalls:string[]=[];
  const backend=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,async fetch(req){
    const url=new URL(req.url);
    if(url.pathname==='/oauth/token'){const body=await req.json();oauthCalls.push({url:url.toString(),body});return Response.json({error:'unexpected_desktop_refresh'},{status:400});}
    if(url.pathname==='/auth/poll'){pollCalls.push(url.toString());return new Response(null,{status:404});}
    const method=url.pathname.split('/').pop()!,body=await req.json();calls.push({method,body,authorization:req.headers.get('authorization'),headers:Object.fromEntries(req.headers)});
    if(req.method!=='POST'||url.pathname!==`/aiserver.v1.GrokBotService/${method}`||req.headers.get('content-type')!=='application/json'||req.headers.get('connect-protocol-version')!=='1')return Response.json({code:'invalid_argument'},{status:400});
    const count=calls.filter(c=>c.method===method).length;
    if(method==='ListGrokBotAgents')appendFileSync(join(root,'lookup-calls'),'query\n');
    if(method==='SendGrokBotUserMessage'){writeFileSync(join(root,'notification-body'),(body as any).text);appendFileSync(join(root,'notification-calls'),JSON.stringify({message_id:(body as any).messageId})+'\n');}
    if(method==='GetGrokBotSendStatus')appendFileSync(join(root,'reconciliation-calls'),(body as any).messageId+'\n');
    const reply=(method==='ListGrokBotAgents'?lookup:method==='SendGrokBotUserMessage'?send:status)(body,count);
    if(reply.hang){const id=++sequence;active.add(id);req.signal.addEventListener('abort',()=>active.delete(id),{once:true});return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(' '));},cancel(){active.delete(id);}}),{headers:{'content-type':'application/json'}});}
    if(reply.lost)return new Response('',{headers:{'content-type':'application/json'}});
    if(reply.oversized)return new Response('x'.repeat(1048577),{headers:{'content-type':'application/json'}});
    return typeof reply.body==='string'?new Response(reply.body,{status:reply.status??200,headers:{'content-type':'application/json'}}):Response.json(reply.body??{}, {status:reply.status??200,headers:reply.headers});
  }});
  const secretsFile=join(xdg,'Grok Bot','sand-secrets.json');
  function desktopToken(overrides:Record<string,unknown>){
    if(typeof overrides.access_token==='string')return overrides.access_token;
    if(typeof overrides.expires_at_ms==='number'){
      const header=Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url');
      const payload=Buffer.from(JSON.stringify({exp:Math.floor(overrides.expires_at_ms/1000)||0})).toString('base64url');
      return `${header}.${payload}.sig`;
    }
    return 'SYNTHETIC_PRIVATE_TOKEN';
  }
  function configureAuth(overrides:Record<string,unknown>={}){
    mkdirSync(dirname(secretsFile),{recursive:true,mode:0o700});
    const access=encryptOscryptV10(desktopToken(overrides),LINUX_BASIC_PASSWORD,LINUX_PBKDF2_ITERATIONS).toString('base64');
    const refresh=encryptOscryptV10('SECRET_DESKTOP_REFRESH',LINUX_BASIC_PASSWORD,LINUX_PBKDF2_ITERATIONS).toString('base64');
    writeFileSync(secretsFile,JSON.stringify({version:1,'cursor-accounts':{active:'acct-1',accounts:{'acct-1':{'cursor-access-token':access,'cursor-refresh-token':refresh}}}}),{mode:0o600});
    env.AGENTWATCH_SECRETS_FILE=secretsFile;
    env.AGENTWATCH_API_BASE=typeof overrides.backend==='string'?overrides.backend:`http://127.0.0.1:${backend.port}`;
    mkdirSync(authDir,{recursive:true,mode:0o700});
  }
  function mockConnect(options:{lookup?:Handler;send?:Handler;status?:Handler}={}){configureAuth();if(options.lookup)lookup=options.lookup;if(options.send)send=options.send;if(options.status)status=options.status;}
  function notificationCalls(){const file=join(root,'notification-calls');return existsSync(file)?readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)) as {message_id:string}[]:[];}
  const activeHttp=()=>active.size;
  function nativeFixture(exitCode=0){const file=join(bin,'claude');writeFileSync(file,`#!/bin/sh\nprintf "SECRET_NATIVE_LOG\\n"\nexit ${exitCode}\n`,{mode:0o700});return file;}
  async function startHost(opts?:{cwd?:string}) {
    const p=Bun.spawn([...host,state],{env,cwd:opts?.cwd??(host.length===1?dirname(host[0]!):undefined),stdout:'ignore',stderr:'ignore'});owned.add(p.pid);
    return until(async()=>{
      try{const info=readRegistration(state);if(!info)return undefined;await request(info,'health',{});return info;}catch{return undefined;}
    },(r):r is Registration=>!!r);
  }
  async function call(action:string,args:string[]=[],opts?:{cwd?:string}) {
    const p=Bun.spawn([...cli,action,'--state',state,...args],{env,cwd:opts?.cwd??(cli.length===1?dirname(cli[0]!):undefined),stdin:'ignore',stdout:'pipe',stderr:'pipe'});
    const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
    let value:any;if(out)try{value=JSON.parse(out);}catch{if(!args.includes('--help'))throw new Error('stdout is not one JSON value: '+out.slice(0,100));}
    return {out,err,code,value};
  }
  async function cleanup() {
    try{const info=readRegistration(state);if(info){owned.add(info.pid);await request(info,'shutdown',{});await until(async()=>alive(info.pid),v=>!v,3000);}}catch{}
    for(const receipt of receipts())owned.add(receipt.pid);
    for(const pid of owned) {
      if(!alive(pid))continue;
      const args=readFileSync(`/proc/${pid}/cmdline`,'utf8');
      if(!args.includes(state)&&!args.includes(cwd)&&!args.includes(root))throw new Error('Refuse cleanup of unrecognized PID');
      process.kill(pid,'SIGKILL');await until(async()=>alive(pid),v=>!v,3000);
    }
    backend.stop(true);rmSync(root,{recursive:true,force:true});
  }
  return {root,state,cwd,home,bin,env,mockConnect,configureAuth,credentials:secretsFile,authDir,calls,oauthCalls,pollCalls,notificationCalls,activeHttp,nativeFixture,call,startHost,receipts,cleanup};
}
