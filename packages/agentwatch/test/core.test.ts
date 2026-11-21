import { test, expect, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, readlinkSync, closeSync, symlinkSync, mkdirSync, unlinkSync, existsSync,chmodSync,realpathSync } from 'node:fs';
import { tmpdir,hostname } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage.ts';

test('initial storage deduplicates exact requests, rejects changed argv, commits terminal and outbox together',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-core-'));
  const db=await openStorage(state);
  try {
    const input={request_id:'request-1',bot:'bot-1',cwd:state,argv:['claude','-p','你好 空格','']};
    const first=await db.store.submit(input),again=await db.store.submit(input);
    expect(again.id).toBe(first.id);
    await expect(db.store.submit({...input,argv:['claude','changed']})).rejects.toMatchObject({code:'CONFLICT'});
    await db.store.finish(first.id,'succeeded',0);
    expect((await db.store.get(first.id)).state).toBe('succeeded');
    expect(await db.store.outbox()).toMatchObject([{task_id:first.id,terminal:'succeeded',state:'pending'}]);
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
test('future schema versions fail closed rather than rewriting schema',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-schema-future-')),db=await openStorage(state);await db.close();
  const file=join(state,'tasks.sqlite'),raw=new Database(file);raw.exec('PRAGMA ignore_check_constraints=ON; UPDATE schema_info SET version=999');raw.close();
  const before=readFileSync(file);
  try{
    await expect(openStorage(state)).rejects.toMatchObject({code:'VERSION_MISMATCH'});
    expect(readFileSync(file)).toEqual(before);
  }finally{rmSync(state,{recursive:true,force:true});}
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

import { legacyInitial,seedLegacyDatabase } from './schema-fixtures.ts';
for(const version of [1,2] as const)test(`old development schema ${version} is rejected without changing task/outbox bytes`,async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-schema-old-'));
  const {file,records}=seedLegacyDatabase(state,version);
  const before=readFileSync(file);
  try{
    // Close a wrongly accepted DB as well, so red cannot leave an open runtime.
    await expect(openStorage(state).then(async db=>{await db.close();})).rejects.toMatchObject({code:'VERSION_MISMATCH'});
    expect(readFileSync(file)).toEqual(before);
    const check=new Database(file,{readonly:true});
    try{
      expect(check.query('SELECT * FROM tasks ORDER BY id').all()).toEqual(records.tasks);
      expect(check.query('SELECT * FROM outbox ORDER BY event_id').all()).toEqual(records.outbox);
    }finally{check.close();}
  }finally{rmSync(state,{recursive:true,force:true});}
});

// The engine seam is where deterministic local pre-dispatch failures are injected.
// HTTP errors, including a server's rpc_dispatched:false, never produce this result.
for(const retryable of [false,true])test(`notification locally proven not dispatched retryable=${retryable} preserves fixed budget`,async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-notice-budget-')),db=await openStorage(state),attempts:{id:string;at:number;body:string}[]=[];
  const engine=await createTaskEngine({state,store:db.store,verify:async()=>{},execute:fixtureExecutor,notifications:{available:()=>true,send:async(input)=>{
    const claimed=await db.store.notification((await db.store.outbox())[0]!.task_id);expect(claimed?.state).toBe('inflight');expect(claimed?.attempts).toBe(attempts.length+1);
    attempts.push({id:input.message_id,at:Date.now(),body:input.body});return retryable?{state:'pending',code:'RETRY_NOT_DISPATCHED'}:{state:'not_dispatched',code:'NOT_DISPATCHED'};
  }}});
  try{
    const task=await engine.run({request_id:'budget-'+retryable,bot:'test-bot',cwd:state,argv:['claude']});await engine.wait(task.id,5000);
    const end=Date.now()+2500;let result=await engine.status(task.id);
    while(result.notification.state!=='not_dispatched'&&Date.now()<end){await new Promise(r=>setTimeout(r,25));result=await engine.status(task.id);}
    expect(result.state).toBe('succeeded');expect(result.notification).toMatchObject({state:'not_dispatched',attempts:retryable?3:1,durability:'unverified'});expect(attempts).toHaveLength(retryable?3:1);expect(new Set(attempts.map(a=>a.id)).size).toBe(1);
    for(const attempt of attempts){expect(()=>JSON.parse(attempt.body)).toThrow();expect(attempt.body).not.toContain('SECRET_');expect(attempt.body).not.toMatch(/^- (argv|cwd|request_id)/m);}
    if(retryable){expect(attempts[1]!.at-attempts[0]!.at).toBeGreaterThanOrEqual(250);expect(attempts[2]!.at-attempts[1]!.at).toBeGreaterThanOrEqual(500);}
  }finally{await engine.close();await db.close();rmSync(state,{recursive:true,force:true});}
});


import { createNotifier,inlineCode,notificationText,quoteState } from '../src/notifications.ts';
const noticeTitles={succeeded:'任务已成功',failed:'任务失败',cancelled:'任务已取消',unknown:'任务状态未知'} as const;
function fenceFor(text:string){
  let longest=2,run=0;
  for(const ch of text){if(ch==='`'){run++;if(run>longest)longest=run;}else run=0;}
  return '`'.repeat(longest+1);
}
function wrapFence(text:string){
  const fence=fenceFor(text);
  return `${fence}\n${text.endsWith('\n')?text:text+'\n'}${fence}`;
}
function expectedStream(name:'stdout'|'stderr',data:Buffer,task_id:string,state:string,host:string){
  const lines=[`## ${name}`,''];
  if(data.length===0){lines.push('（无输出）');return lines.join('\n');}
  if(data.length<=4096){lines.push(wrapFence(data.toString('utf8')));return lines.join('\n');}
  const head=data.subarray(0,2048).toString('utf8'),tail=data.subarray(data.length-2048).toString('utf8');
  const platform=process.platform,shell=platform==='win32'?'PowerShell':'POSIX shell';
  lines.push(wrapFence(head),'',`（已省略 ${data.length-4096} 字节）`,'',wrapFence(tail),'');
  lines.push(`完整输出请在任务运行主机 ${inlineCode(host)} 上查询（换机器后下面的路径和 --state 都不可用）。`,'');
  lines.push(`- 文件：${inlineCode(join(state,task_id+'.'+name))}`);
  lines.push(`- 命令（${shell}）：${inlineCode(`agentwatch logs ${task_id} --stream ${name} --offset 0 --limit 65536 --state ${quoteState(state,platform)}`)}`);
  lines.push('','若返回的 data.truncated 为 true，把 --offset 改成这次的 data.next_offset，直到 truncated 为 false。');
  return lines.join('\n');
}

function expectedNotice(state:keyof typeof noticeTitles,task_id:string,exit_code:number|null,error_code:string|null=null,outputs:{stdout?:Buffer;stderr?:Buffer;state:string}|{state:string;stdout?:Buffer;stderr?:Buffer}={state:''}){
  const lines=[noticeTitles[state],'',`- 任务：\`${task_id}\``,`- 事件：\`${task_id}:terminal:1\``,`- 退出码：${exit_code}`];
  if(error_code)lines.push(`- 错误：${error_code}`);
  const dir=outputs.state;
  const host=hostname();
  return [lines.join('\n'),expectedStream('stdout',outputs.stdout??Buffer.alloc(0),task_id,dir,host),expectedStream('stderr',outputs.stderr??Buffer.alloc(0),task_id,dir,host)].join('\n\n');
}
function expectBoundedMarkdown(body:string,expected:string){
  expect(body).toBe(expected);expect(()=>JSON.parse(body)).toThrow();
  expect(body).not.toContain('SECRET_ARGV');expect(body).not.toMatch(/^- (argv|cwd|request_id)/m);
}
async function captureNotice(terminal:keyof typeof noticeTitles,exit_code:number|null,error_code:string|null,logs?:{stdout?:Buffer|string;stderr?:Buffer|string}){
  const state=mkdtempSync(join(tmpdir(),'aw-notice-md-'));chmodSync(state,0o700);
  const db=await openStorage(state);let body:string|undefined;
  const notifier=createNotifier(db.store,{available:()=>true,send:async input=>{body=input.body;return {state:'accepted',code:'SEND_ACCEPTED'};}},state);
  try{
    const task=await db.store.submit({request_id:'notice-md',bot:'test-bot',cwd:state,argv:['claude','SECRET_ARGV']});
    if(logs?.stdout!==undefined)writeFileSync(join(state,task.id+'.stdout'),logs.stdout,{mode:0o600});
    if(logs?.stderr!==undefined)writeFileSync(join(state,task.id+'.stderr'),logs.stderr,{mode:0o600});
    await db.store.finish(task.id,terminal,exit_code,error_code);
    notifier.kick();const end=Date.now()+2000;while(body===undefined&&Date.now()<end)await new Promise(r=>setTimeout(r,10));
    if(body===undefined)throw new Error('notification was not sent');
    return {body,task,state:realpathSync(state),payload:JSON.parse((await db.store.outbox())[0]!.payload)};
  }finally{await notifier.drain();await db.close();rmSync(state,{recursive:true,force:true});}
}
for(const [state,exit_code,error_code] of [['succeeded',0,null],['failed',7,null],['failed',1,'BOT_FORBIDDEN'],['failed',null,'SPAWN_FAILED'],['cancelled',null,null],['unknown',null,'OBSERVATION_LOST']] as const)
  test(`notifier sends bounded markdown for ${state} exit=${exit_code} error=${error_code??'omitted'}`,async()=>{
    const {body,task,state:dir,payload}=await captureNotice(state,exit_code,error_code);
    expectBoundedMarkdown(body,expectedNotice(state,task.id,exit_code,error_code,{state:dir}));
    expect(body).toContain('（无输出）');expect(body).not.toContain('agentwatch logs');expect(body).not.toContain(hostname());
    expect(Object.keys(payload)).toEqual(['version','event_id','task_id','state','exit_code','error_code']);
    expect(payload).toMatchObject({version:1,event_id:task.id+':terminal:1',task_id:task.id,state,exit_code,error_code});
  });
test('notifier omits unallowlisted error_code from markdown and still stores structured payload',async()=>{
  const {body,task,state,payload}=await captureNotice('failed',1,'SECRET_ERROR');
  expectBoundedMarkdown(body,expectedNotice('failed',task.id,1,null,{state}));
  expect(body).not.toContain('错误');expect(payload).toMatchObject({state:'failed',exit_code:1,error_code:'SECRET_ERROR'});
});
test('notifier attaches short raw stdout and stderr without a query guide',async()=>{
  const stdout=Buffer.from('ok line\n'),stderr=Buffer.from('warn');
  const {body,task,state}=await captureNotice('succeeded',0,null,{stdout,stderr});
  expectBoundedMarkdown(body,expectedNotice('succeeded',task.id,0,null,{state,stdout,stderr}));
  expect(body).not.toContain('（无输出）');expect(body).not.toContain('已省略');expect(body).not.toContain('agentwatch logs');expect(body).not.toContain(hostname());
  expect(body).not.toContain(join(state,task.id+'.stdout'));
});
test('notifier writes 无输出 for empty streams and does not add a query guide',async()=>{
  const {body,task,state}=await captureNotice('succeeded',0,null,{stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)});
  expectBoundedMarkdown(body,expectedNotice('succeeded',task.id,0,null,{state,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)}));
  expect(body).toContain('## stdout\n\n（无输出）');expect(body).toContain('## stderr\n\n（无输出）');
  expect(body).not.toContain('agentwatch logs');expect(body).not.toContain('```');
});
test('notifier truncates a long stream to 4KiB head and tail with host path and logs command',async()=>{
  const stdout=Buffer.concat([Buffer.from('HEAD_START'),Buffer.alloc(8192-10-8,0x41),Buffer.from('END_TAIL')]);
  const {body,task,state}=await captureNotice('succeeded',0,null,{stdout});
  expectBoundedMarkdown(body,expectedNotice('succeeded',task.id,0,null,{state,stdout}));
  expect(body).toContain('HEAD_START');expect(body).toContain('END_TAIL');expect(body).toContain('（已省略 4096 字节）');
  expect(body).toContain('`'+hostname()+'`');expect(body).toContain('`'+join(state,task.id+'.stdout')+'`');
  expect(body).toContain('`agentwatch logs '+task.id+' --stream stdout --offset 0 --limit 65536 --state '+quoteState(state)+'`');
  expect(body).toContain('data.truncated');expect(body).toContain('next_offset');
  expect(body).not.toContain('--stream stderr');expect(body).not.toContain('cat ');
});
test('notifier truncates stdout and stderr independently',async()=>{
  const stdout=Buffer.concat([Buffer.from('OUT_HEAD'),Buffer.alloc(5000,0x42),Buffer.from('OUT_TAIL')]);
  const stderr=Buffer.from('short-err\n');
  const {body,task,state}=await captureNotice('failed',7,null,{stdout,stderr});
  expectBoundedMarkdown(body,expectedNotice('failed',task.id,7,null,{state,stdout,stderr}));
  expect(body).toContain('OUT_HEAD');expect(body).toContain('OUT_TAIL');expect(body).toContain('short-err');
  expect(body).toContain('--stream stdout');expect(body).not.toContain('--stream stderr');
  expect(body).toContain(join(state,task.id+'.stdout'));expect(body).not.toContain(join(state,task.id+'.stderr'));
  expect(body).not.toContain('（已省略 '+(stderr.length)+' 字节）');
  const both=Buffer.concat([Buffer.from('E_HEAD'),Buffer.alloc(6000,0x43),Buffer.from('E_TAIL')]);
  const again=await captureNotice('failed',1,'SPAWN_FAILED',{stdout:Buffer.from('ok\n'),stderr:both});
  expectBoundedMarkdown(again.body,expectedNotice('failed',again.task.id,1,'SPAWN_FAILED',{state:again.state,stdout:Buffer.from('ok\n'),stderr:both}));
  expect(again.body).toContain('--stream stderr');expect(again.body).not.toContain('--stream stdout');
  expect(again.body).toContain(join(again.state,again.task.id+'.stderr'));expect(again.body).not.toContain(join(again.state,again.task.id+'.stdout'));
});
test('notifier lengthens code fences when output contains backticks',async()=>{
  const stdout=Buffer.from('before\n```\ninner\n````\nafter\n');
  const {body,task,state}=await captureNotice('succeeded',0,null,{stdout});
  expectBoundedMarkdown(body,expectedNotice('succeeded',task.id,0,null,{state,stdout}));
  expect(body).toContain('`````\nbefore\n```\ninner\n````\nafter\n`````');
  expect(body).not.toContain('agentwatch logs');
});
test('notifier includes raw log bytes and never adds request argv or secrets',async()=>{
  const stdout=Buffer.from('visible output SECRET_IN_LOG\n');
  const {body,task,state}=await captureNotice('succeeded',0,null,{stdout});
  expectBoundedMarkdown(body,expectedNotice('succeeded',task.id,0,null,{state,stdout}));
  expect(body).toContain('SECRET_IN_LOG');expect(body).not.toContain('SECRET_ARGV');expect(body).not.toContain('notice-md');
});

test('notifier distinguishes read failure from missing or empty logs without leaking native errors',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-notice-md-'));chmodSync(state,0o700);
  const db=await openStorage(state);let body:string|undefined;
  const notifier=createNotifier(db.store,{available:()=>true,send:async input=>{body=input.body;return {state:'accepted',code:'SEND_ACCEPTED'};}},state);
  try{
    const task=await db.store.submit({request_id:'notice-md',bot:'test-bot',cwd:state,argv:['claude','SECRET_ARGV']});
    writeFileSync(join(state,task.id+'.stdout'),'SECRET_UNREADABLE_LOG\n',{mode:0o600});
    chmodSync(join(state,task.id+'.stdout'),0o644);
    await db.store.finish(task.id,'failed',1,'SPAWN_FAILED');
    notifier.kick();const end=Date.now()+2000;while(body===undefined&&Date.now()<end)await new Promise(r=>setTimeout(r,10));
    if(body===undefined)throw new Error('notification was not sent');
    const dir=realpathSync(state),path=join(dir,task.id+'.stdout');
    expect(body).toContain('输出读取失败，无法生成预览');
    expect(body).not.toMatch(/## stdout\n\n（无输出）/);
    expect(body).toContain('## stderr\n\n（无输出）');
    expect(body).toContain(path);
    expect(body).toContain('agentwatch logs '+task.id+' --stream stdout --offset 0 --limit 65536 --state ');
    expect(body).not.toContain('--stream stderr');
    expect(body).toContain(hostname());
    expect(body).toContain('data.truncated');expect(body).toContain('next_offset');
    expect(body).not.toContain('SECRET_UNREADABLE_LOG');
    expect(body).not.toContain('SECRET_ARGV');
    expect(body).not.toContain('Unsafe');expect(body).not.toContain('IPC_AUTH');
    expect(body).not.toContain('EACCES');expect(body).not.toContain('EPERM');
    expect(body).not.toMatch(/errno/i);expect(body).not.toContain('rejected');
    expect(body).not.toContain('CoreError');expect(body).not.toMatch(/at \S+\.(ts|js):\d+/);
  }finally{await notifier.drain();await db.close();rmSync(state,{recursive:true,force:true});}
});
test('notificationText does not break inline code when state or hostname contains backticks',()=>{
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const dir='/tmp/aw-`state';
  const body=notificationText({state:'succeeded',task_id:id,event_id:id+':terminal:1',exit_code:0,error_code:null,hostname:'host`name',state_dir:dir,stdout:{size:5000,head:Buffer.alloc(2048,0x41),tail:Buffer.alloc(2048,0x42)},stderr:{size:0,head:Buffer.alloc(0)}});
  const path=join(dir,id+'.stdout');
  expect(body).not.toContain('`'+path+'`');
  expect(body).not.toContain('`host`name`');
  expect(body).toContain('`` '+path+' ``');
  expect(body).toContain('`` host`name ``');
  expect(body).toContain("`` agentwatch logs "+id+" --stream stdout --offset 0 --limit 65536 --state '/tmp/aw-`state' ``");
});
test('logs query command is labeled for the actual platform and does not present POSIX quotes as cross-platform',()=>{
  const id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const posix=notificationText({state:'succeeded',task_id:id,event_id:id+':terminal:1',exit_code:0,error_code:null,hostname:'host',state_dir:"/tmp/o're",stdout:{size:5000,head:Buffer.alloc(2048,0x41),tail:Buffer.alloc(2048,0x42)},stderr:{size:0,head:Buffer.alloc(0)},platform:'linux'});
  expect(posix).toContain('命令（POSIX shell）：');
  expect(posix).not.toContain('PowerShell');
  expect(posix).toContain("`agentwatch logs "+id+" --stream stdout --offset 0 --limit 65536 --state '/tmp/o'\"'\"'re'`");
  const win=notificationText({state:'succeeded',task_id:id,event_id:id+':terminal:1',exit_code:0,error_code:null,hostname:'WINHOST',state_dir:"C:\\Users\\O'Brien\\aw",stdout:{size:5000,head:Buffer.alloc(2048,0x41),tail:Buffer.alloc(2048,0x42)},stderr:{size:0,head:Buffer.alloc(0)},platform:'win32'});
  expect(win).toContain('命令（PowerShell）：');
  expect(win).not.toContain('POSIX');
  expect(win).toContain("`agentwatch logs "+id+" --stream stdout --offset 0 --limit 65536 --state 'C:\\Users\\O''Brien\\aw'`");
  expect(quoteState("C:\\Users\\O'Brien\\aw",'win32')).toBe("'C:\\Users\\O''Brien\\aw'");
  expect(quoteState("/tmp/o're",'linux')).toBe("'/tmp/o'\"'\"'re'");
});


test('new initial schema contains complete task/outbox constraints, defaults and indexes without a migration chain',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-schema-new-'));let db:Awaited<ReturnType<typeof openStorage>>|undefined;
  try{
    db=await openStorage(state);
    const task=await db.store.submit({request_id:'new-schema',bot:'test-bot',cwd:state,argv:['claude']});
    await db.store.finish(task.id,'succeeded',0);
    expect(await db.store.notification(task.id)).toMatchObject({state:'pending',message_id:null,attempts:0,next_attempt_at:0,receipt:null,last_code:null,reconcile_attempts:0});
    await db.close();db=undefined;
    const raw=new Database(join(state,'tasks.sqlite'),{readonly:true});
    try{
      expect(raw.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).toEqual([{name:'outbox'},{name:'schema_info'},{name:'tasks'}]);
      expect((raw.query('PRAGMA table_info(outbox)').all() as {name:string}[]).map(r=>r.name)).toEqual(['event_id','task_id','terminal','payload','state','message_id','attempts','next_attempt_at','receipt','last_code','reconcile_attempts']);
      expect(raw.query("SELECT name FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name").all()).toEqual([{name:'outbox_pending'},{name:'task_queue'}]);
      expect(raw.query('SELECT version,length(checksum) AS length FROM schema_info').all()).toEqual([{version:1,length:64}]);
      expect(raw.query('PRAGMA journal_mode').get()).toEqual({journal_mode:'wal'});
      expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([]);
    }finally{raw.close();}
  }finally{await db?.close();rmSync(state,{recursive:true,force:true});}
});

test('reopening initial schema retains task/outbox identity and never resets uncertain notification attempts',async()=>{
  const state=mkdtempSync(join(tmpdir(),'aw-schema-reopen-'));let db=await openStorage(state);
  try{
    const input={request_id:'reopen-schema',bot:'test-bot',cwd:state,argv:['claude']};
    const task=await db.store.submit(input);await db.store.finish(task.id,'succeeded',0);
    const claimed=(await db.store.claimNotification())!;
    await db.store.completeNotification(claimed.event_id,{state:'unknown',code:'WRITE_UNCERTAIN',receipt:{delivery:'unknown'}});
    await db.store.claimReconciliation();
    const taskBefore=await db.store.get(task.id),noticeBefore=await db.store.notification(task.id);
    await db.close();db=await openStorage(state);
    expect(await db.store.get(task.id)).toEqual(taskBefore);
    expect(await db.store.submit(input)).toEqual(taskBefore);
    expect(await db.store.notification(task.id)).toEqual(noticeBefore);
    expect(noticeBefore).toMatchObject({state:'unknown',message_id:claimed.message_id,attempts:1,reconcile_attempts:1,last_code:'WRITE_UNCERTAIN'});
    expect(await db.store.claimNotification()).toBeUndefined();
    expect(await db.store.claimReconciliation()).toBeUndefined();
  }finally{await db.close();rmSync(state,{recursive:true,force:true});}
});

for(const kind of ['unknown-table','partial-legacy','empty-migrations','missing-metadata','wrong-checksum','missing-table','missing-index','empty-metadata','extra-table','sqlite-prefix-table','foreign-user-version','foreign-application-id','used-empty-database'] as const){
  test(`unsupported schema ${kind} is rejected before any database mutation`,async()=>{
    const state=mkdtempSync(join(tmpdir(),'aw-schema-invalid-')),file=join(state,'tasks.sqlite');
    if(['missing-metadata','wrong-checksum','missing-table','missing-index','empty-metadata','extra-table','sqlite-prefix-table'].includes(kind)){
      const db=await openStorage(state);await db.close();
    }
    const raw=new Database(file);
    try{
      if(kind==='unknown-table')raw.exec("CREATE TABLE notes(value TEXT); INSERT INTO notes VALUES('keep this record')");
      if(kind==='partial-legacy')raw.exec(legacyInitial.split('CREATE TABLE outbox')[0]!);
      if(kind==='empty-migrations')raw.exec('CREATE TABLE migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)');
      if(kind==='missing-metadata')raw.exec('DROP TABLE schema_info');
      if(kind==='wrong-checksum')raw.exec("UPDATE schema_info SET checksum='unknown'");
      if(kind==='missing-table')raw.exec('DROP TABLE outbox');
      if(kind==='missing-index')raw.exec('DROP INDEX outbox_pending');
      if(kind==='empty-metadata')raw.exec('DELETE FROM schema_info');
      if(kind==='extra-table')raw.exec("CREATE TABLE notes(value TEXT); INSERT INTO notes VALUES('keep this record')");
      if(kind==='sqlite-prefix-table')raw.exec("CREATE TABLE sqliteXnotes(value TEXT); INSERT INTO sqliteXnotes VALUES('not an internal table')");
      if(kind==='foreign-user-version')raw.exec('PRAGMA user_version=9');
      if(kind==='foreign-application-id')raw.exec('PRAGMA application_id=7');
      if(kind==='used-empty-database')raw.exec('CREATE TABLE removed(value TEXT); DROP TABLE removed');
    }finally{raw.close();chmodSync(file,0o600);}
    const before=readFileSync(file);
    try{
      await expect(openStorage(state).then(async db=>{await db.close();})).rejects.toMatchObject({code:'VERSION_MISMATCH'});
      expect(readFileSync(file)).toEqual(before);
    }finally{rmSync(state,{recursive:true,force:true});}
  });
}
