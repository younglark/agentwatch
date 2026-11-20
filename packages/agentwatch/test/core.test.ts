import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
