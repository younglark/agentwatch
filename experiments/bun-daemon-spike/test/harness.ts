import { expect } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
export const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export function alive(pid:number) {
  try { return !readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1]!.startsWith('Z'); } catch { return false; }
}
export async function until<A>(fn:()=>Promise<A>, pred:(v:A)=>boolean, ms=5000):Promise<A> {
  const end=Date.now()+ms;
  for(;;) {const v=await fn();if(pred(v))return v;if(Date.now()>end)throw new Error('condition timed out: '+JSON.stringify(v));await pause(15);}
}
export function harness(command:string[],env:NodeJS.ProcessEnv=process.env) {
  const state=mkdtempSync(join(tmpdir(),'aw-spike-'));
  async function raw(action:string,input:object={}) {
    const p=Bun.spawn([...command,action,JSON.stringify(input),'--state',state],{env,cwd:command.length===1?dirname(command[0]!):undefined,stdout:'pipe',stderr:'pipe'});
    const [stdout,stderr,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
    return {stdout,stderr,code};
  }
  async function call(action:string,input:object={}) {
    const r=await raw(action,input);expect(r.code,r.stderr).toBe(0);return JSON.parse(r.stdout);
  }
  function receipts(name:string):any[] {
    const file=join(state,name); return existsSync(file)?readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
  }
  async function cleanup() {
    if(receipts('daemon-starts.jsonl').some(r=>alive(r.pid)))await raw('stop');
    const pids=[...receipts('daemon-starts.jsonl'),...receipts('spawns.jsonl')].map(r=>r.pid as number);
    for(const pid of pids) {
      if(!alive(pid))continue;
      await until(async()=>alive(pid),v=>!v,1000).catch(()=>{
        // Verify this exact PID still belongs to our isolated state before killing.
        const argv=readFileSync(`/proc/${pid}/cmdline`,'utf8');
        if(!argv.includes(state))throw new Error('refuse to kill unrecognized PID');
        process.kill(pid,'SIGKILL');
      });
      await until(async()=>alive(pid),v=>!v,2000);
    }
    rmSync(state,{recursive:true,force:true});
  }
  return {state,call,raw,cleanup,receipts};
}
