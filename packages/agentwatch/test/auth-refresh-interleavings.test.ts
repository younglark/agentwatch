import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createAuthSession} from '../src/auth/session.ts';
import {refreshIndependentTokens,clearAmbiguousForTests} from '../src/auth/refresh.ts';
import {readIndependentCredentials} from '../src/auth/store.ts';
const jwt=(sub:string)=>`eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({sub,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.sig`;
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
const pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const bounded=<T>(work:Promise<T>,ms=500)=>Promise.race([work,pause(ms).then(()=>undefined)]);
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'aw-refresh-interleave-')),auth=join(root,'auth');mkdirSync(auth,{mode:0o700});
  const file=join(auth,'credentials.json');
  const env={HOME:root,PATH:'',AGENTWATCH_CREDENTIALS:file,AGENTWATCH_API_BASE:'http://127.0.0.1:1'};
  const save=(backend:string)=>writeFileSync(file,JSON.stringify({version:1,backend,access_token:jwt('old-owner'),refresh_token:'SECRET_OLD_RT',client_id:'explicit',expires_at_ms:Date.now()+60_000,account_subject:'old-owner',session_id:'old-session',revision:7}),{mode:0o600});
  return {root,auth,file,env,save,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
function refreshReply(mode:string){
  if(mode==='revoked')return Response.json({shouldLogout:true});
  if(mode==='transient')return Response.json({error:'temporarily_unavailable'},{status:503});
  return Response.json({access_token:jwt('old-owner'),refresh_token:'SECRET_ROTATED_OLD_RT'});
}

for(const mode of ['revoked','success','transient'])test(`Recheck1 old refresh ${mode} preserves a newer pending login in another process`,async()=>{
  const f=fixture(),pollReceived=gate(),pollRelease=gate();let exchanges=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,async fetch(req){
    if(new URL(req.url).pathname==='/auth/poll'){
      pollReceived.resolve();await pollRelease.promise;return Response.json({accessToken:jwt('new-owner'),refreshToken:'SECRET_NEW_LOGIN_RT'});
    }
    exchanges++;return refreshReply(mode);
  }});
  const api=`http://127.0.0.1:${server.port}`;f.env.AGENTWATCH_API_BASE=api;f.save(api);
  const child=Bun.spawn([process.execPath,resolve('test/auth-race-child.ts')],{env:f.env,stdout:'pipe',stderr:'pipe'});
  try{
    await pollReceived.promise;
    const pending=readFileSync(join(f.auth,'pending-login.json'),'utf8'),generation=readFileSync(join(f.auth,'login-generation.json'),'utf8');
    const old=createAuthSession({platform:'darwin',env:f.env});
    await old.getAccessToken().catch(()=>{});
    expect(existsSync(join(f.auth,'pending-login.json'))).toBe(true);
    expect(readFileSync(join(f.auth,'pending-login.json'),'utf8')).toBe(pending);
    expect(readFileSync(join(f.auth,'login-generation.json'),'utf8')).toBe(generation);
    pollRelease.resolve();
    const [out,err]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(await child.exited).toBe(0);expect(JSON.parse(out).completed).toBe(true);
    expect(JSON.parse(readFileSync(f.file,'utf8'))).toMatchObject({account_subject:'new-owner',refresh_token:'SECRET_NEW_LOGIN_RT'});
    expect(exchanges).toBe(1);expect(out+err).not.toContain('SECRET_');
  }finally{pollRelease.resolve();child.kill();await child.exited;server.stop(true);f.cleanup();}
});

for(const mode of ['revoked','success','transient'])test(`Recheck1 delayed old refresh ${mode} cannot overwrite or clear a completed new login`,async()=>{
  const f=fixture(),refreshReceived=gate(),refreshRelease=gate();
  const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,async fetch(req){
    if(new URL(req.url).pathname==='/auth/poll')return Response.json({accessToken:jwt('new-owner'),refreshToken:'SECRET_NEW_LOGIN_RT'});
    refreshReceived.resolve();await refreshRelease.promise;return refreshReply(mode);
  }});
  const api=`http://127.0.0.1:${server.port}`;f.env.AGENTWATCH_API_BASE=api;f.save(api);
  const old=createAuthSession({platform:'darwin',env:f.env});
  const result=old.getAccessToken().then(()=>({resolved:true}),error=>({resolved:false,error}));
  let started:Promise<unknown>|undefined,completed:Promise<unknown>|undefined;
  try{
    await refreshReceived.promise;
    const newer=createAuthSession({platform:'darwin',env:f.env});
    started=newer.beginLogin();expect(await bounded(started)).toBeDefined();
    completed=newer.waitForLogin();expect(await bounded(completed)).toBeDefined();
    const saved=readFileSync(f.file,'utf8');expect(JSON.parse(saved).account_subject).toBe('new-owner');
    refreshRelease.resolve();expect((await result).resolved).toBe(false);
    expect(readFileSync(f.file,'utf8')).toBe(saved);
    expect(newer.loginStatus().status).toBe('completed');
  }finally{refreshRelease.resolve();await result;await started?.catch(()=>{});await completed?.catch(()=>{});server.stop(true);f.cleanup();}
});

test('Recheck2 native HTTP headers followed by stalled body respects 40ms deadline and records ambiguity',async()=>{
  const f=fixture();let canceled=false;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,fetch:()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel(){canceled=true;}}),{headers:{'content-type':'application/json'}})});
  try{
    f.save(`http://127.0.0.1:${server.port}`);const before=readFileSync(f.file,'utf8');
    const started=Date.now();let caught:any;
    try{await refreshIndependentTokens(readIndependentCredentials(f.env),'explicit',{deadlineMs:40});}catch(error){caught=error;}
    expect(caught).toMatchObject({details:{kind:'timeout',ambiguous:true}});
    expect(Date.now()-started).toBeLessThan(500);
    for(let i=0;i<50&&!canceled;i++)await pause(10);expect(canceled).toBe(true);
    expect(readFileSync(f.file,'utf8')).toBe(before);expect(JSON.stringify(caught)).not.toContain('SECRET_');
  }finally{clearAmbiguousForTests();server.stop(true);f.cleanup();}
});

for(const explicit of ['logout','policy'])test(`Recheck2 body timeout then invalid_grant across session calls keeps credentials until explicit ${explicit}`,async()=>{
  const f=fixture();let calls=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,fetch:()=>{
    calls++;
    if(calls===1)return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}}),{headers:{'content-type':'application/json'}});
    if(calls===2)return Response.json({error:'invalid_grant'},{status:400});
    return Response.json(explicit==='logout'?{shouldLogout:true,error:'invalid_grant'}:{error:'sign_in_policy_violation'},{status:503});
  }});
  const api=`http://127.0.0.1:${server.port}`;f.save(api);
  // Force refresh failure rather than fallback so both caller-visible error classifications are observable.
  writeFileSync(f.file,JSON.stringify({...JSON.parse(readFileSync(f.file,'utf8')),expires_at_ms:Date.now()-1}),{mode:0o600});
  let attempts=0;
  const fetcher=((url:any,init?:RequestInit)=>fetch(url,{...init,signal:++attempts===1?AbortSignal.any([init!.signal!,AbortSignal.timeout(40)]):init?.signal})) as typeof fetch;
  const session=createAuthSession({platform:'darwin',env:f.env,fetch:fetcher});
  try{
    const before=readFileSync(f.file,'utf8');
    let first:any,second:any;
    try{await session.getAccessToken();}catch(error){first=error;}
    expect(first).toMatchObject({details:{kind:'timeout',ambiguous:true}});
    try{await session.getAccessToken();}catch(error){second=error;}
    expect(second).toMatchObject({details:{ambiguous:true}});
    expect(second.details.revoked).not.toBe(true);
    expect(readFileSync(f.file,'utf8')).toBe(before);
    expect(JSON.stringify(first)+JSON.stringify(second)).not.toContain('SECRET_');
    await expect(session.getAccessToken()).rejects.toMatchObject({details:{revoked:true,canFallback:false}});
    expect(existsSync(f.file)).toBe(false);expect(calls).toBe(3);
  }finally{clearAmbiguousForTests();server.stop(true);f.cleanup();}
});

for(const phase of ['headers','body'])test(`Recheck2 ${phase} connection interruption protects subsequent invalid_grant without leaking secrets`,async()=>{
  const f=fixture();f.save('http://127.0.0.1:1');let calls=0;
  const fetcher=(async(_url:any,_init?:RequestInit)=>{
    if(++calls>1)return Response.json({error:'invalid_grant'},{status:400});
    if(phase==='headers')throw new TypeError('synthetic connection interrupted');
    return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));queueMicrotask(()=>controller.error(new TypeError('synthetic body interrupted')));}}));
  }) as typeof fetch;
  const session=createAuthSession({platform:'darwin',env:f.env,fetch:fetcher});
  try{
    const before=readFileSync(f.file,'utf8');
    // Old access is still valid: both ambiguous attempts must preserve and return it.
    expect((await session.getAccessToken()).accessToken).toBe(JSON.parse(before).access_token);
    expect((await session.getAccessToken()).accessToken).toBe(JSON.parse(before).access_token);
    expect(readFileSync(f.file,'utf8')).toBe(before);expect(calls).toBe(2);
  }finally{clearAmbiguousForTests();f.cleanup();}
});

for(const mode of ['revoked','success','transient'])test(`Recheck1 explicit logout during delayed ${mode} refresh cannot resurrect credentials or pending`,async()=>{
  const f=fixture(),received=gate(),release=gate();
  const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,async fetch(){received.resolve();await release.promise;return refreshReply(mode);}});
  f.save(`http://127.0.0.1:${server.port}`);
  const session=createAuthSession({platform:'darwin',env:f.env});
  const refresh=session.getAccessToken().then(()=>true,()=>false);
  let logout:Promise<unknown>|undefined;
  try{
    await received.promise;logout=session.logout();expect(await bounded(logout)).toBeDefined();
    const generation=readFileSync(join(f.auth,'login-generation.json'),'utf8');
    release.resolve();expect(await refresh).toBe(false);
    expect(existsSync(f.file)).toBe(false);expect(existsSync(join(f.auth,'pending-login.json'))).toBe(false);
    expect(readFileSync(join(f.auth,'login-generation.json'),'utf8')).toBe(generation);
  }finally{release.resolve();await refresh;await logout;server.stop(true);f.cleanup();}
});
