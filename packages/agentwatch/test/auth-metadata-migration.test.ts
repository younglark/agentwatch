import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createAuthSession} from '../src/auth/session.ts';
import {withRefreshExchangeLock,advanceLoginGeneration,withCredentialLock,writeIndependentUnlocked} from '../src/auth/store.ts';
const jwt=(sub?:string)=>`eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({...(sub?{sub}:{}),exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.sig`;
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
const pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const outcome=(p:ReturnType<ReturnType<typeof createAuthSession>['getAccessToken']>)=>p.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'aw-metadata-matrix-')),auth=join(root,'auth');mkdirSync(auth,{mode:0o700});
  const file=join(auth,'credentials.json');const env:NodeJS.ProcessEnv={HOME:root,PATH:'',AGENTWATCH_CREDENTIALS:file};
  const save=(backend:string,extra:Record<string,unknown>={})=>writeFileSync(file,JSON.stringify({version:1,backend,access_token:'SECRET_OPAQUE_ACCESS',refresh_token:'SECRET_OLD_RT',client_id:'explicit',expires_at_ms:Date.now()+60_000,...extra}),{mode:0o600});
  return {root,file,env,save,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
async function waitReady(root:string){for(let i=0;i<200&&!existsSync(join(root,'ready'));i++)await pause(10);expect(existsSync(join(root,'ready'))).toBe(true);}

for(const crossProcess of [false,true])for(const hasId of [false,true])for(const hasSubject of [false,true])for(const hasSub of [false,true])for(const oldKind of hasSub?['jwt-sub']:['opaque','jwt-no-sub'])for(const returnedSub of !hasSubject&&!hasSub?[true,false]:[true])test(`metadata matrix ${crossProcess?'cross-process':'multi-session'} id=${hasId} binding=${hasSubject} accessSub=${hasSub} old=${oldKind} newSub=${returnedSub} reuses exactly one refresh`,async()=>{
  const f=fixture(),received=gate(),release=gate();let exchanges=0;const returnedAccess=jwt(returnedSub?'owner':undefined);
  const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,async fetch(){exchanges++;received.resolve();await release.promise;return Response.json({access_token:returnedAccess,refresh_token:'SECRET_NEW_RT'});}});
  // Include both stored client binding and the supported env-only client binding migration.
  const envOnlyClient=hasId!==hasSubject;if(envOnlyClient)f.env.AGENTWATCH_CLIENT_ID='explicit';
  f.save(`http://127.0.0.1:${server.port}${!hasSub&&!hasSubject?'/':''}`,{access_token:oldKind==='opaque'?'SECRET_OPAQUE_ACCESS':jwt(hasSub?'owner':undefined),...(hasId?{session_id:'existing-session'}:{}),...(hasSubject?{account_subject:'owner'}:{}),...(envOnlyClient?{client_id:undefined}:{})});
  const first=outcome(createAuthSession({platform:'darwin',env:f.env}).getAccessToken());
  let second:ReturnType<typeof outcome>|undefined,child:Bun.Subprocess<'ignore','pipe','pipe'>|undefined;
  try{
    await received.promise;
    if(crossProcess){child=Bun.spawn([process.execPath,resolve('test/auth-legacy-child.ts')],{env:{...f.env,AGENTWATCH_TEST_EXPECTED_ACCESS_SHA256:createHash('sha256').update(returnedAccess).digest('hex'),AGENTWATCH_TEST_READY:join(f.root,'ready')},stdin:'ignore',stdout:'pipe',stderr:'pipe'});await waitReady(f.root);}
    else{second=outcome(createAuthSession({platform:'darwin',env:f.env}).getAccessToken());await pause(80);}
    release.resolve();expect((await first).ok).toBe(true);
    if(child){const [out,err]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(await child.exited).toBe(0);expect(JSON.parse(out)).toEqual({ok:true});expect(out+err).not.toContain('SECRET_');expect(out+err).not.toContain(returnedAccess);}
    else{const result=await second!;expect(result.ok).toBe(true);if(result.ok)expect(result.value.accessToken).toBe(returnedAccess);}
    expect(exchanges).toBe(1);
    const saved=JSON.parse(readFileSync(f.file,'utf8'));expect(saved.account_subject).toBe(returnedSub?'owner':undefined);expect(saved.client_id).toBe('explicit');expect(saved.refresh_token).toBe('SECRET_NEW_RT');
    if(hasId)expect(saved.session_id).toBe('existing-session');else expect(saved.session_id).toBeString();
  }finally{release.resolve();await first;await second;if(child){child.kill();await child.exited;}server.stop(true);f.cleanup();}
});

for(const crossProcess of [false,true])for(const change of ['account','session','backend','client','unproven-sub','logout-restored'])test(`metadata unbound ${crossProcess?'cross-process':'multi-session'} rejects ${change} without a peer result from exact snapshot`,async()=>{
  const f=fixture(),received=gate(),release=gate();let exchanges=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,async fetch(){exchanges++;received.resolve();await release.promise;return Response.json({access_token:jwt('owner'),refresh_token:'SECRET_NEW_RT'});}});
  let foreignExchanges=0;const other=change==='backend'?Bun.serve({hostname:'127.0.0.1',port:0,fetch(){foreignExchanges++;return Response.json({access_token:jwt('owner')});}}):undefined;
  f.save(`http://127.0.0.1:${server.port}`,{session_id:'existing-session',...(change==='account'?{account_subject:'owner'}:{})});
  const first=outcome(createAuthSession({platform:'darwin',env:f.env}).getAccessToken());let second:ReturnType<typeof outcome>|undefined,child:Bun.Subprocess<'ignore','pipe','pipe'>|undefined;
  try{
    await received.promise;
    if(crossProcess){child=Bun.spawn([process.execPath,resolve('test/auth-legacy-child.ts')],{env:{...f.env,AGENTWATCH_TEST_READY:join(f.root,'ready')},stdin:'ignore',stdout:'pipe',stderr:'pipe'});await waitReady(f.root);}
    else{second=outcome(createAuthSession({platform:'darwin',env:f.env}).getAccessToken());await pause(80);}
    const old=JSON.parse(readFileSync(f.file,'utf8'));
    if(change==='logout-restored')await createAuthSession({platform:'darwin',env:f.env}).logout();
    await withCredentialLock(f.env,async()=>writeIndependentUnlocked(f.env,{...old,...(change==='account'||change==='unproven-sub'?{account_subject:'different-owner',access_token:jwt('different-owner')}:{}),...(change==='session'?{session_id:'different-session'}:{}),...(change==='backend'?{backend:`http://127.0.0.1:${other!.port}`} :{}),...(change==='client'?{client_id:'different-client'}:{})}));
    const replacement=readFileSync(f.file,'utf8');release.resolve();expect((await first).ok).toBe(false);
    if(child){const [out,err]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(await child.exited).toBe(0);expect(JSON.parse(out)).toEqual({ok:false,code:'AUTH_NOT_CONFIGURED'});expect(out+err).not.toContain('SECRET_');}
    else{const result=await second!;expect(result.ok).toBe(false);if(!result.ok)expect(result.error.code).toBe('AUTH_NOT_CONFIGURED');}
    expect(exchanges).toBe(1);expect(foreignExchanges).toBe(0);expect(readFileSync(f.file,'utf8')).toBe(replacement);
  }finally{release.resolve();await first;await second;if(child){child.kill();await child.exited;}server.stop(true);other?.stop(true);f.cleanup();}
});


for(const crossProcess of [false,true])for(const tamper of ['parent-snapshot','generation','access-result','refresh-result','parent-proof','result-proof'])test(`peer receipt ${crossProcess?'cross-process':'multi-session'} rejects tampered ${tamper}`,async()=>{
  const f=fixture();let exchanges=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){exchanges++;return Response.json({access_token:jwt('owner'),refresh_token:'SECRET_NEW_RT'});}});
  f.save(`http://127.0.0.1:${server.port}`,{session_id:'existing-session'});
  const old=JSON.parse(readFileSync(f.file,'utf8'));
  let lock:Promise<unknown>|undefined,second:ReturnType<typeof outcome>|undefined,child:Bun.Subprocess<'ignore','pipe','pipe'>|undefined;
  const held=gate(),release=gate();
  try{
    await createAuthSession({platform:'darwin',env:f.env}).getAccessToken();
    const saved=JSON.parse(readFileSync(f.file,'utf8'));expect(saved.refresh_proof).toBeDefined();
    await withCredentialLock(f.env,async()=>{
      writeIndependentUnlocked(f.env,{...old,...(tamper==='parent-snapshot'?{refresh_token:'SECRET_DIFFERENT_PARENT_RT'}:{})});
      if(tamper==='generation')advanceLoginGeneration(f.env);
    });
    lock=withRefreshExchangeLock(f.env,async()=>{held.resolve();await release.promise;});await held.promise;
    if(crossProcess){child=Bun.spawn([process.execPath,resolve('test/auth-legacy-child.ts')],{env:{...f.env,AGENTWATCH_TEST_READY:join(f.root,'ready')},stdin:'ignore',stdout:'pipe',stderr:'pipe'});await waitReady(f.root);}
    else{second=outcome(createAuthSession({platform:'darwin',env:f.env}).getAccessToken());await pause(80);}
    const changed={...saved,...(tamper==='access-result'?{access_token:saved.access_token.replace(/sig$/,'different-signature')} :{}),...(tamper==='refresh-result'?{refresh_token:'SECRET_DIFFERENT_RESULT_RT'}:{}),refresh_proof:{...saved.refresh_proof,...(tamper==='parent-proof'?{parent:'0'.repeat(64)}:{}),...(tamper==='result-proof'?{result:'0'.repeat(64)}:{})}};
    await withCredentialLock(f.env,async()=>writeIndependentUnlocked(f.env,changed));const written=readFileSync(f.file,'utf8');release.resolve();await lock;
    if(child){const [out,err]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(await child.exited).toBe(0);expect(JSON.parse(out)).toEqual({ok:false,code:'AUTH_NOT_CONFIGURED'});expect(out+err).not.toContain('SECRET_');}
    else{const result=await second!;expect(result.ok).toBe(false);if(!result.ok)expect(result.error.code).toBe('AUTH_NOT_CONFIGURED');}
    expect(exchanges).toBe(1);expect(readFileSync(f.file,'utf8')).toBe(written);
  }finally{release.resolve();await lock;await second;if(child){child.kill();await child.exited;}server.stop(true);f.cleanup();}
});
