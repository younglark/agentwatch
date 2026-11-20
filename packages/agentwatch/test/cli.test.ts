import { test,expect } from 'bun:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon,request,readRegistration } from '../src/service.ts';
import { fixtureExecutor } from './fixtures.ts';
test('authenticated loopback protocol isolates states and runs a fixture through the real ledger',async()=>{
  const a=mkdtempSync(join(tmpdir(),'aw-service-')),b=mkdtempSync(join(tmpdir(),'aw-service-'));
  const host=await startDaemon(a,{verify:async()=>{},execute:fixtureExecutor,testOnly:true});
  const other=await startDaemon(b,{verify:async()=>{},execute:fixtureExecutor,testOnly:true});
  try {
    expect(host).not.toBeNull();expect(await startDaemon(a)).toBeUndefined();
    const info=readRegistration(a)!,infoB=readRegistration(b)!;
    await expect(request({...info,port:infoB.port},'health',{})).rejects.toMatchObject({code:'IPC_AUTH'});
    await expect(request({...info,token:'incorrect'},'health',{})).rejects.toMatchObject({code:'IPC_AUTH'});
    await expect(request({...info,scope:'another-state'},'health',{})).rejects.toMatchObject({code:'IPC_AUTH'});
    const task=await request(info,'run',{request_id:'rpc-1',bot:'test',cwd:a,argv:['claude','space arg','你好','']});
    const done=await request(info,'wait',{id:task.id,timeoutMs:5000});expect(done.task.state).toBe('succeeded');
    await expect(request(infoB,'status',{id:task.id})).rejects.toMatchObject({code:'NOT_FOUND'});
  }finally{await host?.close();await other?.close();rmSync(a,{recursive:true,force:true});rmSync(b,{recursive:true,force:true});}
});
import { commandContracts } from './command-contracts.ts';
import { resolve } from 'node:path';
commandContracts('source CLI',[process.execPath,resolve('src/main.ts')],[process.execPath,resolve('test/host.ts')]);

test('local protocol accepts only own domain error codes and rejects prototype names',async()=>{
  const {exitCodes}=await import('../src/domain.ts');let code='INTERNAL';
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({version:1,ok:false,error:{code,message:'test error'}})});
  const info={version:'0.1.0',protocol:1,instance:'test',scope:'test',pid:process.pid,port:server.port!,token:'synthetic-test-token'};
  try {
    for(code of Object.keys(exitCodes))await expect(request(info,'health',{})).rejects.toMatchObject({code});
    for(code of ['constructor','toString','__proto__','FUTURE_UNRECOGNIZED'])await expect(request(info,'health',{})).rejects.toMatchObject({code:'INTERNAL'});
  }finally{server.stop(true);}
});
