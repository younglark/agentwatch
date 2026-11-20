import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createAuthSession} from '../src/auth/session.ts';
import {withCredentialLock,writeIndependentUnlocked} from '../src/auth/store.ts';
const jwt=(sub:string)=>`eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({sub,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.sig`;
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
const pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'aw-legacy-session-')),auth=join(root,'auth');mkdirSync(auth,{mode:0o700});
  const file=join(auth,'credentials.json');
  const env={HOME:root,PATH:'',AGENTWATCH_CREDENTIALS:file};
  const save=(backend:string)=>writeFileSync(file,JSON.stringify({version:1,backend,access_token:jwt('owner'),refresh_token:'SECRET_LEGACY_RT',client_id:'explicit',expires_at_ms:Date.now()+60_000,account_subject:'owner'}),{mode:0o600});
  return {root,file,env,save,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
const outcome=(p:ReturnType<ReturnType<typeof createAuthSession>['getAccessToken']>)=>p.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));

test('legacy credential without session_id: independent in-process sessions reuse one peer refresh',async()=>{
  const f=fixture(),received=gate(),release=gate();let exchanges=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,async fetch(){exchanges++;received.resolve();await release.promise;return Response.json({access_token:jwt('owner'),refresh_token:'SECRET_ROTATED_RT'});}});
  f.save(`http://127.0.0.1:${server.port}`);
  const first=outcome(createAuthSession({platform:'darwin',env:f.env}).getAccessToken());let second:ReturnType<typeof outcome>|undefined;
  try{
    await received.promise;
    second=outcome(createAuthSession({platform:'darwin',env:f.env}).getAccessToken());
    await pause(80);release.resolve();
    const results=await Promise.all([first,second]);
    expect(results.map(result=>result.ok)).toEqual([true,true]);expect(exchanges).toBe(1);
    const saved=JSON.parse(readFileSync(f.file,'utf8'));
    expect(saved.session_id).toBeString();expect(saved.session_id.length).toBeGreaterThan(0);
    expect(saved.refresh_token).toBe('SECRET_ROTATED_RT');
    for(const result of results)if(result.ok)expect(result.value!.accessToken).toBe(saved.access_token);
  }finally{release.resolve();await first;await second;server.stop(true);f.cleanup();}
});


test('legacy credential without session_id: another Bun process reuses peer refresh with one exchange',async()=>{
  const f=fixture(),received=gate(),release=gate();let exchanges=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,async fetch(){exchanges++;received.resolve();await release.promise;return Response.json({access_token:jwt('owner'),refresh_token:'SECRET_ROTATED_RT'});}});
  f.save(`http://127.0.0.1:${server.port}`);
  const first=outcome(createAuthSession({platform:'darwin',env:f.env}).getAccessToken());
  let child:Bun.Subprocess<'ignore','pipe','pipe'>|undefined;
  try{
    await received.promise;
    child=Bun.spawn([process.execPath,resolve('test/auth-legacy-child.ts')],{env:{...f.env,AGENTWATCH_TEST_READY:join(f.root,'ready')},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
    for(let i=0;i<200&&!existsSync(join(f.root,'ready'));i++)await pause(10);
    expect(existsSync(join(f.root,'ready'))).toBe(true);expect(exchanges).toBe(1);
    release.resolve();expect((await first).ok).toBe(true);
    const [out,err]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(await child.exited).toBe(0);expect(JSON.parse(out)).toEqual({ok:true});expect(exchanges).toBe(1);
    expect(out+err).not.toContain('SECRET_');expect(out+err).not.toContain(jwt('owner'));
    const saved=JSON.parse(readFileSync(f.file,'utf8'));expect(saved.session_id).toBeString();expect(saved.refresh_token).toBe('SECRET_ROTATED_RT');
  }finally{release.resolve();await first;if(child){child.kill();await child.exited;}server.stop(true);f.cleanup();}
});

for(const replacement of ['account','session','legacy-snapshot','logout','logout-restored'])test(`waiting peer rejects real ${replacement} instead of adopting a different session`,async()=>{
  const f=fixture(),received=gate(),release=gate();let exchanges=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,async fetch(){exchanges++;received.resolve();await release.promise;return Response.json({access_token:jwt('owner'),refresh_token:'SECRET_ROTATED_RT'});}});
  f.save(`http://127.0.0.1:${server.port}`);
  const first=outcome(createAuthSession({platform:'darwin',env:f.env}).getAccessToken());let second:ReturnType<typeof outcome>|undefined;
  try{
    await received.promise;
    second=outcome(createAuthSession({platform:'darwin',env:f.env}).getAccessToken());await pause(80);
    const old=JSON.parse(readFileSync(f.file,'utf8'));
    if(replacement.startsWith('logout'))await createAuthSession({platform:'darwin',env:f.env}).logout();
    if(replacement!=='logout')await withCredentialLock(f.env,async()=>{
      writeIndependentUnlocked(f.env,replacement==='logout-restored'?old:{...old,...(replacement==='legacy-snapshot'?{refresh_token:'SECRET_REPLACED_LEGACY_RT'}:{session_id:'replacement-session'}),...(replacement==='account'?{account_subject:'different-owner',access_token:jwt('different-owner')}:{}),expires_at_ms:Date.now()+3600_000});
    });
    const saved=existsSync(f.file)?readFileSync(f.file,'utf8'):undefined;
    release.resolve();const results=await Promise.all([first,second]);
    expect(results.map(result=>result.ok)).toEqual([false,false]);expect(exchanges).toBe(1);
    for(const result of results)if(!result.ok){expect(result.error.code).toBe('AUTH_NOT_CONFIGURED');expect(result.error.message).not.toContain('SECRET_');}
    expect(existsSync(f.file)?readFileSync(f.file,'utf8'):undefined).toBe(saved);
  }finally{release.resolve();await first;await second;server.stop(true);f.cleanup();}
});


for(const replacement of ['account','session','legacy-snapshot','logout','logout-restored'])test(`cross-process waiting peer rejects real ${replacement}`,async()=>{
  const f=fixture(),received=gate(),release=gate();let exchanges=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,async fetch(){exchanges++;received.resolve();await release.promise;return Response.json({access_token:jwt('owner'),refresh_token:'SECRET_ROTATED_RT'});}});
  f.save(`http://127.0.0.1:${server.port}`);
  const first=outcome(createAuthSession({platform:'darwin',env:f.env}).getAccessToken());let child:Bun.Subprocess<'ignore','pipe','pipe'>|undefined;
  try{
    await received.promise;
    child=Bun.spawn([process.execPath,resolve('test/auth-legacy-child.ts')],{env:{...f.env,AGENTWATCH_TEST_READY:join(f.root,'ready')},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
    for(let i=0;i<200&&!existsSync(join(f.root,'ready'));i++)await pause(10);
    expect(existsSync(join(f.root,'ready'))).toBe(true);
    const old=JSON.parse(readFileSync(f.file,'utf8'));
    if(replacement.startsWith('logout'))await createAuthSession({platform:'darwin',env:f.env}).logout();
    if(replacement!=='logout')await withCredentialLock(f.env,async()=>{
      writeIndependentUnlocked(f.env,replacement==='logout-restored'?old:{...old,...(replacement==='legacy-snapshot'?{refresh_token:'SECRET_REPLACED_LEGACY_RT'}:{session_id:'different-session'}),...(replacement==='account'?{account_subject:'different-owner',access_token:jwt('different-owner')}:{}),expires_at_ms:Date.now()+3600_000});
    });
    const saved=existsSync(f.file)?readFileSync(f.file,'utf8'):undefined;
    release.resolve();expect((await first).ok).toBe(false);
    const [out,err]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(await child.exited).toBe(0);expect(JSON.parse(out)).toEqual({ok:false,code:'AUTH_NOT_CONFIGURED'});
    expect(exchanges).toBe(1);expect(out+err).not.toContain('SECRET_');expect(out+err).not.toContain(jwt('owner'));
    expect(existsSync(f.file)?readFileSync(f.file,'utf8'):undefined).toBe(saved);
  }finally{release.resolve();await first;if(child){child.kill();await child.exited;}server.stop(true);f.cleanup();}
});
