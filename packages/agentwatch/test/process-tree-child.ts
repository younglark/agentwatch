// Test-only process tree. Not imported by production main/serve.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

function pgrp(pid=process.pid) {
  const text=readFileSync(`/proc/${pid}/stat`,'utf8');
  const fields=text.slice(text.lastIndexOf(')')+2).split(' ');
  return Number(fields[2]);
}

function record(pidfile:string,role:string) {
  appendFileSync(pidfile,JSON.stringify({role,pid:process.pid,ppid:process.ppid,pgrp:pgrp()})+'\n');
}

function ignoreTerm() {process.on('SIGTERM',()=>{});}

function stay() {setInterval(()=>{},1000);}

function start(role:string,mode:string,pidfile:string,self:string) {
  if(mode==='ignore-term'||mode==='root-exit-keep-grand'||(mode==='escape-setsid'&&role==='grand'))ignoreTerm();

  if(role==='grand'){record(pidfile,'grand');stay();return;}

  if(role==='mid'){
    record(pidfile,'mid');
    const grand=spawn(process.execPath,[self,'grand',mode,pidfile],{stdio:'ignore',detached:mode==='escape-setsid'});
    if(!grand.pid)throw new Error('grand could not be started');
    if(mode==='escape-setsid')grand.unref();
    stay();
    return;
  }

  if(role!=='root')throw new Error('unknown role');
  record(pidfile,'root');

  if(mode==='root-exit-keep-grand'){
    const grand=spawn(process.execPath,[self,'grand',mode,pidfile],{stdio:'ignore',detached:false});
    if(!grand.pid)throw new Error('grand could not be started');
    const end=Date.now()+2000;
    while(Date.now()<end){
      try{if(readFileSync(pidfile,'utf8').includes('"role":"grand"'))break;}catch{}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
    }
    process.exit(0);
  }

  if(mode==='natural-exit'){
    setTimeout(()=>process.exit(0),80);
    return;
  }

  spawn(process.execPath,[self,'mid',mode,pidfile],{stdio:'ignore',detached:false});
  stay();
}

start(process.argv[2]!,process.argv[3]!,process.argv[4]!,process.argv[1]!);
