import { mkdtempSync,mkdirSync,existsSync,readFileSync,rmSync } from 'node:fs';
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
  const owned=new Set<number>();
  function receipts():Array<{request_id:string;pid:number}> {
    const file=join(cwd,'fixture-spawns.jsonl');return existsSync(file)?readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
  }
  async function startHost() {
    const p=Bun.spawn([...host,state],{env,cwd:host.length===1?dirname(host[0]!):undefined,stdout:'ignore',stderr:'ignore'});owned.add(p.pid);
    return until(async()=>{
      try{const info=readRegistration(state);if(!info)return undefined;await request(info,'health',{});return info;}catch{return undefined;}
    },(r):r is Registration=>!!r);
  }
  async function call(action:string,args:string[]=[]) {
    const p=Bun.spawn([...cli,action,'--state',state,...args],{env,cwd:cli.length===1?dirname(cli[0]!):undefined,stdin:'ignore',stdout:'pipe',stderr:'pipe'});
    const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
    let value:any;if(out)try{value=JSON.parse(out);}catch{throw new Error('stdout is not one JSON value: '+out.slice(0,100));}
    return {out,err,code,value};
  }
  async function cleanup() {
    try{const info=readRegistration(state);if(info){owned.add(info.pid);await request(info,'shutdown',{});await until(async()=>alive(info.pid),v=>!v,3000);}}catch{}
    for(const receipt of receipts())owned.add(receipt.pid);
    for(const pid of owned) {
      if(!alive(pid))continue;
      const args=readFileSync(`/proc/${pid}/cmdline`,'utf8');
      if(!args.includes(state)&&!args.includes(cwd))throw new Error('Refuse cleanup of unrecognized PID');
      process.kill(pid,'SIGKILL');await until(async()=>alive(pid),v=>!v,3000);
    }
    rmSync(root,{recursive:true,force:true});
  }
  return {root,state,cwd,call,startHost,receipts,cleanup};
}
