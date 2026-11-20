import { test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { harness, until, alive } from './harness.ts';
export function contracts(label:string,command:string[],env?:NodeJS.ProcessEnv) {
  const check=(name:string,body:(h:ReturnType<typeof harness>)=>Promise<void>)=>test(`${label}: ${name}`,async()=>{
    const h=harness(command,env);try{
      await body(h);
      const e=await h.call('evidence');
      for(const t of e.tasks) {
        const terminal=['succeeded','failed','cancelled','unknown'].includes(t.state);
        const events=e.outbox.filter((r:any)=>r.task_id===t.id);
        expect(events.length).toBe(terminal?1:0);
        if(terminal)expect(events[0].terminal).toBe(t.state);
      }
    }finally{await h.cleanup();}
  },20000);
  test(`${label}: strict stop exits daemon and active fake without cleanup fallback`,async()=>{
    const h=harness(command,env);let verified=false;
    try {
      const task=await h.call('run',{request_id:'stop-running',mode:'long',durationMs:10000});
      const e=await until(()=>h.call('evidence'),e=>e.spawns.some((r:any)=>r.id===task.id));
      expect(alive(e.spawns.find((r:any)=>r.id===task.id).pid)).toBe(true);
      await h.strictStop();verified=true;
    } catch(e) {
      console.error('STRICT_STOP_FAILED_BEFORE_CLEANUP '+String(e));throw e;
    } finally {
      const cleanup=await h.cleanup();
      if(verified) {
        expect(cleanup.forcedPids).toEqual([]);expect(existsSync(h.state)).toBe(false);
        console.log('STRICT_STOP_ACCEPTED_WITHOUT_FALLBACK');
      }
    }
  },20000);
  check('eight concurrent CLIs elect exactly one daemon and SQLite migration is embedded',async h=>{
    const health=await Promise.all(Array.from({length:8},()=>h.call('health')));
    expect(new Set(health.map(x=>x.pid)).size).toBe(1);
    expect(health[0].schema_version).toBe(1);
    expect((await h.call('evidence')).daemons).toHaveLength(1);
  });
  check('schema rejects invalid fake input without a spawn',async h=>{
    expect((await h.raw('run',{request_id:'bad',mode:'arbitrary-command'})).code).not.toBe(0);
    expect((await h.call('evidence')).spawns).toHaveLength(0);
  });
  check('concurrent duplicates and dropped response reuse one task, conflicting payload fails',async h=>{
    const input={request_id:'same-1',mode:'success'};
    const dropped=await h.raw('drop-run',input);expect(dropped.code).not.toBe(0);
    const requests=await Promise.all(Array.from({length:5},()=>h.call('run',input)));
    expect(new Set(requests.map(t=>t.id)).size).toBe(1);
    expect((await h.raw('run',{...input,mode:'failure'})).code).not.toBe(0);
    expect((await h.call('wait',{id:requests[0].id,timeoutMs:3000})).state).toBe('succeeded');
    const e=await h.call('evidence');expect(e.spawns).toHaveLength(1);expect(e.outbox).toHaveLength(1);
  });
  check('failure exit code and separate multi-megabyte stdout/stderr remain complete',async h=>{
    const failed=await h.call('run',{request_id:'fail',mode:'failure'});
    const f=await h.call('wait',{id:failed.id,timeoutMs:3000});expect(f.state).toBe('failed');expect(f.exit_code).toBe(7);
    const flood=await h.call('run',{request_id:'flood',mode:'flood',durationMs:0});
    expect((await h.call('wait',{id:flood.id,timeoutMs:3000})).state).toBe('succeeded');
    const logs=await h.call('logs',{id:flood.id});
    expect(logs.stdout.length).toBe(2097152);expect(logs.stderr.length).toBe(2097152);
  });
  check('CLI exits while fake continues; wait timeout does not cancel; running cancel confirms exit',async h=>{
    const task=await h.call('run',{request_id:'long',mode:'long',durationMs:8000});
    const running=await until(()=>h.call('status',{id:task.id}),t=>t.state==='running');
    const receipt=await until(()=>h.call('evidence'),e=>e.spawns.length===1);
    expect(alive(receipt.spawns[0].pid)).toBe(true);
    const wait=await h.call('wait',{id:task.id,timeoutMs:20});expect(wait.wait_timed_out).toBe(true);
    expect((await h.call('status',{id:task.id})).state).toBe('running');
    expect(alive(running.pid)).toBe(true);
    await h.call('cancel',{id:task.id});
    expect((await h.call('wait',{id:task.id,timeoutMs:3000})).state).toBe('cancelled');
    expect(alive(running.pid)).toBe(false);
  });
  for(const phase of ['claim','launch'] as const) {
    check(`deterministic ${phase} cancellation cannot launch after acknowledgement`,async h=>{
      const request_id='cancel-at-'+phase;
      const barrier=(operation:string)=>h.call('test-barrier',{request_id,phase,operation});
      try {
        await barrier('arm');
        const task=await h.call('run',{request_id,durationMs:0});
        const reached=await until(()=>barrier('status'),b=>b.reached);
        expect(reached.completed).toBe(false);
        expect(reached.released).toBe(false);
        expect((await h.call('status',{id:task.id})).state).toBe(phase==='claim'?'queued':'starting');
        const cancelled=await h.call('cancel',{id:task.id});
        expect(cancelled.state).toBe('cancelled');expect(cancelled.pid).toBeNull();
        expect((await h.call('evidence')).launches).toHaveLength(0);
        await barrier('release');
        // Acknowledges the ENTIRE worker attempt completed, not merely a timer.
        await until(()=>barrier('status'),b=>b.completed);
        const e=await h.call('evidence');
        expect(e.launches.filter((r:any)=>r.id===task.id)).toHaveLength(0);
        expect(e.spawns.filter((r:any)=>r.id===task.id)).toHaveLength(0);
        expect(e.outbox).toHaveLength(1);
        expect((await h.call('status',{id:task.id})).state).toBe('cancelled');
        console.log(`CANCEL_BARRIER_VERIFIED phase=${phase} completed=true launches=0 child_receipts=0`);
      } catch(e) {console.error('CANCEL_BARRIER_ASSERTION_FAILED '+phase+' '+String(e));throw e;}
    });
  }
  check('launch/cancel boundary produces only confirmed cancellation, at most one spawn',async h=>{
    for(let i=0;i<4;i++) {
      const task=await h.call('run',{request_id:'race-'+i,startMs:i*15,durationMs:2000});
      await h.call('cancel',{id:task.id});
      expect((await h.call('wait',{id:task.id,timeoutMs:3000})).state).toBe('cancelled');
    }
    const e=await h.call('evidence');
    for(const task of e.tasks)expect(e.spawns.filter((s:any)=>s.id===task.id).length).toBeLessThanOrEqual(1);
    expect(e.outbox).toHaveLength(4);
  });
  check('crash during starting becomes unknown without spawn; historical unknown does not block new work',async h=>{
    const task=await h.call('run',{request_id:'starting-crash',startMs:3000});
    await until(()=>h.call('status',{id:task.id}),t=>t.state==='starting');
    const old=await h.call('health');process.kill(old.pid,'SIGKILL');
    await until(async()=>alive(old.pid),a=>!a);
    expect((await h.call('wait',{id:task.id,timeoutMs:0})).state).toBe('unknown');
    expect((await h.call('run',{request_id:'starting-crash',startMs:3000})).id).toBe(task.id);
    const next=await h.call('run',{request_id:'after-unknown'});
    expect((await h.call('wait',{id:next.id,timeoutMs:3000})).state).toBe('succeeded');
    const e=await h.call('evidence');
    expect(e.spawns.filter((r:any)=>r.id===task.id)).toHaveLength(0);
    expect(e.spawns.filter((r:any)=>r.id===next.id)).toHaveLength(1);
  });
  check('hard crash recovers running as unknown, preserves outbox, never replays; fake retry does not respawn',async h=>{
    const done=await h.call('run',{request_id:'before-crash'});
    await h.call('wait',{id:done.id,timeoutMs:3000});
    const task=await h.call('run',{request_id:'crash',mode:'long',durationMs:8000});
    await until(()=>h.call('evidence'),e=>e.spawns.length===2);
    const old=await h.call('health');process.kill(old.pid,'SIGKILL');
    await until(async()=>alive(old.pid),a=>!a);
    const health=await h.call('health');expect(health.pid).not.toBe(old.pid);
    const recovered=await h.call('wait',{id:task.id,timeoutMs:20});expect(recovered.state).toBe('unknown');
    expect((await h.call('run',{request_id:'crash',mode:'long',durationMs:8000})).id).toBe(task.id);
    const first=await h.call('retry-outbox',{failUntil:1});expect(first.outbox.every((r:any)=>r.attempts===1&&r.delivered===0)).toBe(true);
    const next=await h.call('retry-outbox',{failUntil:1});expect(next.outbox.every((r:any)=>r.attempts===2&&r.delivered===1)).toBe(true);
    const e=await h.call('evidence');expect(e.spawns).toHaveLength(2);expect(e.outbox).toHaveLength(2);
    expect(e.outbox.find((r:any)=>r.task_id===task.id).terminal).toBe('unknown');
  });
}
