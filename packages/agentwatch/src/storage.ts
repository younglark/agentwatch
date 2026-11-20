import { Context, Effect, Layer, ManagedRuntime } from 'effect';
import { SqliteClient } from '@effect/sql-sqlite-bun';
import { makeWithDefaults } from 'drizzle-orm/effect-sqlite-bun';
import { sqliteTable,text,integer } from 'drizzle-orm/sqlite-core';
import { eq,inArray,asc } from 'drizzle-orm';
import { createHash,randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { closeSync,openSync,lstatSync,constants } from 'node:fs';
import { CoreError,normalize,terminal,type RunInput,type State } from './domain.ts';
import migration from './migrations/001.sql' with {type:'text'};
import notificationMigration from './migrations/002.sql' with {type:'text'};
export interface NotificationRecord {
  event_id:string;task_id:string;terminal:string;payload:string;delivered:number;
  state:string;message_id:string|null;attempts:number;next_attempt_at:number;
  receipt:string|null;last_code:string|null;reconcile_attempts:number;
}
const tasks=sqliteTable('tasks',{
  id:text().primaryKey(),request_id:text().notNull(),fingerprint:text().notNull(),request:text().notNull(),
  state:text().notNull(),pid:integer(),exit_code:integer(),error_code:text(),created_at:integer().notNull(),updated_at:integer().notNull()
});
export type TaskRecord=typeof tasks.$inferSelect;
export const publicTask=({request,fingerprint,...task}:TaskRecord)=>task;
const make=Effect.gen(function*(){
  const sql=yield* SqliteClient.SqliteClient;
  const orm=yield* makeWithDefaults();
  const run=<A,E>(effect:Effect.Effect<A,E>)=>Effect.runPromise(effect);
  const get=(id:string)=>Effect.gen(function*(){
    const rows=yield* orm.select().from(tasks).where(eq(tasks.id,id));
    if(!rows[0])return yield* Effect.fail(new CoreError('NOT_FOUND','Task not found'));
    return rows[0];
  });
  const migrations=[migration,notificationMigration].map(text=>({text,digest:createHash('sha256').update(text).digest('hex')}));
  yield* sql`PRAGMA foreign_keys=ON`;
  yield* sql.withTransaction(Effect.gen(function*(){
    yield* sql`CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)`;
    const versions=yield* sql<{version:number;checksum:string}>`SELECT version,checksum FROM migrations ORDER BY version`;
    if(versions.length>migrations.length||versions.some((row,i)=>row.version!==i+1||row.checksum!==migrations[i]!.digest))
      throw new CoreError('VERSION_MISMATCH','Unsupported database migration version');
    for(let i=versions.length;i<migrations.length;i++){
      const current=migrations[i]!;
      for(const statement of current.text.split(';').map(s=>s.trim()).filter(Boolean))yield* sql.unsafe(statement);
      yield* sql`INSERT INTO migrations(version,checksum) VALUES (${i+1},${current.digest})`;
    }
  }));
  const finish=(id:string,state:State,exit_code:number|null=null,error_code:string|null=null)=>sql.withTransaction(Effect.gen(function*(){
    const current=yield* get(id);if(terminal(current.state))return current;
    const next=state==='unknown'?'unknown':current.state==='cancelling'?'cancelled':state;
    if(!terminal(next))return yield* Effect.fail(new CoreError('INTERNAL','Invalid terminal transition'));
    yield* orm.update(tasks).set({state:next,exit_code,error_code,updated_at:Date.now()}).where(eq(tasks.id,id));
    const event_id=id+':terminal:1';
    yield* sql`INSERT INTO outbox(event_id,task_id,terminal,payload) VALUES (${event_id},${id},${next},${JSON.stringify({version:1,event_id,task_id:id,state:next,exit_code,error_code})})`;
    return yield* get(id);
  }));
  return {
    get:(id:string)=>run(get(id)),
    async lookup(input:RunInput) {
      const request=JSON.stringify(normalize(input));
      const fingerprint=createHash('sha256').update(request).digest('hex');
      const rows=await run(orm.select().from(tasks).where(eq(tasks.request_id,input.request_id)));
      if(rows[0]&&rows[0].fingerprint!==fingerprint)throw new CoreError('CONFLICT','Request ID has a different request');
      return rows[0];
    },
    async submit(input:RunInput) {
      const normalized=normalize(input),request=JSON.stringify(normalized),fingerprint=createHash('sha256').update(request).digest('hex');
      return run(sql.withTransaction(Effect.gen(function*(){
        yield* orm.insert(tasks).values({id:randomUUID(),request_id:normalized.request_id,fingerprint,request,state:'queued',created_at:Date.now(),updated_at:Date.now()}).onConflictDoNothing({target:tasks.request_id});
        const rows=yield* orm.select().from(tasks).where(eq(tasks.request_id,normalized.request_id));
        const task=rows[0]!;if(task.fingerprint!==fingerprint)return yield* Effect.fail(new CoreError('CONFLICT','Request ID has a different request'));
        return task;
      })));
    },
    queue:()=>run(orm.select().from(tasks).where(eq(tasks.state,'queued')).orderBy(asc(tasks.created_at),asc(tasks.id)).limit(1)),
    transition:(id:string,from:State[],state:State,patch:Partial<Pick<TaskRecord,'pid'|'error_code'>>={})=>run(sql.withTransaction(Effect.gen(function*(){
      const task=yield* get(id);if(!from.includes(task.state as State))return task;
      yield* orm.update(tasks).set({state,updated_at:Date.now(),...patch}).where(eq(tasks.id,id));return yield* get(id);
    }))),
    launch:<A extends {pid:number}>(id:string,create:()=>A)=>run(sql.withTransaction(Effect.gen(function*(){
      const task=yield* get(id);if(task.state!=='starting')return undefined;
      // External spawn cannot be rolled back; crash/commit uncertainty is unknown.
      const child=yield* Effect.sync(create);
      yield* orm.update(tasks).set({state:'running',pid:child.pid,updated_at:Date.now()}).where(eq(tasks.id,id));
      return child;
    }))),
    finish:(id:string,state:State,code:number|null=null,error:string|null=null)=>run(finish(id,state,code,error)),
    cancel:(id:string)=>run(sql.withTransaction(Effect.gen(function*(){
      const task=yield* get(id);if(terminal(task.state))return task;
      if(task.state==='queued'||task.state==='starting')return yield* finish(id,'cancelled');
      yield* orm.update(tasks).set({state:'cancelling',updated_at:Date.now()}).where(eq(tasks.id,id));return yield* get(id);
    }))),
    recover:()=>run(sql.withTransaction(Effect.gen(function*(){
      const rows=yield* orm.select().from(tasks).where(inArray(tasks.state,['starting','running','cancelling']));
      for(const task of rows)yield* finish(task.id,'unknown',null,'OBSERVATION_LOST');
      yield* sql`UPDATE outbox SET state='unknown',last_code='INTERRUPTED_SEND' WHERE state='inflight'`;
    }))),
    unknowns:async()=>run(orm.select({id:tasks.id}).from(tasks).where(eq(tasks.state,'unknown'))),
    claimNotification:()=>run(sql.withTransaction(Effect.gen(function*(){
      const rows=yield* sql<NotificationRecord & {request:string}>`SELECT outbox.*,tasks.request FROM outbox JOIN tasks ON tasks.id=outbox.task_id WHERE outbox.state='pending' AND next_attempt_at<=${Date.now()} ORDER BY event_id LIMIT 1`;
      const row=rows[0];if(!row)return undefined;
      const message_id=row.message_id??randomUUID();
      yield* sql`UPDATE outbox SET state='inflight',message_id=${message_id},attempts=attempts+1 WHERE event_id=${row.event_id} AND state='pending'`;
      return {...row,state:'inflight',message_id,attempts:row.attempts+1};
    }))),
    completeNotification:(event_id:string,result:{state:'accepted'|'rejected'|'not_dispatched'|'unknown'|'pending';code:string;receipt?:Record<string,unknown>;next_attempt_at?:number})=>run(sql`UPDATE outbox SET state=${result.state},last_code=${result.code},receipt=${result.receipt?JSON.stringify(result.receipt):null},next_attempt_at=${result.next_attempt_at??0} WHERE event_id=${event_id} AND state='inflight'`),
    claimReconciliation:()=>run(sql.withTransaction(Effect.gen(function*(){
      const rows=yield* sql<NotificationRecord & {request:string}>`SELECT outbox.*,tasks.request FROM outbox JOIN tasks ON tasks.id=outbox.task_id WHERE outbox.state='unknown' AND message_id IS NOT NULL AND reconcile_attempts=0 ORDER BY event_id LIMIT 1`;
      const row=rows[0];if(!row)return undefined;
      yield* sql`UPDATE outbox SET reconcile_attempts=1 WHERE event_id=${row.event_id} AND state='unknown'`;
      return {...row,reconcile_attempts:1};
    }))),
    completeReconciliation:(event_id:string,result:{state:'accepted'|'rejected'|'unknown';code:string;receipt?:Record<string,unknown>})=>run(sql`UPDATE outbox SET state=${result.state},last_code=CASE WHEN ${result.state}='unknown' THEN last_code ELSE ${result.code} END,receipt=${result.receipt?JSON.stringify(result.receipt):null} WHERE event_id=${event_id} AND state='unknown'`),
    notification:async(id:string)=>(await run(sql<NotificationRecord>`SELECT * FROM outbox WHERE task_id=${id}`))[0],
    outbox:()=>run(sql<NotificationRecord>`SELECT * FROM outbox ORDER BY event_id`),
  };
});
export type Store=Effect.Success<typeof make>;
export class Storage extends Context.Service<Storage,Store>()('agentwatch/Storage'){}
export function storageLayer(state:string) {
  const file=join(state,'tasks.sqlite');
  // Own state directory is checked by service bootstrap; never import legacy auth files.
  closeSync(openSync(file,constants.O_CREAT|constants.O_APPEND|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600));
  const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw new CoreError('IPC_AUTH','Unsafe database permissions');
  return Layer.effect(Storage,make).pipe(Layer.provide(SqliteClient.layer({filename:file})));
}
export async function openStorage(state:string) {
  const runtime=ManagedRuntime.make(storageLayer(state));
  try {
    const store=await runtime.runPromise(Effect.gen(function*(){return yield* Storage;}));
    return {store,close:()=>runtime.dispose()};
  } catch(error) {await runtime.dispose();throw error;}
}
