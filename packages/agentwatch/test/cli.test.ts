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
