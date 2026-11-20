import { Effect, Schema } from 'effect';
import { eq, inArray } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeStore, tasks } from './store.ts';

const Input = Schema.Struct({
  request_id: Schema.String,
  mode: Schema.Literals(['success','failure','long','flood']),
  durationMs: Schema.Number, queueMs: Schema.Number, startMs: Schema.Number
});
const terminalStates=['succeeded','failed','cancelled','unknown'];
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export async function createEngine(store: Effect.Success<ReturnType<typeof makeStore>>, state: string, self: (...args:string[])=>string[]) {
  const {sql,orm}=store;
  const run = <A,E>(e:Effect.Effect<A,E>)=>Effect.runPromise(e);
  const get=(id:string)=>Effect.map(orm.select().from(tasks).where(eq(tasks.id,id)),rows=>{
    if(!rows[0]) throw new Error('task not found'); return rows[0];
  });
  const children=new Map<string,Bun.Subprocess>();
  let busy=false,closed=false,worker:Promise<void>|undefined;
  // Internal deterministic test barriers only; never persisted as product state.
  type Phase='claim'|'launch';
  type Barrier={request_id:string;phase:Phase;reached:boolean;released:boolean;completed:boolean;wait:Promise<void>;release:()=>void};
  const barriers=new Map<string,Barrier>();
  const view=({wait,release,...state}:Barrier)=>state;
  function controlBarrier(input:any) {
    const {request_id,phase,operation}=input;
    if(typeof request_id!=='string'||!['claim','launch'].includes(phase))throw new Error('invalid barrier');
    const key=request_id+':'+phase;
    if(operation==='arm') {
      if(barriers.has(key))throw new Error('barrier already armed');
      let release!:()=>void;
      const wait=new Promise<void>(r=>release=r);
      barriers.set(key,{request_id,phase,reached:false,released:false,completed:false,wait,release});
    }
    const barrier=barriers.get(key);if(!barrier)throw new Error('barrier not armed');
    if(operation==='release') {barrier.released=true;barrier.release();}
    else if(operation!=='arm'&&operation!=='status')throw new Error('invalid barrier operation');
    return view(barrier);
  }
  async function hold(request_id:string,phase:Phase,entered:Barrier[]) {
    const barrier=barriers.get(request_id+':'+phase);if(!barrier)return;
    entered.push(barrier);barrier.reached=true;await barrier.wait;
  }

  const finish=(id:string,target:string,code:number|null=null)=>sql.withTransaction(Effect.gen(function*(){
    const current=yield* get(id);
    if(terminalStates.includes(current.state)) return current;
    const next=target==='unknown'?'unknown':current.state==='cancelling'?'cancelled':target;
    yield* orm.update(tasks).set({state:next,exit_code:code}).where(eq(tasks.id,id));
    yield* sql`INSERT INTO outbox(task_id,terminal) VALUES (${id},${next})`;
    return yield* get(id);
  }));
  // Unknown is a terminal fact about lost supervision, not a promise of child death.
  await run(sql.withTransaction(Effect.gen(function*(){
    const lost=yield* orm.select().from(tasks).where(inArray(tasks.state,['starting','running','cancelling']));
    for(const t of lost) yield* finish(t.id,'unknown');
  })));
  async function tick() {
    if(busy||closed)return; busy=true;
    const entered:Barrier[]=[];
    try {
      const candidates=await run(orm.select().from(tasks).where(eq(tasks.state,'queued')));
      const task=candidates.find(t=>t.not_before<=Date.now()); if(!task)return;
      await hold(task.request_id,'claim',entered);
      const claimed=await run(sql.withTransaction(Effect.gen(function*(){
        const t=yield* get(task.id); if(t.state!=='queued')return false;
        yield* orm.update(tasks).set({state:'starting'}).where(eq(tasks.id,t.id)); return true;
      })));
      if(!claimed)return;
      const input=JSON.parse(task.input) as Schema.Schema.Type<typeof Input>;
      await pause(input.startMs);
      await hold(task.request_id,'launch',entered);
      // Cancellation and launch contend on the same SQLite transaction lock.
      // No await occurs between the final state check and synchronous spawn.
      const child=await run(sql.withTransaction(Effect.gen(function*(){
        const t=yield* get(task.id); if(t.state!=='starting'||closed)return undefined;
        const child=yield* Effect.sync(()=>{
          const child=Bun.spawn(self('fake',JSON.stringify({id:t.id,...input}),'--state',state),{
            stdin:'ignore',stdout:Bun.file(join(state,t.id+'.stdout')),stderr:Bun.file(join(state,t.id+'.stderr'))
          });
          children.set(t.id,child);
          appendFileSync(join(state,'launches.jsonl'),JSON.stringify({id:t.id,pid:child.pid})+'\n');
          return child;
        });
        yield* orm.update(tasks).set({state:'running',pid:child.pid}).where(eq(tasks.id,t.id));
        return child;
      })));
      if(!child)return;
      const code=await child.exited;
      await run(finish(task.id,code===0?'succeeded':'failed',code));
      children.delete(task.id);
    } finally { for(const barrier of entered)barrier.completed=true;busy=false; }
  }
  const timer=setInterval(()=>{
    if(!busy&&!closed) worker=tick().catch(e=>{appendFileSync(join(state,'errors.log'),String(e)+'\n');});
  },10);
  return {
    async close() {
      closed=true; clearInterval(timer);
      for(const barrier of barriers.values()) {barrier.released=true;barrier.release();}
      // Tests stop only their own service; shutdown waits for confirmed fake exit.
      for(const child of children.values())child.kill('SIGKILL');
      await worker;
    },
    async handle(action:string,input:any):Promise<any> {
      if(action==='test-barrier')return controlBarrier(input);
      if(action==='run') {
        const v=Schema.decodeUnknownSync(Input)({mode:'success',durationMs:100,queueMs:0,startMs:0,...input});
        if(!/^[\w-]{1,100}$/.test(v.request_id)) throw new Error('invalid request_id');
        for(const n of [v.durationMs,v.queueMs,v.startMs])if(!Number.isInteger(n)||n<0||n>10000)throw new Error('invalid duration');
        const normalized=JSON.stringify({mode:v.mode,durationMs:v.durationMs,queueMs:v.queueMs,startMs:v.startMs});
        const fingerprint=createHash('sha256').update(normalized).digest('hex');
        return run(sql.withTransaction(Effect.gen(function*(){
          yield* orm.insert(tasks).values({id:randomUUID(),request_id:v.request_id,fingerprint,
            input:normalized,state:'queued',created:Date.now(),not_before:Date.now()+v.queueMs}).onConflictDoNothing({target:tasks.request_id});
          const rows=yield* orm.select().from(tasks).where(eq(tasks.request_id,v.request_id));
          const task=rows[0]!;
          if(task.fingerprint!==fingerprint) return yield* Effect.fail(new Error('request_id conflict'));
          return task;
        })));
      }
      if(action==='status')return run(get(String(input.id)));
      if(action==='wait') {
        const timeout=input.timeoutMs??1000;
        if(!Number.isInteger(timeout)||timeout<0||timeout>10000)throw new Error('invalid timeout');
        const end=Date.now()+timeout;
        for(;;) {
          const task=await run(get(String(input.id)));
          if(terminalStates.includes(task.state))return task;
          if(Date.now()>=end)return {...task,wait_timed_out:true};
          await pause(10);
        }
      }
      if(action==='cancel') {
        const result=await run(sql.withTransaction(Effect.gen(function*(){
          const task=yield* get(String(input.id));
          if(terminalStates.includes(task.state))return task;
          if(task.state==='running'||task.state==='cancelling') {
            yield* orm.update(tasks).set({state:'cancelling'}).where(eq(tasks.id,task.id));
            return yield* get(task.id);
          }
          return yield* finish(task.id,'cancelled');
        })));
        if(result.state==='cancelling')children.get(result.id)?.kill('SIGTERM');
        return result;
      }
      if(action==='logs') {
        const t=await run(get(String(input.id)));
        const read=(suffix:string)=>{const file=join(state,t.id+suffix);return existsSync(file)?readFileSync(file,'utf8'):'';};
        return {stdout:read('.stdout'),stderr:read('.stderr')};
      }
      if(action==='retry-outbox') {
        const failUntil=input.failUntil??1;
        if(!Number.isInteger(failUntil)||failUntil<0||failUntil>10)throw new Error('invalid retry count');
        await run(sql`UPDATE outbox SET attempts=attempts+1,delivered=CASE WHEN attempts+1>${failUntil} THEN 1 ELSE 0 END WHERE delivered=0`);
        return {outbox:await run(sql`SELECT * FROM outbox ORDER BY task_id`)};
      }
      if(action==='evidence') {
        const lines=(file:string)=>existsSync(join(state,file))?readFileSync(join(state,file),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
        return {launches:lines('launches.jsonl'),spawns:lines('spawns.jsonl'),daemons:lines('daemon-starts.jsonl'),
          tasks:await run(orm.select().from(tasks)),outbox:await run(sql`SELECT * FROM outbox ORDER BY task_id`)};
      }
      throw new Error('unknown action');
    }
  };
}
