import { openSync,readSync,closeSync,statSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError,normalize,terminal,integer,type RunInput } from './domain.ts';
import { publicTask,type Store,type TaskRecord } from './storage.ts';
import { type Executor,type Verifier,type Child } from './process.ts';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export interface EngineOptions {
  store:Store;state:string;verify:Verifier;execute:Executor;
  hooks?:{beforeClaim?:(id:string)=>Promise<void>;beforeLaunch?:(id:string)=>Promise<void>};
  onError?:(error:unknown)=>void;
}
export async function createTaskEngine(options:EngineOptions) {
  const {store,state,verify,execute}=options;
  await store.recover();
  let accepting=true,worker:Promise<void>|undefined;
  const children=new Map<string,Child>(),submissions=new Set<Promise<unknown>>();
  async function view(task:TaskRecord) {
    const notice=terminal(task.state)?await store.notification(task.id):undefined;
    return {...publicTask(task),notification:{state:notice?(notice.delivered?'delivered':'pending'):'not_ready',transport:'not_configured',event_id:notice?.event_id??null}};
  }
  async function work() {
    const task=(await store.queue())[0];if(!task||!accepting)return;
    try {
      await options.hooks?.beforeClaim?.(task.id);
      const claimed=await store.transition(task.id,['queued'],'starting');if(claimed.state!=='starting')return;
      await options.hooks?.beforeLaunch?.(task.id);
      const request=normalize(JSON.parse(task.request));
      await verify(request); // Revalidate immediately before the atomic launch guard.
      const child=await store.launch(task.id,()=>{
        const child=execute(request,{stdout:join(state,task.id+'.stdout'),stderr:join(state,task.id+'.stderr')});
        children.set(task.id,child);return child;
      });
      if(!child)return;
      const code=await child.exited;
      await store.finish(task.id,code===0?'succeeded':'failed',code);
    } catch(error) {
      const child=children.get(task.id),uncertain=!!child;
      if(child){child.cancel();await child.exited.catch(()=>null);}
      await store.finish(task.id,uncertain?'unknown':'failed',null,error instanceof CoreError?error.code:uncertain?'OBSERVATION_LOST':'SPAWN_FAILED');
      options.onError?.(error);
    } finally {children.delete(task.id);}
  }
  function kick() {
    if(!accepting||worker)return;
    worker=work().catch(e=>options.onError?.(e)).finally(()=>{worker=undefined;});
  }
  const timer=setInterval(kick,15);
  async function submit(value:unknown) {
    const input=normalize(value);
    const prior=await store.lookup(input);if(prior)return view(prior);
    if(!accepting)throw new CoreError('DRAINING','Daemon is draining');
    await verify(input);
    if(!accepting)throw new CoreError('DRAINING','Daemon is draining');
    const task=await store.submit(input);queueMicrotask(kick);return view(task);
  }
  async function drain() {
    accepting=false;clearInterval(timer);
    await Promise.allSettled([...submissions]);await worker;
    return {active:children.size,unknown:(await store.unknowns()).map(t=>t.id)};
  }
  return {
    run(input:unknown) {
      const pending=submit(input);submissions.add(pending);
      void pending.finally(()=>submissions.delete(pending)).catch(()=>{});return pending;
    },
    status:async(id:string)=>view(await store.get(id)),
    async cancel(id:string) {
      const task=await store.cancel(id);if(task.state==='cancelling')children.get(id)?.cancel();
      return view(task);
    },
    async wait(id:string,timeoutMs=30000) {
      integer(timeoutMs,'timeout',300000);const end=Date.now()+timeoutMs;
      for(;;) {
        const task=await view(await store.get(id));
        if(terminal(task.state))return {task,wait_timed_out:false};
        if(Date.now()>=end)return {task,wait_timed_out:true};
        await pause(15);
      }
    },
    async logs(id:string,stream='stdout',offset=0,limit=4096) {
      const task=await store.get(id);integer(offset,'offset',Number.MAX_SAFE_INTEGER);integer(limit,'limit',65536);
      if(!['stdout','stderr'].includes(stream))throw new CoreError('USAGE','Unknown log stream');
      const file=join(state,task.id+'.'+stream);
      if(!existsSync(file))return {stream,offset,next_offset:offset,bytes:0,truncated:false,data_base64:'',text:''};
      const size=statSync(file).size;if(offset>size)throw new CoreError('USAGE','Offset exceeds log size');
      const fd=openSync(file,'r'),data=Buffer.alloc(Math.min(limit,size-offset));
      let bytes:number;try{bytes=readSync(fd,data,0,data.length,offset);}finally{closeSync(fd);}
      return {stream,offset,next_offset:offset+bytes,bytes,truncated:offset+bytes<size,data_base64:data.subarray(0,bytes).toString('base64'),text:data.subarray(0,bytes).toString('utf8')};
    },
    drain,
    async close() {accepting=false;clearInterval(timer);for(const child of children.values())child.cancel();await drain();},
  };
}
export type TaskEngine=Awaited<ReturnType<typeof createTaskEngine>>;
