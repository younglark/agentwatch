import { connectNotifications,type NotificationTransport } from './notifications.ts';
import { verifyConnect } from './connect-verifier.ts';
import { connectReady } from './connect-client.ts';
import { beginLogin,loginStatus,logout } from './auth/session.ts';
import { Schema } from 'effect';
import { Database } from 'bun:sqlite';
import { mkdirSync,realpathSync,lstatSync,writeFileSync,renameSync,readFileSync,unlinkSync,openSync,closeSync,constants,appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes,randomUUID,createHash,timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CoreError,failure,PROTOCOL,integer,exitCodes } from './domain.ts';
import { openStorage } from './storage.ts';
import { createTaskEngine } from './engine.ts';
import { nativeExecutor,type Executor,type Verifier } from './process.ts';
export const VERSION='0.1.0';
export const Registration=Schema.Struct({version:Schema.String,protocol:Schema.Number,instance:Schema.String,scope:Schema.String,pid:Schema.Number,port:Schema.Number,token:Schema.String});
export type Registration=typeof Registration.Type;
const Message=Schema.Struct({operation:Schema.Literals(['health','run','status','logs','wait','cancel','drain','shutdown','login','login_status','logout']),data:Schema.Unknown});
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export function privateState(path:string) {
  mkdirSync(path,{recursive:true,mode:0o700});const state=realpathSync(path),stat=lstatSync(state);
  if(!stat.isDirectory()||(process.platform!=='win32'&&(stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)))throw new CoreError('IPC_AUTH','State directory must be private and owned by current user');
  return state;
}
const scopeFor=(state:string)=>createHash('sha256').update(state).digest('hex');
function safeFile(path:string) {
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)))throw new CoreError('IPC_AUTH','Unsafe service file');
}
export function readRegistration(path:string):Registration|undefined {
  const state=privateState(path),file=join(state,'service.json');
  try {
    safeFile(file);const info=Schema.decodeUnknownSync(Registration)(JSON.parse(readFileSync(file,'utf8')));
    integer(info.port,'registered port',65535);if(info.port===0||info.scope!==scopeFor(state))throw new CoreError('IPC_AUTH','Service registration scope mismatch');
    if(info.protocol!==PROTOCOL||info.version!==VERSION)throw new CoreError('VERSION_MISMATCH','Service version is incompatible; automatic replacement is not implemented');
    return info;
  }catch(error) {
    if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;
    if(error instanceof CoreError)throw error;
    throw new CoreError('IPC_AUTH','Invalid service registration');
  }
}
export async function request(info:Registration,operation:string,data:unknown):Promise<any> {
  const timeout=operation==='wait'?integer((data as {timeoutMs?:number}).timeoutMs??30000,'timeout',300000)+3000:10000;
  let response:Response;
  try{response=await fetch(`http://127.0.0.1:${info.port}/rpc`,{method:'POST',redirect:'error',headers:{'content-type':'application/json','authorization':'Bearer '+info.token,'x-agentwatch-instance':info.instance,'x-agentwatch-scope':info.scope},body:JSON.stringify({operation,data}),signal:AbortSignal.timeout(timeout)});}catch{throw new CoreError('TRANSPORT_NOT_CONFIGURED','Local daemon is unavailable');}
  let body:any;try{const text=await response.text();if(text.length>1048576)throw new Error();body=JSON.parse(text);}catch{throw new CoreError('TRANSPORT_NOT_CONFIGURED','Invalid local service response');}
  if(!body.ok) {
    const code=body.error?.code;if(typeof code!=='string')throw new CoreError('TRANSPORT_NOT_CONFIGURED','Invalid local error response');
    throw new CoreError(Object.hasOwn(exitCodes,code)?code as keyof typeof exitCodes:'INTERNAL',typeof body.error.message==='string'?body.error.message:'Local service failed');
  }
  if(body.version!==PROTOCOL)throw new CoreError('VERSION_MISMATCH','Local protocol mismatch');
  return body.data;
}
function ownsLease(state:string) {
  const file=join(state,'ownership.sqlite');
  closeSync(openSync(file,constants.O_CREAT|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600));safeFile(file);
  const db=new Database(file,{create:true});
  try {db.run('PRAGMA busy_timeout=0');db.run('BEGIN EXCLUSIVE');}
  catch(error){db.close();if((error as {code?:string}).code==='SQLITE_BUSY')return undefined;throw error;}
  return ()=>{try{db.run('ROLLBACK');}finally{db.close();}};
}
export interface Adapters {verify:Verifier;execute:Executor;notifications?:NotificationTransport;testOnly?:boolean}
export const productionAdapters:Adapters={
  verify:verifyConnect,
  execute:nativeExecutor,notifications:connectNotifications,
};
export async function startDaemon(path:string,adapters:Adapters=productionAdapters) {
  const state=privateState(path),release=ownsLease(state);if(!release)return undefined;
  let db:Awaited<ReturnType<typeof openStorage>>|undefined,engine:Awaited<ReturnType<typeof createTaskEngine>>|undefined,server:Bun.Server<undefined>|undefined,info:Registration|undefined;
  let resolveStopped!:()=>void;const stopped=new Promise<void>(r=>resolveStopped=r);
  let closing:Promise<void>|undefined;
  function close() {
    return closing??=(async()=>{
      try {
        try {await engine?.drain();}
        finally {try{await engine?.close();}finally{server?.stop(true);await db?.close();}}
      }
      finally {
        try{if(info&&readRegistration(state)?.instance===info.instance)unlinkSync(join(state,'service.json'));}catch{}
        release!();resolveStopped();
      }
    })();
  }
  try {
    db=await openStorage(state);
    engine=await createTaskEngine({store:db.store,state,verify:adapters.verify,execute:adapters.execute,notifications:adapters.notifications,onError:()=>appendFileSync(join(state,'diagnostics.log'),'task observation error\n',{mode:0o600})});
    const token=randomBytes(32).toString('base64url'),instance=randomUUID(),scope=scopeFor(state);
    const auth=(request:Request)=>{
      const supplied=Buffer.from(request.headers.get('authorization')??''),expected=Buffer.from('Bearer '+token);
      return supplied.length===expected.length&&timingSafeEqual(supplied,expected)&&request.headers.get('x-agentwatch-instance')===instance&&request.headers.get('x-agentwatch-scope')===scope;
    };
    const result=(data:unknown)=>Response.json({version:PROTOCOL,ok:true,data});
    server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,maxRequestBodySize:65536,async fetch(req){
      try {
        if(!auth(req))throw new CoreError('IPC_AUTH','Local IPC authorization rejected');
        if(req.method!=='POST'||new URL(req.url).pathname!=='/rpc')throw new CoreError('USAGE','Unsupported local endpoint');
        let message:typeof Message.Type;
        try{message=Schema.decodeUnknownSync(Message)(await req.json());}catch{throw new CoreError('USAGE','Invalid local request');}
        const data=message.data as Record<string,unknown>,op=message.operation;
        if(op==='health')return result({pid:process.pid,instance,scope,protocol:PROTOCOL,version:VERSION,bot_verifier:adapters.testOnly?'test_only':connectReady()?'connect_http':'not_configured',notification_transport:adapters.notifications?.available()?'connect_http':'not_configured'});
        if(op==='login')return result(await beginLogin());
        if(op==='login_status')return result(loginStatus());
        if(op==='logout')return result(await logout());
        if(op==='run')return result(await engine!.run(data));
        if(op==='drain')return result(await engine!.drain());
        if(op==='shutdown'){setTimeout(()=>{void close();},30);return result({stopping:true,pid:process.pid});}
        if(!data||typeof data.id!=='string')throw new CoreError('USAGE','Task ID is required');
        if(op==='status')return result(await engine!.status(data.id));
        if(op==='cancel')return result(await engine!.cancel(data.id));
        if(op==='wait')return result(await engine!.wait(data.id,data.timeoutMs===undefined?30000:integer(data.timeoutMs,'timeout',300000)));
        return result(await engine!.logs(data.id,data.stream===undefined?'stdout':String(data.stream),data.offset===undefined?0:integer(data.offset,'offset',Number.MAX_SAFE_INTEGER),data.limit===undefined?4096:integer(data.limit,'limit',65536)));
      } catch(error) {const e=failure(error);return Response.json({version:PROTOCOL,ok:false,error:{code:e.code,message:e.message}},{status:e.code==='IPC_AUTH'?401:400});}
    }});
    info={version:VERSION,protocol:PROTOCOL,instance,scope,pid:process.pid,port:server.port!,token};
    const temp=join(state,`service.${instance}.tmp`);
    writeFileSync(temp,JSON.stringify(info),{mode:0o600,flag:'wx'});renameSync(temp,join(state,'service.json'));
    return {info,engine,close,stopped};
  }catch(error){await close();throw error;}
}
export async function ensure(path:string,self:readonly string[]) {
  const state=privateState(path);
  async function health() {
    const info=readRegistration(state);if(!info)return undefined;
    const h=await request(info,'health',{});
    if(h.scope!==info.scope||h.instance!==info.instance||h.protocol!==PROTOCOL||h.version!==VERSION)throw new CoreError('IPC_AUTH','Health identity mismatch');
    return info;
  }
  try{const found=await health();if(found)return found;}catch(e){if(!(e instanceof CoreError)||e.code!=='TRANSPORT_NOT_CONFIGURED')throw e;}
  const child=spawn(self[0]!,[...self.slice(1),'internal-serve','--state',state],{detached:true,stdio:'ignore',windowsHide:true});
  let spawnError=false;child.on('error',()=>spawnError=true);child.unref();
  const end=Date.now()+8000;
  while(Date.now()<end) {
    if(spawnError)throw new CoreError('TRANSPORT_NOT_CONFIGURED','Could not start daemon');
    try{const found=await health();if(found)return found;}catch(e){if(e instanceof CoreError&&['IPC_AUTH','VERSION_MISMATCH'].includes(e.code))throw e;}
    await pause(25);
  }
  throw new CoreError('TRANSPORT_NOT_CONFIGURED','Daemon startup timed out');
}
