import { spawn } from 'node:child_process';
import { closeSync,readFileSync } from 'node:fs';
import { openLogFile } from './log-files.ts';
import { type RunInput,normalize } from './domain.ts';
export interface Child {
  pid:number;
  exited:Promise<number|null>;
  cancel():void;
}
export type Executor=(input:RunInput,files:{stdout:string;stderr:string})=>Child;
export type Verifier=(input:RunInput)=>Promise<void>;
/** Cooperative-then-force grace. Matches Grok Build SIGTERM_GRACE (1s); do not change it to OpenCode's 5s. */
export const CANCEL_GRACE_MS=1000;
function errno(error:unknown) {
  return error!==null&&typeof error==='object'&&'code' in error?(error as {code?:unknown}).code:undefined;
}
function parsePgrp(stat:string) {
  const pgrp=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[2]);
  return Number.isInteger(pgrp)&&pgrp>0?pgrp:undefined;
}
/** Linux: the caller's process group, used to refuse killpg of our own group. */
export function callerProcessGroup() {
  if(process.platform!=='linux')return undefined;
  try{return parsePgrp(readFileSync('/proc/self/stat','utf8'));}catch{return undefined;}
}
/**
 * Enroll a POSIX group-leader pid as a killpg target.
 * Mirrors Grok Build `ProcessGroupId::new`: reject 0 (killpg own-group), 1 (init),
 * the caller's pgid, and values that cannot be passed to killpg (non-integers, > i32::MAX).
 * On Linux also require `/proc/<pid>` to show the process is the leader of that group.
 * A vendor that later `setsid`/`setpgid`s a descendant leaves that descendant outside
 * this group; outer group signals do not reach it, and we do not chase it.
 */
export function enrollProcessGroup(pid:number,callerPgrp=callerProcessGroup()) {
  if(!Number.isInteger(pid)||pid<=1||pid>0x7fffffff)return undefined;
  if(callerPgrp!==undefined&&pid===callerPgrp)return undefined;
  if(process.platform==='linux'){
    try{
      const pgrp=parsePgrp(readFileSync(`/proc/${pid}/stat`,'utf8'));
      if(pgrp!==pid)return undefined;
    }catch{return undefined;}
  }
  return pid;
}
/**
 * Signal an already-enrolled POSIX process group. Signal 0 only probes liveness.
 * A PGID is not reused while any member remains, so ESRCH means the group is gone
 * and that number must not be signaled again.
 */
type GroupSignal='ok'|'gone'|'denied';
function signalProcessGroup(pgid:number,signal:NodeJS.Signals|0):GroupSignal {
  if(!Number.isInteger(pgid)||pgid<=1||pgid>0x7fffffff)return 'denied';
  if(pgid===callerProcessGroup())return 'denied';
  try{process.kill(-pgid,signal);return 'ok';}
  catch(error){
    const code=errno(error);
    // ESRCH: the group is gone and the PGID must not be reused for signaling.
    // EPERM is not gone (Grok Build members_live treats non-ESRCH as unknown).
    if(code==='ESRCH')return 'gone';
    if(code==='EPERM')return 'denied';
    throw error;
  }
}
// No shell and no session/resume interpretation. Production remains verifier-gated.
export function spawnArgv(command:readonly string[],cwd:string,files:{stdout:string;stderr:string}):Child {
  const out=openLogFile(files.stdout,'append');let err:number|undefined;
  try {
    err=openLogFile(files.stderr,'append');
    // POSIX: new session+group (setsid), same idea as Grok Build detach + killpg.
    // Windows: Node `detached` opens a new console, so it is not used. Grok Build
    // contains a Windows tree with a Job Object and JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    // (xai-tty-utils ProcessGroup). We do not ship that FFI here: it cannot be natively
    // verified on this Linux host, and a guessed Win32 struct layout would be unsafe.
    // See README for KILL_ON_JOB_CLOSE crash semantics (not keep-alive; not Unix parity).
    const posix=process.platform!=='win32';
    const child=spawn(command[0]!,command.slice(1),{cwd,stdio:['ignore',out,err],windowsHide:true,detached:posix});
    const closed=new Promise<number|null>((ok,fail)=>{child.once('error',fail);child.once('close',code=>ok(code));});
    if(!child.pid){void closed.catch(()=>{});throw new Error('Process could not be started');}
    const pid=child.pid;
    // Enroll once; drop the id when the group is gone so a reused PGID cannot be killpg'd
    // (Grok Build ProcessScope drops the owner Arc at reap for the same reason).
    let pgid=posix?enrollProcessGroup(pid):undefined;
    let phase:'idle'|'term'|'killed'='idle';
    let forceTimer:ReturnType<typeof setTimeout>|undefined;
    let watchTimer:ReturnType<typeof setInterval>|undefined;
    let settleTree!:()=>void;
    const treeSettled=new Promise<void>(resolve=>{settleTree=resolve;});
    const groupGone=()=>{
      if(pgid===undefined)return true;
      if(signalProcessGroup(pgid,0)==='gone'){pgid=undefined;return true;}
      return false;
    };
    const finishTree=()=>{
      if(forceTimer){clearTimeout(forceTimer);forceTimer=undefined;}
      if(watchTimer){clearInterval(watchTimer);watchTimer=undefined;}
      settleTree();
    };
    const force=()=>{
      forceTimer=undefined;
      phase='killed';
      if(pgid!==undefined)signalProcessGroup(pgid,'SIGKILL');
      else try{child.kill('SIGKILL');}catch{}
      if(groupGone()){finishTree();return;}
      const end=Date.now()+200;
      watchTimer=setInterval(()=>{if(groupGone()||Date.now()>=end)finishTree();},10);
    };
    const cancel=()=>{
      if(phase==='killed')return;
      if(phase==='term'){
        // Repeated cancel may re-send TERM but must not restart the grace deadline.
        if(pgid!==undefined)signalProcessGroup(pgid,'SIGTERM');
        else try{child.kill('SIGTERM');}catch{}
        return;
      }
      phase='term';
      if(pgid!==undefined){
        if(signalProcessGroup(pgid,'SIGTERM')==='gone'){pgid=undefined;phase='killed';finishTree();return;}
      }else{
        try{child.kill('SIGTERM');}catch{}
      }
      // Keep this timer referenced: if the root has already closed, it is what
      // still drives SIGKILL for leftovers still in the enrolled group.
      forceTimer=setTimeout(force,CANCEL_GRACE_MS);
    };
    const exited=closed.then(async code=>{
      if(phase==='idle')return code;
      if(groupGone()){finishTree();return code;}
      // Root close is not group exit. Poll so a cooperative tree can settle
      // during the grace and clear the force timer, instead of waiting the
      // full 1s and SIGKILLing a tree that already accepted SIGTERM.
      if(!watchTimer)watchTimer=setInterval(()=>{if(groupGone())finishTree();},10);
      await treeSettled;
      return code;
    });
    return {pid,exited,cancel};
  } finally {closeSync(out);if(err!==undefined)closeSync(err);}
}
export const nativeExecutor:Executor=(input,files)=>{const valid=normalize(input);return spawnArgv(valid.argv,valid.cwd,files);};
