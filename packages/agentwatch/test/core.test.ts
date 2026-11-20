import { test, expect, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readlinkSync, closeSync, symlinkSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage.ts';

test('migrated storage deduplicates exact requests, rejects changed argv, commits terminal and outbox together',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-core-'));
  const db=await openStorage(state);
  try {
    const input={request_id:'request-1',bot:'bot-1',cwd:state,argv:['claude','-p','你好 空格','']};
    const first=await db.store.submit(input),again=await db.store.submit(input);
    expect(again.id).toBe(first.id);
    await expect(db.store.submit({...input,argv:['claude','changed']})).rejects.toMatchObject({code:'CONFLICT'});
    await db.store.finish(first.id,'succeeded',0);
    expect((await db.store.get(first.id)).state).toBe('succeeded');
    expect(await db.store.outbox()).toMatchObject([{task_id:first.id,terminal:'succeeded',delivered:0}]);
  } finally {await db.close();rmSync(state,{recursive:true,force:true});}
});

import { createTaskEngine } from '../src/engine.ts';
import { fixtureExecutor } from './fixtures.ts';
test('core executes fixture once, preserves argv, and wait timeout never cancels',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-core-'));const db=await openStorage(state);
  const engine=await createTaskEngine({store:db.store,state,verify:async()=>{},execute:fixtureExecutor});
  try {
    const input={request_id:'execution-1',bot:'test-bot',cwd:state,argv:['claude','space arg','你好','', '--resume','session']};
    const task=await engine.run(input);expect((await engine.run(input)).id).toBe(task.id);
    const early=await engine.wait(task.id,0);expect(early.wait_timed_out).toBe(true);
    const done=await engine.wait(task.id,5000);expect(done.task.state).toBe('succeeded');
    expect((await engine.status(task.id)).notification).toMatchObject({state:'pending',transport:'not_configured'});
    const log=await engine.logs(task.id,'stdout',0,4096);expect(JSON.parse(log.text).argv).toEqual(input.argv);
  } finally {await engine.close();await db.close();rmSync(state,{recursive:true,force:true});}
});

function gate() {
  let arrive!:()=>void,release!:()=>void;
  const reached=new Promise<void>(r=>arrive=r),blocked=new Promise<void>(r=>release=r);
  return {reached,release,hold:async()=>{arrive();await blocked;}};
}
for(const phase of ['beforeClaim','beforeLaunch'] as const) {
  test(`cancel at deterministic ${phase} barrier prevents any process launch`,async()=>{
    const state=mkdtempSync(join(tmpdir(),'aw-core-')),db=await openStorage(state),barrier=gate();let launches=0;
    const engine=await createTaskEngine({state,store:db.store,verify:async()=>{},execute:(...args)=>{launches++;return fixtureExecutor(...args);},hooks:{[phase]:barrier.hold}});
    try {
      const task=await engine.run({request_id:'cancel-'+phase,bot:'test',cwd:state,argv:['claude']});
      await barrier.reached;
      expect((await engine.cancel(task.id))).toMatchObject({state:'cancelled',pid:null});
      barrier.release();expect((await engine.drain()).active).toBe(0);expect(launches).toBe(0);
      expect((await engine.status(task.id)).state).toBe('cancelled');
    }finally{barrier.release();await engine.close();await db.close();rmSync(state,{recursive:true,force:true});}
  });
}
test('recover lost supervision as unknown without replay; drain ignores historical unknown',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-core-')),db=await openStorage(state);let launches=0;
  const input={request_id:'lost',bot:'test',cwd:state,argv:['codex','exec','read only']};
  const task=await db.store.submit(input);await db.store.transition(task.id,['queued'],'starting');
  const engine=await createTaskEngine({state,store:db.store,verify:async()=>{},execute:(...args)=>{launches++;return fixtureExecutor(...args);}});
  try {
    expect((await engine.wait(task.id,0)).task.state).toBe('unknown');
    expect((await engine.run(input)).id).toBe(task.id);expect(launches).toBe(0);
    expect(await engine.drain()).toEqual({active:0,unknown:[task.id]});
    await expect(engine.run({...input,request_id:'new-after-drain'})).rejects.toMatchObject({code:'DRAINING'});
    expect((await db.store.outbox())[0]!.terminal).toBe('unknown');
  }finally{await engine.close();await db.close();rmSync(state,{recursive:true,force:true});}
});
test('authorization is checked again before launch; revocation never starts a child',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-core-')),db=await openStorage(state);let verified=0,launched=0;
  const {CoreError}=await import('../src/domain.ts');
  const engine=await createTaskEngine({state,store:db.store,verify:async()=>{if(++verified>1)throw new CoreError('BOT_FORBIDDEN','Revoked');},execute:(...args)=>{launched++;return fixtureExecutor(...args);}});
  try {
    const task=await engine.run({request_id:'revalidate',bot:'test',cwd:state,argv:['grok','-p','hi']});
    expect((await engine.wait(task.id,5000)).task).toMatchObject({state:'failed',error_code:'BOT_FORBIDDEN',pid:null});expect(launched).toBe(0);
  }finally{await engine.close();await db.close();rmSync(state,{recursive:true,force:true});}
});
test('log reads enforce byte offsets/default and maximum bounds',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-core-')),db=await openStorage(state);
  const engine=await createTaskEngine({state,store:db.store,verify:async()=>{},execute:fixtureExecutor});
  try {
    const task=await engine.run({request_id:'bounded-log',bot:'test',cwd:state,argv:['opencode','flood']});
    expect((await engine.wait(task.id,5000)).task.state).toBe('succeeded');
    const a=await engine.logs(task.id);expect(Buffer.from(a.data_base64,'base64').byteLength).toBe(4096);expect(a.bytes).toBe(4096);expect(a.truncated).toBe(true);
    const b=await engine.logs(task.id,'stdout',a.next_offset,123);expect(b.bytes).toBe(123);expect(b.next_offset).toBe(4219);
    await expect(engine.logs(task.id,'stdout',0,65537)).rejects.toMatchObject({code:'USAGE'});
    await expect(engine.logs(task.id,'stdout',999999,10)).rejects.toMatchObject({code:'USAGE'});
  }finally{await engine.close();await db.close();rmSync(state,{recursive:true,force:true});}
});

import { Database } from 'bun:sqlite';
test('outbox insertion failure rolls back terminal state',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-core-')),db=await openStorage(state);
  const fault=new Database(join(state,'tasks.sqlite'));
  try {
    const task=await db.store.submit({request_id:'atomic-failure',bot:'test',cwd:state,argv:['claude']});
    fault.run("CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(FAIL,'injected failure'); END");
    await expect(db.store.finish(task.id,'succeeded',0)).rejects.toBeDefined();
    expect((await db.store.get(task.id)).state).toBe('queued');expect(await db.store.outbox()).toHaveLength(0);
  }finally{fault.close();await db.close();rmSync(state,{recursive:true,force:true});}
});
test('future migration versions fail closed rather than rewriting schema',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-core-')),db=await openStorage(state);await db.close();
  const raw=new Database(join(state,'tasks.sqlite'));raw.run('UPDATE migrations SET version=999');raw.close();
  try{await expect(openStorage(state)).rejects.toMatchObject({code:'VERSION_MISMATCH'});}finally{rmSync(state,{recursive:true,force:true});}
});

import { nativeExecutor } from '../src/process.ts';
test('spawn ENOENT is failed with no PID, not an ambiguous running task',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-core-')),db=await openStorage(state);
  const engine=await createTaskEngine({state,store:db.store,verify:async()=>{},execute:nativeExecutor});
  try {
    const task=await engine.run({request_id:'missing-exe',bot:'test',cwd:state,argv:[join(state,'missing','claude')]});
    expect((await engine.wait(task.id,3000)).task).toMatchObject({state:'failed',pid:null,error_code:'SPAWN_FAILED',exit_code:null});
  }finally{await engine.close();await db.close();rmSync(state,{recursive:true,force:true});}
});

// Store adapter barrier holds the actual admission-to-commit window, not a sleep.
test('drain settles admitted submit commit and leaves no queued task to launch after restart',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-admission-')),db=await openStorage(state),barrier=gate();
  const input={request_id:'admitted-before-drain',bot:'test',cwd:state,argv:['claude']};
  const engine=await createTaskEngine({state,store:{...db.store,submit:async value=>{await barrier.hold();return db.store.submit(value);}},verify:async()=>{},execute:fixtureExecutor});
  let restarted:Awaited<ReturnType<typeof createTaskEngine>>|undefined;let lateLaunches=0;
  try {
    const submission=engine.run(input);await barrier.reached;
    const stopping=engine.drain();barrier.release();const task=await submission;await stopping;
    restarted=await createTaskEngine({state,store:db.store,verify:async()=>{},execute:(value,files)=>{if(value.request_id===input.request_id)lateLaunches++;return fixtureExecutor(value,files);}});
    const marker=await restarted.run({...input,request_id:'restart-marker'});
    expect((await restarted.wait(marker.id,5000)).task.state).toBe('succeeded');
    expect(lateLaunches).toBe(0);
    expect((await db.store.get(task.id)).state).toBe('cancelled');
    expect((await db.store.outbox()).find(row=>row.task_id===task.id)?.terminal).toBe('cancelled');
    console.log('ADMISSION_DRAIN_NO_LATE_LAUNCH');
  }finally{barrier.release();await restarted?.close();await engine.close();await db.close();rmSync(state,{recursive:true,force:true});}
});

test('log buffer allocation failure does not leave an opened descriptor',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-alloc-')),db=await openStorage(state);
  const engine=await createTaskEngine({state,store:db.store,verify:async()=>{},execute:fixtureExecutor});
  await engine.drain();
  const task=await db.store.submit({request_id:'alloc-failure',bot:'test',cwd:state,argv:['claude']});
  const file=join(state,task.id+'.stdout');writeFileSync(file,'x'.repeat(60000),{mode:0o600});
  const descriptors=()=>readdirSync('/proc/self/fd').filter(fd=>{try{return readlinkSync('/proc/self/fd/'+fd)===file;}catch{return false;}}).map(Number);
  const before=descriptors(),allocate=Buffer.alloc;
  const injected=new Error('injected bounded allocation failure');
  const allocation=spyOn(Buffer,'alloc').mockImplementation(((size:number,...rest:any[])=>{if(size===54321)throw injected;return (allocate as any)(size,...rest);}) as any);
  try {
    await expect(engine.logs(task.id,'stdout',0,54321)).rejects.toBe(injected);
    expect(descriptors()).toEqual(before);
  }finally{allocation.mockRestore();for(const fd of descriptors())if(!before.includes(fd))closeSync(fd);await engine.close();await db.close();rmSync(state,{recursive:true,force:true});}
});

test('logs reject symlink/nonregular files and traversal IDs from a tampered ledger',async()=>{
  const root=mkdtempSync(join(tmpdir(),'aw-safe-read-')),state=join(root,'state');mkdirSync(state,{mode:0o700});
  const db=await openStorage(state),engine=await createTaskEngine({state,store:db.store,verify:async()=>{},execute:fixtureExecutor});
  await engine.drain();const raw=new Database(join(state,'tasks.sqlite'));
  try {
    const task=await db.store.submit({request_id:'unsafe-log',bot:'test',cwd:state,argv:['claude']});
    const sentinel=join(root,'outside.stdout');writeFileSync(sentinel,'OWNED_SENTINEL_NOT_A_LOG',{mode:0o600});
    const file=join(state,task.id+'.stdout');symlinkSync(sentinel,file);
    await expect(engine.logs(task.id)).rejects.toMatchObject({code:'IPC_AUTH'});
    unlinkSync(file);mkdirSync(file);
    await expect(engine.logs(task.id)).rejects.toMatchObject({code:'IPC_AUTH'});
    raw.query('UPDATE tasks SET id=? WHERE id=?').run('../outside',task.id);
    await expect(engine.logs('../outside')).rejects.toMatchObject({code:'IPC_AUTH'});
  }finally{raw.close();await engine.close();await db.close();rmSync(root,{recursive:true,force:true});}
});

test('spawn log writers reject stdout and stderr symlinks without touching owned sentinel',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-safe-write-'));
  const {randomUUID}=await import('node:crypto');const {readFileSync}=await import('node:fs');
  try {
    for(const stream of ['stdout','stderr']) {
      const id=randomUUID(),sentinel=join(state,'sentinel-'+stream);writeFileSync(sentinel,'UNCHANGED',{mode:0o600});
      const files={stdout:join(state,id+'.stdout'),stderr:join(state,id+'.stderr')};symlinkSync(sentinel,files[stream as 'stdout'|'stderr']);
      let child:ReturnType<typeof fixtureExecutor>|undefined,error:any;
      try{child=fixtureExecutor({request_id:'unsafe-write-'+stream,bot:'test',cwd:state,argv:['claude']},files);}catch(e){error=e;}
      if(child)await child.exited;
      expect(error).toMatchObject({code:'IPC_AUTH'});expect(readFileSync(sentinel,'utf8')).toBe('UNCHANGED');
    }
  }finally{rmSync(state,{recursive:true,force:true});}
});


async function restoreThenDispose(restore:()=>void,engine:Awaited<ReturnType<typeof createTaskEngine>>,db:Awaited<ReturnType<typeof openStorage>>,root:string) {
  try {restore();}
  finally {await engine.close();await db.close();rmSync(root,{recursive:true,force:true});}
}
import * as fs from 'node:fs';
test('log directory replacement at open cannot redirect a pinned log read',async()=>{
  const root=mkdtempSync(join(tmpdir(),'aw-log-race-')),state=join(root,'state'),pinned=join(root,'pinned'),outside=join(root,'outside');
  mkdirSync(state,{mode:0o700});mkdirSync(outside,{mode:0o700});
  const db=await openStorage(state),engine=await createTaskEngine({state,store:db.store,verify:async()=>{},execute:fixtureExecutor});await engine.drain();
  const task=await db.store.submit({request_id:'directory-swap',bot:'test',cwd:state,argv:['claude']});
  writeFileSync(join(state,task.id+'.stdout'),'OWNED_LOG',{mode:0o600});writeFileSync(join(outside,task.id+'.stdout'),'OUTSIDE_SENTINEL',{mode:0o600});
  let swapped=false;const open=fs.openSync;
  const fault=spyOn(fs,'openSync').mockImplementation(((path:any,...args:any[])=>{
    if(!swapped&&String(path).endsWith('/'+task.id+'.stdout')){fs.renameSync(state,pinned);symlinkSync(outside,state);swapped=true;}
    return (open as any)(path,...args);
  }) as any);
  try{expect((await engine.logs(task.id)).text).toBe('OWNED_LOG');expect(swapped).toBe(true);}
  finally{fault.mockRestore();await restoreThenDispose(()=>{if(swapped){unlinkSync(state);fs.renameSync(pinned,state);}},engine,db,root);}
});

test('drain rejects a verifier-pending submission before admission without a ledger row',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-pre-admit-')),db=await openStorage(state),barrier=gate();
  const input={request_id:'not-yet-admitted',bot:'test',cwd:state,argv:['claude']};let launches=0;
  const engine=await createTaskEngine({state,store:db.store,verify:barrier.hold,execute:(...args)=>{launches++;return fixtureExecutor(...args);}});
  try {
    const submission=engine.run(input);await barrier.reached;
    const outcome=submission.then(task=>({task,error:undefined}),error=>({task:undefined,error}));
    const stopping=engine.drain();barrier.release();
    expect((await outcome).error).toMatchObject({code:'DRAINING'});await stopping;
    expect(await db.store.lookup(input)).toBeUndefined();expect(launches).toBe(0);
  }finally{barrier.release();await engine.close();await db.close();rmSync(state,{recursive:true,force:true});}
});

test('inode validation maps IPC_AUTH, does not leak, and swallows a later closeSync throw',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-close-fail-')),db=await openStorage(state);
  const engine=await createTaskEngine({state,store:db.store,verify:async()=>{},execute:fixtureExecutor});
  await engine.drain();
  const task=await db.store.submit({request_id:'close-throws',bot:'test',cwd:state,argv:['claude']});
  const file=join(state,task.id+'.stdout');writeFileSync(file,'OWNED_LOG',{mode:0o644});
  const descriptors=()=>readdirSync('/proc/self/fd').filter(fd=>{try{return readlinkSync('/proc/self/fd/'+fd)===file;}catch{return false;}}).map(Number);
  const before=descriptors(),realClose=fs.closeSync,injected=new Error('injected close failure');
  let attempts=0;
  const closing=spyOn(fs,'closeSync').mockImplementation(((fd:number)=>{
    let target='';try{target=readlinkSync('/proc/self/fd/'+fd);}catch{return realClose(fd);}
    if(target===file){attempts++;realClose(fd);throw injected;}
    return realClose(fd);
  }) as any);
  try {
    await expect(engine.logs(task.id)).rejects.toMatchObject({code:'IPC_AUTH'});
    expect(attempts).toBeGreaterThan(0);
    expect(descriptors()).toEqual(before);
  }finally{closing.mockRestore();for(const fd of descriptors())if(!before.includes(fd))closeSync(fd);await engine.close();await db.close();rmSync(state,{recursive:true,force:true});}
});

test('directory-swap cleanup still disposes engine, store and temp dir if path restore throws',async()=>{
  const root=mkdtempSync(join(tmpdir(),'aw-cleanup-skip-')),state=join(root,'state');mkdirSync(state,{mode:0o700});
  const db=await openStorage(state),engine=await createTaskEngine({state,store:db.store,verify:async()=>{},execute:fixtureExecutor});
  try {
    await expect(restoreThenDispose(()=>{throw new Error('injected path restore failure');},engine,db,root)).rejects.toThrow('injected path restore failure');
    expect(existsSync(root)).toBe(false);
  }catch(error){
    await engine.close().catch(()=>{});await db.close().catch(()=>{});rmSync(root,{recursive:true,force:true});
    throw error;
  }
});
