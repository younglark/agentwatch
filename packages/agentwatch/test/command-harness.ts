import { mkdtempSync,mkdirSync,existsSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,dirname } from 'node:path';
import { readRegistration,request,type Registration } from '../src/service.ts';
export const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export function alive(pid:number) {try{return !readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1]!.startsWith('Z');}catch{return false;}}
export async function until<A>(fn:()=>Promise<A>,predicate:(a:A)=>boolean,timeout=8000):Promise<A> {
  const end=Date.now()+timeout;for(;;){const value=await fn();if(predicate(value))return value;if(Date.now()>end)throw new Error('Condition timed out');await sleep(20);}
}
export function commandHarness(cli:readonly string[],host:readonly string[],env:NodeJS.ProcessEnv=process.env) {
  const root=mkdtempSync(join(tmpdir(),'aw core-')),state=join(root,'状态 space'),cwd=join(root,'项目 空格');
  mkdirSync(state,{mode:0o700});mkdirSync(cwd,{mode:0o700});
  const home=join(root,'home'),bin=join(root,'bin');mkdirSync(home);mkdirSync(bin);
  env={...env,HOME:home,PATH:bin};
  const owned=new Set<number>();
  function receipts():Array<{request_id:string;pid:number}> {
    const file=join(cwd,'fixture-spawns.jsonl');return existsSync(file)?readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
  }
  // POSIX stand-ins use only shell builtins; compiled tests expose no toolchain on PATH.
  const quote=(s:string)=>"'"+s.replaceAll("'", "'\\''")+"'";
  function mockGbc(code:number,envelope:unknown,extra='') {
    const json=typeof envelope==='string'?envelope:JSON.stringify(envelope);
    writeFileSync(join(bin,'gbc'),`#!/bin/sh
[ "$#" -eq 4 ] && [ "$1" = --json ] && [ "$2" = bot ] && [ "$3" = get ] && [ "$4" = --agent-id=test-bot ] || exit 2
[ -d "$HOME" ] && [ "$PATH" = ${quote(bin)} ] || exit 2
printf '%s\\n' query >> ${quote(join(root,'gbc-calls'))}
${extra}
printf '%s\\n' ${quote(json)} ${code===0?'':'>&2'}
exit ${code}
`,{mode:0o700});
  }
  const ok=(data:unknown)=>({schema_version:'1.0.0',ok:true,outcome:'known_success',code:'ok',retryable:false,request_id:'fixture',data});
  function mockNotifications(options:{code?:number;envelope?:unknown;extra?:string;status?:unknown;statusCode?:number;statusExtra?:string}={}) {
    const send=options.envelope??ok({agent_id:'test-bot',message_id:'__MESSAGE_ID__',session_id:null,session_source:'default_unreported',dispatched:true,delivery:'accepted_temporal',delivery_code:2,mode:'temporal',mode_code:1,workflow_id:'workflow-fixture',refusal:null});
    const status=options.status??ok({agent_id:'test-bot',message_id:'__MESSAGE_ID__',session_id:null,session_source:'default_unreported',status:'not_found',status_code:1,echo_entry_id:null,rejection_code:null,accepted_at_ms:null});
    const expression=(value:unknown)=>(typeof value==='string'?value:JSON.stringify(value)).split('__MESSAGE_ID__').map(quote).join('"$message"');
    writeFileSync(join(bin,'gbc'),`#!/bin/sh
[ "$PATH" = ${quote(bin)} ] && [ "${'$'}{GBT_MOCK+x}" != x ] || exit 2
if [ "$#" -eq 4 ] && [ "$1" = --json ] && [ "$2" = bot ] && [ "$3" = get ] && [ "$4" = --agent-id=test-bot ]; then
printf '%s\\n' ${quote(JSON.stringify(ok({bot:{agent_id:'test-bot'}})))}
exit 0
fi
if [ "$#" -eq 7 ] && [ "$1" = --json ] && [ "$2" = --allow-writes ] && [ "$3" = message ] && [ "$4" = send ] && [ "$5" = --agent-id=test-bot ] && [ "$7" = --text-stdin ]; then
message=${'$'}{6#--message-id=}
IFS= read -r body
printf '%s\\n' "$body" > ${quote(join(root,'notification-body'))}
printf '{"pid":%s,"message_id":"%s"}\\n' "$$" "$message" >> ${quote(join(root,'notification-calls'))}
${options.extra??''}
printf '%s\\n' ${expression(send)} ${(options.code??0)===0?'':'>&2'}
exit ${options.code??0}
fi
if [ "$#" -eq 5 ] && [ "$1" = --json ] && [ "$2" = message ] && [ "$3" = status ] && [ "$4" = --agent-id=test-bot ]; then
message=${'$'}{5#--message-id=}
printf '%s\\n' "$message" >> ${quote(join(root,'reconciliation-calls'))}
printf '%s\\n' "$$" >> ${quote(join(root,'reconciliation-pids'))}
${options.statusExtra??''}
printf '%s\\n' ${expression(status)} ${(options.statusCode??0)===0?'':'>&2'}
exit ${options.statusCode??0}
fi
exit 2
`,{mode:0o700});
  }
  function notificationCalls():Array<{pid:number;message_id:string}> {
    const file=join(root,'notification-calls');return existsSync(file)?readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
  }
  function reconciliationPids():number[]{const file=join(root,'reconciliation-pids');return existsSync(file)?readFileSync(file,'utf8').trim().split('\n').map(Number):[];}
  function nativeFixture(exitCode=0){const file=join(bin,'claude');writeFileSync(file,`#!/bin/sh\nprintf "SECRET_NATIVE_LOG\\n"\nexit ${exitCode}\n`,{mode:0o700});return file;}
  async function startHost() {
    const p=Bun.spawn([...host,state],{env,cwd:host.length===1?dirname(host[0]!):undefined,stdout:'ignore',stderr:'ignore'});owned.add(p.pid);
    return until(async()=>{
      try{const info=readRegistration(state);if(!info)return undefined;await request(info,'health',{});return info;}catch{return undefined;}
    },(r):r is Registration=>!!r);
  }
  async function call(action:string,args:string[]=[]) {
    const p=Bun.spawn([...cli,action,'--state',state,...args],{env,cwd:cli.length===1?dirname(cli[0]!):undefined,stdin:'ignore',stdout:'pipe',stderr:'pipe'});
    const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
    let value:any;if(out)try{value=JSON.parse(out);}catch{if(!args.includes('--help'))throw new Error('stdout is not one JSON value: '+out.slice(0,100));}
    return {out,err,code,value};
  }
  async function cleanup() {
    try{const info=readRegistration(state);if(info){owned.add(info.pid);await request(info,'shutdown',{});await until(async()=>alive(info.pid),v=>!v,3000);}}catch{}
    for(const receipt of [...receipts(),...notificationCalls()])owned.add(receipt.pid);
    for(const pid of reconciliationPids())owned.add(pid);
    for(const pid of owned) {
      if(!alive(pid))continue;
      const args=readFileSync(`/proc/${pid}/cmdline`,'utf8');
      if(!args.includes(state)&&!args.includes(cwd)&&!args.includes(join(bin,'gbc')))throw new Error('Refuse cleanup of unrecognized PID');
      process.kill(pid,'SIGKILL');await until(async()=>alive(pid),v=>!v,3000);
    }
    rmSync(root,{recursive:true,force:true});
  }
  return {root,state,cwd,home,bin,env,mockGbc,mockNotifications,notificationCalls,reconciliationPids,nativeFixture,call,startHost,receipts,cleanup};
}
