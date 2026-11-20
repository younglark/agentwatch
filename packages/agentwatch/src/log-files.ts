import { constants,openSync,closeSync,fstatSync,realpathSync,readlinkSync } from 'node:fs';
import { basename,dirname,isAbsolute,join,resolve } from 'node:path';
import { CoreError } from './domain.ts';

const taskId=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function taskLogFile(state:string,id:string,stream:string) {
  if(!taskId.test(id)||!['stdout','stderr'].includes(stream))throw new CoreError('IPC_AUTH','Invalid task log identity');
  return join(state,id+'.'+stream);
}
export function openLogFile(file:string,mode:'append'):number;
export function openLogFile(file:string,mode:'read'):number|undefined;
export function openLogFile(file:string,mode:'read'|'append'):number|undefined {
  // Linux-only guarantee: pin the verified directory, then open the final name
  // relative to that descriptor. No path stat/open race or symlink fallback.
  if(process.platform!=='linux'||!constants.O_NOFOLLOW||!constants.O_DIRECTORY)
    throw new CoreError('IPC_AUTH','Secure task logs require Linux no-follow descriptor access');
  let directory:number|undefined;
  try {
    const state=dirname(file),name=basename(file),match=/^(.+)\.(stdout|stderr)$/.exec(name);
    if(!isAbsolute(file)||resolve(file)!==file||!match||!taskId.test(match[1]!)||realpathSync(state)!==state)
      throw new Error('Invalid log path');
    directory=openSync(state,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    const dir=fstatSync(directory);
    if(!dir.isDirectory()||dir.uid!==process.getuid?.()||(dir.mode&0o077)!==0||readlinkSync('/proc/self/fd/'+directory)!==state)
      throw new Error('Unsafe log directory');
    const flags=constants.O_NOFOLLOW|constants.O_NONBLOCK|(mode==='read'?constants.O_RDONLY:constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND);
    let fd:number;
    try{fd=openSync('/proc/self/fd/'+directory+'/'+name,flags,0o600);}
    catch(error){if(mode==='read'&&(error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
    try {
      const stat=fstatSync(fd);
      if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw new Error('Unsafe log inode');
      return fd;
    }catch(error){closeSync(fd);throw error;}
  }catch{throw new CoreError('IPC_AUTH','Unsafe task log access rejected');}
  finally{if(directory!==undefined)closeSync(directory);}
}
