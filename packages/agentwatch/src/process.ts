import { spawn } from 'node:child_process';
import { closeSync } from 'node:fs';
import { openLogFile } from './log-files.ts';
import { type RunInput,normalize } from './domain.ts';
export interface Child {
  pid:number;
  exited:Promise<number|null>;
  cancel():void;
}
export type Executor=(input:RunInput,files:{stdout:string;stderr:string})=>Child;
export type Verifier=(input:RunInput)=>Promise<void>;
// No shell and no session/resume interpretation. Production remains verifier-gated.
export function spawnArgv(command:readonly string[],cwd:string,files:{stdout:string;stderr:string}):Child {
  const out=openLogFile(files.stdout,'append');let err:number|undefined;
  try {
    err=openLogFile(files.stderr,'append');
    const child=spawn(command[0]!,command.slice(1),{cwd,stdio:['ignore',out,err],windowsHide:true});
    const exited=new Promise<number|null>((ok,fail)=>{child.once('error',fail);child.once('close',code=>ok(code));});
    if(!child.pid){void exited.catch(()=>{});throw new Error('Process could not be started');}
    return {pid:child.pid,exited,cancel(){
      child.kill('SIGTERM');
      const timer=setTimeout(()=>child.kill('SIGKILL'),1000);timer.unref();
      void exited.finally(()=>clearTimeout(timer)).catch(()=>{});
    }};
  } finally {closeSync(out);if(err!==undefined)closeSync(err);}
}
export const nativeExecutor:Executor=(input,files)=>{const valid=normalize(input);return spawnArgv(valid.argv,valid.cwd,files);};
