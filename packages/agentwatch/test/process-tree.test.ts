import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnArgv,enrollProcessGroup,callerProcessGroup } from '../src/process.ts';
import { openStorage } from '../src/storage.ts';
import { createTaskEngine } from '../src/engine.ts';

const childScript=resolve(import.meta.dir,'process-tree-child.ts');
const linux=process.platform==='linux';
const GRACE_MS=1000;

type Recorded={role:string;pid:number;ppid:number;pgrp:number};

function proc(pid:number) {
  try {
    const text=readFileSync(`/proc/${pid}/stat`,'utf8');
    const fields=text.slice(text.lastIndexOf(')')+2).split(' ');
    return {alive:true as const,ppid:Number(fields[1]),pgrp:Number(fields[2]),sid:Number(fields[3])};
  } catch(error) {
    if((error as {code?:string}).code==='ENOENT')return {alive:false as const};
    throw error;
  }
}

function alive(pid:number) {
  try{process.kill(pid,0);return true;}catch{return false;}
}

function selfPgrp() {
  const info=proc(process.pid);
  if(!info.alive)throw new Error('self process stat missing');
  return info.pgrp;
}

function readRecords(pidfile:string):Recorded[] {
  if(!existsSync(pidfile))return [];
  return readFileSync(pidfile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as Recorded);
}

async function until(label:string,check:()=>boolean|Promise<boolean>,ms=2000) {
  const end=Date.now()+ms;
  while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,20));}
  throw new Error('timed out waiting for '+label);
}

function openLogs(dir:string,id:string) {
  chmodSync(dir,0o700);
  return {stdout:join(dir,id+'.stdout'),stderr:join(dir,id+'.stderr')};
}

function startTree(mode:string,dir:string,pidfile:string,id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
  return spawnArgv([process.execPath,childScript,'root',mode,pidfile],dir,openLogs(dir,id));
}

function reapOwned(pgrp:number,pids:number[],testPgrp:number) {
  if(pgrp===testPgrp||pgrp<=1)throw new Error('refusing to signal a non-owned process group');
  try{process.kill(-pgrp,'SIGKILL');}catch{}
  for(const pid of pids){if(pid>1)try{process.kill(pid,'SIGKILL');}catch{}}
}


test('enrollProcessGroup refuses degenerate, own-group, and oversized pgids',()=>{
  const own=callerProcessGroup();
  expect(enrollProcessGroup(0)).toBeUndefined();
  expect(enrollProcessGroup(1)).toBeUndefined();
  expect(enrollProcessGroup(-5)).toBeUndefined();
  expect(enrollProcessGroup(0x80000000)).toBeUndefined();
  if(own!==undefined)expect(enrollProcessGroup(own,own)).toBeUndefined();
});

const tree=linux?test:test.skip;

tree('spawnArgv cancel SIGTERM stops a cooperative process tree',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-tree-'));const pidfile=join(dir,'pids.jsonl');writeFileSync(pidfile,'');
  const testPgrp=selfPgrp();const child=startTree('term-exit',dir,pidfile);
  const owned:number[]=[child.pid];
  try {
    expect(proc(child.pid).alive).toBe(true);
    expect(proc(child.pid).pgrp).toBe(child.pid);
    expect(proc(child.pid).sid).toBe(child.pid);
    expect(proc(child.pid).pgrp).not.toBe(testPgrp);
    await until('tree recorded',()=>readRecords(pidfile).some(r=>r.role==='grand'));
    const records=readRecords(pidfile);for(const r of records)owned.push(r.pid);
    expect(records.every(r=>r.pgrp===child.pid)).toBe(true);
    const started=Date.now();
    child.cancel();
    await child.exited;
    const elapsed=Date.now()-started;
    expect(elapsed).toBeLessThan(GRACE_MS);
    await until('cooperative tree gone',()=>records.every(r=>!alive(r.pid)));
  } finally {reapOwned(child.pid,owned,testPgrp);rmSync(dir,{recursive:true,force:true});}
});

tree('spawnArgv cancel still force-kills a grandchild after the root has already closed',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-tree-'));const pidfile=join(dir,'pids.jsonl');writeFileSync(pidfile,'');
  const testPgrp=selfPgrp();const child=startTree('root-exit-keep-grand',dir,pidfile);
  const owned:number[]=[child.pid];
  try {
    await child.exited;
    await until('grandchild recorded and live',()=>{
      const grand=readRecords(pidfile).find(r=>r.role==='grand');
      return !!grand&&alive(grand.pid);
    });
    const grand=readRecords(pidfile).find(r=>r.role==='grand')!;
    owned.push(grand.pid);
    expect(alive(child.pid)).toBe(false);
    expect(grand.pgrp).toBe(child.pid);
    expect(alive(grand.pid)).toBe(true);
    child.cancel();
    await until('force-killed grandchild',()=>!alive(grand.pid),GRACE_MS+1500);
    expect(alive(grand.pid)).toBe(false);
  } finally {reapOwned(child.pid,owned,testPgrp);rmSync(dir,{recursive:true,force:true});}
});

tree('spawnArgv cancel does not leak a watch interval when the root closes during grace',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-tree-'));const pidfile=join(dir,'pids.jsonl');writeFileSync(pidfile,'');
  const testPgrp=selfPgrp();const child=startTree('term-exit-keep-grand',dir,pidfile);
  const owned:number[]=[child.pid];
  const realKill=process.kill.bind(process);
  let forced=false,oneDelayedProbe=false;
  try {
    await until('grandchild recorded and live',()=>{
      const grand=readRecords(pidfile).find(r=>r.role==='grand');
      return !!grand&&alive(grand.pid);
    });
    const grand=readRecords(pidfile).find(r=>r.role==='grand')!;
    owned.push(grand.pid);
    expect(alive(child.pid)).toBe(true);
    expect(grand.pgrp).toBe(child.pid);
    process.kill=((pid:number,signal?:NodeJS.Signals|number)=>{
      if(pid===-child.pid&&signal==='SIGKILL'){forced=true;oneDelayedProbe=true;return realKill(pid,signal);}
      // One post-KILL probe stays live so force must replace the close-path watcher.
      if(pid===-child.pid&&signal===0&&oneDelayedProbe){oneDelayedProbe=false;return true;}
      return realKill(pid,signal as Parameters<typeof realKill>[1]);
    }) as typeof process.kill;
    child.cancel();
    await child.exited;
    await until('force-killed grandchild',()=>!alive(grand.pid),GRACE_MS+1500);
    expect(forced).toBe(true);
    expect(alive(grand.pid)).toBe(false);
    expect(child.activeWatches?.()).toBe(0);
  } finally {
    process.kill=realKill;
    child.releaseWatches?.();
    reapOwned(child.pid,owned,testPgrp);
    await child.exited.catch(()=>{});
    rmSync(dir,{recursive:true,force:true});
  }
});

tree('spawnArgv cancel force-kills a tree that ignores SIGTERM after the 1s grace',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-tree-'));const pidfile=join(dir,'pids.jsonl');writeFileSync(pidfile,'');
  const testPgrp=selfPgrp();const child=startTree('ignore-term',dir,pidfile);
  const owned:number[]=[child.pid];
  try {
    await until('tree recorded',()=>readRecords(pidfile).some(r=>r.role==='grand'));
    const records=readRecords(pidfile);for(const r of records)owned.push(r.pid);
    const started=Date.now();
    child.cancel();child.cancel();
    await child.exited;
    const elapsed=Date.now()-started;
    expect(elapsed).toBeGreaterThanOrEqual(GRACE_MS-50);
    await until('forced tree gone',()=>records.every(r=>!alive(r.pid)));
    expect(records.every(r=>!alive(r.pid))).toBe(true);
  } finally {reapOwned(child.pid,owned,testPgrp);rmSync(dir,{recursive:true,force:true});}
});

tree('repeated cancel drops a gone process group even if that id later appears live',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-tree-'));
  const testPgrp=selfPgrp();
  const child=spawnArgv([process.execPath,'-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],dir,openLogs(dir,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
  const owned:number[]=[child.pid];
  const realKill=process.kill.bind(process);
  const events:Array<NodeJS.Signals|number>=[];
  let terms=0,observedGone=false;
  try {
    expect(child.pid).toBeGreaterThan(1);
    expect(child.pid).not.toBe(testPgrp);
    expect(proc(child.pid).pgrp).toBe(child.pid);
    process.kill=((pid:number,signal?:NodeJS.Signals|number)=>{
      if(pid===-child.pid){
        events.push((signal??'SIGTERM') as NodeJS.Signals|number);
        if(!observedGone&&signal==='SIGTERM'&&++terms===2){
          observedGone=true;
          throw Object.assign(new Error('synthetic gone'),{code:'ESRCH'});
        }
        // After ESRCH this number looks live; never forward group signals to a real target.
        return true;
      }
      return realKill(pid,signal as Parameters<typeof realKill>[1]);
    }) as typeof process.kill;
    child.cancel();
    child.cancel();
    child.cancel();
    await new Promise(r=>setTimeout(r,GRACE_MS+150));
    expect(observedGone).toBe(true);
    expect(events).toEqual(['SIGTERM','SIGTERM']);
    expect(alive(child.pid)).toBe(true);
  } finally {
    process.kill=realKill;
    reapOwned(child.pid,owned,testPgrp);
    await child.exited.catch(()=>{});
    rmSync(dir,{recursive:true,force:true});
  }
});

tree('spawnArgv cancel does not chase a grandchild that left the group with setsid',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-tree-'));const pidfile=join(dir,'pids.jsonl');writeFileSync(pidfile,'');
  const testPgrp=selfPgrp();const child=startTree('escape-setsid',dir,pidfile);
  const owned:number[]=[child.pid];
  try {
    expect(proc(child.pid).pgrp).toBe(child.pid);
    await until('escaped grand recorded',()=>{
      const grand=readRecords(pidfile).find(r=>r.role==='grand');
      return !!grand&&grand.pgrp!==child.pid&&alive(grand.pid);
    });
    const records=readRecords(pidfile);for(const r of records)owned.push(r.pid);
    const grand=records.find(r=>r.role==='grand')!;
    expect(records.filter(r=>r.role!=='grand').every(r=>r.pgrp===child.pid)).toBe(true);
    expect(grand.pgrp).not.toBe(child.pid);
    expect(grand.pgrp).not.toBe(testPgrp);
    child.cancel();
    await child.exited;
    await until('in-group members gone',()=>records.filter(r=>r.pgrp===child.pid).every(r=>!alive(r.pid)));
    expect(alive(grand.pid)).toBe(true);
  } finally {reapOwned(child.pid,owned,testPgrp);rmSync(dir,{recursive:true,force:true});}
});

tree('concurrent trees are isolated: cancelling one does not signal the other',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-tree-'));
  const aFile=join(dir,'a.jsonl'),bFile=join(dir,'b.jsonl');writeFileSync(aFile,'');writeFileSync(bFile,'');
  const testPgrp=selfPgrp();
  const a=startTree('ignore-term',dir,aFile,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),b=startTree('ignore-term',dir,bFile,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  const owned=[a.pid,b.pid];
  try {
    await until('A recorded',()=>readRecords(aFile).some(r=>r.role==='grand'));
    await until('B recorded',()=>readRecords(bFile).some(r=>r.role==='grand'));
    const aRec=readRecords(aFile),bRec=readRecords(bFile);
    for(const r of [...aRec,...bRec])owned.push(r.pid);
    expect(a.pid).not.toBe(b.pid);
    expect(aRec.every(r=>r.pgrp===a.pid)).toBe(true);
    expect(bRec.every(r=>r.pgrp===b.pid)).toBe(true);
    a.cancel();
    await a.exited;
    await until('A gone',()=>aRec.every(r=>!alive(r.pid)),GRACE_MS+1500);
    expect(bRec.every(r=>alive(r.pid))).toBe(true);
    b.cancel();
    await b.exited;
    await until('B gone',()=>bRec.every(r=>!alive(r.pid)),GRACE_MS+1500);
  } finally {reapOwned(a.pid,owned.filter(pid=>pid===a.pid||readRecords(aFile).some(r=>r.pid===pid)),testPgrp);reapOwned(b.pid,owned.filter(pid=>pid===b.pid||readRecords(bFile).some(r=>r.pid===pid)),testPgrp);rmSync(dir,{recursive:true,force:true});}
});

tree('cancel after a natural exit does not throw and does not require a live group',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aw-tree-'));const pidfile=join(dir,'pids.jsonl');writeFileSync(pidfile,'');
  const testPgrp=selfPgrp();const child=startTree('natural-exit',dir,pidfile);
  try {
    const code=await child.exited;
    expect(alive(child.pid)).toBe(false);
    expect(()=>child.cancel()).not.toThrow();
    child.cancel();
    expect(selfPgrp()).toBe(testPgrp);
    expect(alive(process.pid)).toBe(true);
    expect(code===0||code===null).toBe(true);
  } finally {reapOwned(child.pid,[child.pid],testPgrp);rmSync(dir,{recursive:true,force:true});}
});

tree('engine wait timeout does not kill a managed process tree; drain does not cancel it; cancel marks cancelled after observed close',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-tree-eng-'));chmodSync(state,0o700);
  const pidfile=join(state,'pids.jsonl');writeFileSync(pidfile,'');
  const testPgrp=selfPgrp();
  const db=await openStorage(state);
  const engine=await createTaskEngine({
    state,store:db.store,verify:async()=>{},
    execute:(_input,files)=>spawnArgv([process.execPath,childScript,'root','ignore-term',pidfile],state,files),
  });
  const owned:number[]=[];
  try {
    const task=await engine.run({request_id:'tree-wait',bot:'test',cwd:state,argv:['claude']});
    await until('running with tree',async()=>{
      const status=await engine.status(task.id);
      return status.state==='running'&&readRecords(pidfile).some(r=>r.role==='grand');
    },4000);
    const records=readRecords(pidfile);for(const r of records)owned.push(r.pid);
    const root=records.find(r=>r.role==='root')!;
    expect(root.pgrp).not.toBe(testPgrp);
    const timed=await engine.wait(task.id,0);
    expect(timed.wait_timed_out).toBe(true);
    expect(timed.task.state).toBe('running');
    expect(records.every(r=>alive(r.pid))).toBe(true);
    // drain waits for the current worker but must not itself cancel a running task.
    const draining=engine.drain();
    await new Promise(r=>setTimeout(r,200));
    expect(await Promise.race([draining.then(()=>'returned'),new Promise(r=>setTimeout(()=>r('pending'),50))])).toBe('pending');
    expect((await engine.status(task.id)).state).toBe('running');
    expect(records.every(r=>alive(r.pid))).toBe(true);
    expect((await engine.cancel(task.id)).state).toBe('cancelling');
    await until('cancelled after observed close',async()=>(await engine.status(task.id)).state==='cancelled',GRACE_MS+3000);
    expect(await draining).toMatchObject({active:0});
    expect(records.every(r=>!alive(r.pid))).toBe(true);
    expect((await db.store.get(task.id)).state).toBe('cancelled');
  } finally {
    await engine.close().catch(()=>{});await db.close();
    const pgrp=owned[0]?proc(owned[0]).alive?proc(owned[0]).pgrp:owned[0]:0;
    if(pgrp&&pgrp!==testPgrp)reapOwned(pgrp,owned,testPgrp);
    rmSync(state,{recursive:true,force:true});
  }
},20000);
