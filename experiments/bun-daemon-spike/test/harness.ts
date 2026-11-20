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
  const ownedPids=()=>[...new Set([
    ...receipts('daemon-starts.jsonl'),...receipts('launches.jsonl'),...receipts('spawns.jsonl')
  ].map(r=>r.pid as number))];
  // Acceptance path: this must fail BEFORE finally/cleanup is allowed to rescue it.
  async function strictStop() {
    const before=receipts('daemon-starts.jsonl');
    const activeBefore=ownedPids().filter(alive);
    const response=await call('stop');
    expect(response.stopping).toBe(true);
    expect(before.some(r=>r.pid===response.pid&&activeBefore.includes(r.pid))).toBe(true);
    await until(async()=>ownedPids().filter(alive),pids=>pids.length===0,3000);
    expect(receipts('daemon-starts.jsonl')).toEqual(before);
    expect(ownedPids().filter(alive)).toEqual([]);
    return response;
  }
  async function cleanup() {
    const report={stopExit:null as number|null,forcedPids:[] as number[]};
    if(receipts('daemon-starts.jsonl').some(r=>alive(r.pid)))report.stopExit=(await raw('stop')).code;
    for(const pid of ownedPids()) {
      if(!alive(pid))continue;
      await until(async()=>alive(pid),v=>!v,1000).catch(()=>{
        // Safety only, never accepted as evidence that stop worked.
        const argv=readFileSync(`/proc/${pid}/cmdline`,'utf8');
        if(!argv.includes(state))throw new Error('refuse to kill unrecognized PID');
        process.kill(pid,'SIGKILL');report.forcedPids.push(pid);
      });
      await until(async()=>alive(pid),v=>!v,2000);
    }
    if(report.forcedPids.length)console.error('SAFETY_CLEANUP_NOT_STOP_SUCCESS '+JSON.stringify(report));
    rmSync(state,{recursive:true,force:true});
    return report;
  }
  return {state,call,raw,cleanup,strictStop,receipts};
}
