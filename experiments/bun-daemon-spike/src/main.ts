import { Effect, Schema } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import { BunServices } from '@effect/platform-bun';
import { SqliteClient } from '@effect/sql-sqlite-bun';
import { createServer, createConnection, type Server } from 'node:net';
import { mkdirSync, appendFileSync, statSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { makeStore, tasks } from './store.ts';
import { createEngine } from './engine.ts';

const actionSchema = Schema.Literals(['health','stop','serve','fake','run','status','logs','wait','cancel','evidence','retry-outbox','drop-run']);
declare const SPIKE_COMPILED: boolean;
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
// Linux abstract socket: atomic bind, automatically released on SIGKILL.
// Private random state paths are required by tests; not a production auth design.
const socket = (state: string) => '\0aw-spike-' + createHash('sha256').update(state).digest('hex').slice(0,32);
export const self = (...args: string[]) => typeof SPIKE_COMPILED !== 'undefined' && SPIKE_COMPILED
  ? [process.execPath, ...args] : [process.execPath, resolve(import.meta.dir, 'main.ts'), ...args];

async function rpc(state: string, action: string, input = {}): Promise<any> {
  return new Promise((ok, fail) => {
    const c = createConnection({path:socket(state)});
    let data = '';
    c.setEncoding('utf8');
    c.setTimeout(12000, () => c.destroy(new Error('IPC timeout')));
    c.on('connect', () => c.end(JSON.stringify({action,input})+'\n'));
    c.on('data', s => data += s);
    c.on('error', fail);
    c.on('end', () => { try {
      const r = JSON.parse(data); if (r.error) fail(new Error(r.error)); else ok(r);
    } catch (e) { fail(e); } });
  });
}
async function ensure(state: string) {
  try { return await rpc(state,'health'); } catch {}
  const child = spawn(self('serve','--state',state)[0]!, self('serve','--state',state).slice(1), {
    detached:true, stdio:'ignore', env:process.env
  });
  child.on('error', () => {}); child.unref();
  for (let i=0;i<200;i++) {
    try { return await rpc(state,'health'); } catch { await pause(25); }
  }
  throw new Error('daemon handshake timed out');
}
function bind(state: string): Promise<Server> {
  return new Promise((ok, fail) => {
    const s = createServer({allowHalfOpen:true});
    s.once('error', fail);
    s.listen(socket(state), () => { s.removeListener('error',fail); ok(s); });
  });
}
function daemon(state: string) {
  return Effect.scoped(Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(Effect.tryPromise(() => bind(state)),
      s => Effect.sync(() => s.close()));
    let ready = false;
    let handle: (action:string,input:any) => Promise<any> = async () => { throw new Error('not ready'); };
    server.on('connection', c => {
      let data=''; c.setEncoding('utf8'); c.setTimeout(12000,()=>c.destroy());
      c.on('error',()=>{});
      c.on('data', chunk => { data+=chunk; if(data.length>65536) c.destroy(); });
      c.on('end', async () => {
        try { if(!ready) throw new Error('not ready');
          const req=JSON.parse(data); const result=await handle(req.action==='drop-run'?'run':req.action,req.input);
          if(req.action==='drop-run') { c.destroy(); return; }
          c.end(JSON.stringify(result)+'\n');
        } catch(e) { c.end(JSON.stringify({error:String(e)})+'\n'); }
      });
    });
    appendFileSync(join(state,'daemon-starts.jsonl'),JSON.stringify({pid:process.pid})+'\n');
    const sql = yield* SqliteClient.SqliteClient;
    const store=yield* makeStore(sql); yield* store.init;
    const engine=yield* Effect.acquireRelease(Effect.tryPromise(()=>createEngine(store,state,self)),e=>Effect.promise(()=>e.close()));
    let stop!: () => void;
    const stopped = new Promise<void>(r=>stop=r);
    handle = async (action,input) => {
      if(action==='stop') { setTimeout(stop,50); return {stopping:true,pid:process.pid}; }
      if(action==='health') {
        const rows=await Effect.runPromise(store.orm.select().from(tasks));
        const versions=await Effect.runPromise(sql<{version:number}>`SELECT version FROM migrations ORDER BY version DESC LIMIT 1`);
        return {pid:process.pid,schema_version:versions[0]?.version,tasks:rows.length,effect_sql:true};
      }
      return engine.handle(action,input);
    };
    ready=true;
    yield* Effect.promise(()=>stopped);
  }).pipe(Effect.provide(SqliteClient.layer({filename:join(state,'tasks.sqlite')}))));
}
async function fake(state:string,input:string) {
    const v=JSON.parse(input);
    if(!/^[a-f0-9-]{36}$/.test(v.id))throw new Error('invalid fake id');
    appendFileSync(join(state,'spawns.jsonl'),JSON.stringify({id:v.id,pid:process.pid})+'\n');
    if(v.mode==='flood') {
      const data='x'.repeat(65536);
      for(let i=0;i<32;i++) { await Bun.write(Bun.stdout,data); await Bun.write(Bun.stderr,data); }
    } else { console.log('fake stdout'); console.error('fake stderr'); }
    await pause(v.durationMs); process.exitCode=v.mode==='failure'?7:0; return;
  }

const cli=Command.make('aw-spike', {
  action:Argument.String('action'),
  state:Flag.String('state'),
  input:Argument.String('json').pipe(Argument.withDefault('{}')),
}, ({action,state,input})=>Effect.gen(function*(){
  Schema.decodeUnknownSync(actionSchema)(action);
  state=resolve(state); mkdirSync(state,{recursive:true,mode:0o700});
  state=realpathSync(state);
  const st=statSync(state);
  if(st.uid!==process.getuid?.()||(st.mode&0o077)!==0)throw new Error('state must be private (0700) and owned by current user');
  if(action==='fake') { yield* Effect.tryPromise(()=>fake(state,input)); return; }
  if(action==='serve') { yield* daemon(state); return; }
  if(action!=='stop') yield* Effect.tryPromise(()=>ensure(state));
  const result=yield* Effect.tryPromise(()=>rpc(state,action,JSON.parse(input)));
  console.log(JSON.stringify(result));
}));
try {
  await Effect.runPromise(Command.runWith(cli,{version:'0.0.0-spike'})(process.argv.slice(2)).pipe(Effect.provide(BunServices.layer)));
} catch(e) {
  // Contending daemons losing the atomic socket bind are expected to exit.
  console.error(String(e)); process.exitCode=1;
}
