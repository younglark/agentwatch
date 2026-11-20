import {openSync,closeSync,fstatSync,lstatSync,fchmodSync,constants} from 'node:fs';
import {dlopen,ptr} from 'bun:ffi';
import {CoreError} from '../domain.ts';

export type AdvisoryLockBinding={tryLock(fd:number):boolean;unlock(fd:number):void};
let loaded:AdvisoryLockBinding|undefined;
let override:AdvisoryLockBinding|undefined;
export function setAdvisoryLockBindingForTests(binding?:AdvisoryLockBinding){override=binding;if(!binding)loaded=undefined;}

function libcName(){
  if(process.platform==='linux')return 'libc.so.6';
  if(process.platform==='darwin')return 'libSystem.B.dylib';
  throw new CoreError('AUTH_NOT_CONFIGURED','Native advisory lock is unavailable on this platform');
}

function nativeBinding():AdvisoryLockBinding{
  if(override)return override;
  if(loaded)return loaded;
  try{
    if(process.platform==='win32')throw new Error('windows lock unverified');
    const lib=dlopen(libcName(),{
      fcntl:{args:['i32','i32','ptr'] as const,returns:'i32' as const},
      flock:{args:['i32','i32'] as const,returns:'i32' as const},
    });
    if(process.platform==='darwin'){
      const LOCK_EX=2,LOCK_UN=8,LOCK_NB=4;
      loaded={
        tryLock(fd){return lib.symbols.flock(fd,LOCK_EX|LOCK_NB)===0;},
        unlock(fd){lib.symbols.flock(fd,LOCK_UN);},
      };
    }else{
      const F_OFD_SETLK=37,F_WRLCK=1,F_UNLCK=2;
      const flock=(type:number)=>{
        const buf=new ArrayBuffer(32);
        const view=new DataView(buf);
        view.setInt16(0,type,true);
        view.setInt16(2,0,true);
        view.setBigInt64(8,0n,true);
        view.setBigInt64(16,0n,true);
        return buf;
      };
      loaded={
        tryLock(fd){return lib.symbols.fcntl(fd,F_OFD_SETLK,ptr(flock(F_WRLCK)))===0;},
        unlock(fd){lib.symbols.fcntl(fd,F_OFD_SETLK,ptr(flock(F_UNLCK)));},
      };
    }
    return loaded;
  }catch{
    throw new CoreError('AUTH_NOT_CONFIGURED','Native advisory lock is unavailable; credentials were left unchanged');
  }
}

/** Permanent lock file. Never truncate, replace, or unlink; the OS releases the lock when this process dies. */
export async function withAdvisoryLock<T>(file:string,fn:()=>Promise<T>,opts:{waitMs?:number;signal?:AbortSignal}={}):Promise<T>{
  const native=nativeBinding();
  const waitMs=opts.waitMs??30_000;
  if(!Number.isFinite(waitMs)||waitMs<0)throw new CoreError('AUTH_NOT_CONFIGURED','Invalid credential lock wait');
  const fd=openSync(file,constants.O_CREAT|constants.O_RDWR|(constants.O_NOFOLLOW??0),0o600);
  let held=false;
  try{
    const original=fstatSync(fd);
    if(lstatSync(file).isSymbolicLink()||!original.isFile()||original.nlink!==1)throw new CoreError('AUTH_NOT_CONFIGURED','Credential lock must be an independent regular file');
    if(process.platform!=='win32'){try{fchmodSync(fd,0o600);}catch{}}
    const deadline=Date.now()+waitMs;
    for(;;){
      if(opts.signal?.aborted)throw new CoreError('AUTH_NOT_CONFIGURED','Credential lock wait was canceled before the exchange started');
      try{held=native.tryLock(fd);}
      catch(error){
        if(!['EAGAIN','EBUSY'].includes((error as NodeJS.ErrnoException).code??''))throw new CoreError('AUTH_NOT_CONFIGURED','Native credential lock failed; credentials were left unchanged');
      }
      if(held){
        const current=lstatSync(file);
        if(current.isSymbolicLink()||original.ino!==current.ino||original.dev!==current.dev)throw new CoreError('AUTH_NOT_CONFIGURED','Credential lock path was replaced; refusing the exchange');
        return await fn();
      }
      if(Date.now()>=deadline)throw new CoreError('AUTH_NOT_CONFIGURED','Timed out waiting for the credential lock; the owner was left intact');
      await new Promise(r=>setTimeout(r,Math.min(25,Math.max(1,deadline-Date.now()))));
    }
  }finally{
    try{if(held)native.unlock(fd);}finally{closeSync(fd);}
  }
}
