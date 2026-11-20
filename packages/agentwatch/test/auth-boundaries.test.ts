import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createCipheriv,randomBytes} from 'node:crypto';
import {loadDesktopAccess} from '../src/auth/desktop.ts';
import {createAuthSession} from '../src/auth/session.ts';
import {refreshIndependentTokens,rememberAmbiguous,clearAmbiguousForTests} from '../src/auth/refresh.ts';
import {pollOnce,pollForLogin} from '../src/auth/login.ts';
import {startDaemon,request} from '../src/service.ts';
import {setAuthPlatformForTests} from '../src/auth/platform.ts';
import {connectRpc} from '../src/connect-client.ts';
import {originUrl} from '../src/auth/urls.ts';
import {withCredentialLock} from '../src/auth/store.ts';
import {openStorage} from '../src/storage.ts';
import {createTaskEngine} from '../src/engine.ts';
import {connectNotifications} from '../src/notifications.ts';
const jwt=(claims:Record<string,unknown>)=>`eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const asFetch=(fn:(input:any,init?:RequestInit)=>Promise<Response>)=>fn as typeof fetch;
const tick=()=>new Promise<void>(r=>setTimeout(r,10));
function gate(){let resolve!:(value?:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve};}
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'aw-auth-boundary-')),auth=join(root,'auth');mkdirSync(auth,{mode:0o700});
  const file=join(auth,'credentials.json');
  const env={HOME:root,PATH:'',AGENTWATCH_CREDENTIALS:file,AGENTWATCH_API_BASE:'http://127.0.0.1:1'};
  const save=(extra:Record<string,unknown>={})=>writeFileSync(file,JSON.stringify({version:1,backend:'http://127.0.0.1:1',access_token:jwt({sub:'owner',exp:Math.floor(Date.now()/1000)+60}),refresh_token:'SECRET_RT',client_id:'explicit',expires_at_ms:Date.now()+60_000,account_subject:'owner',...extra}),{mode:0o600});
  return {root,auth,file,env,save,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

test('Spec1 Windows DPAPI and Local State OSCrypt-GCM use access only, never expose a refresh cipher',()=>{
  const f=fixture();
  try{
    const file=join(f.root,'sand-secrets.json'),local=join(f.root,'Local State');
    const token=jwt({sub:'win-owner',exp:Math.floor(Date.now()/1000)+3600});
    const save=(cipher:Buffer)=>writeFileSync(file,JSON.stringify({'cursor-accounts':{active:'win',accounts:{win:{'cursor-access-token':cipher.toString('base64'),'cursor-refresh-token':'NEVER_DECRYPT_THIS_REFRESH'}}}}));
    const calls:string[]=[];
    const key=randomBytes(32),wrapped=Buffer.from('fixture-wrapped-key');
    const dpapi=(blob:Buffer)=>{calls.push(blob.toString());if(blob.equals(wrapped))return key;if(blob.toString()==='fixture-direct-dpapi')return Buffer.from(token);return undefined;};
    save(Buffer.from('fixture-direct-dpapi'));
    const opts={platform:'win32' as const,env:{...f.env,AGENTWATCH_SECRETS_FILE:file},windows:{unprotect:dpapi}};
    expect(loadDesktopAccess(opts).token).toBe(token);
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
    save(Buffer.concat([Buffer.from('v10'),nonce,cipher.update(token),cipher.final(),cipher.getAuthTag()]));
    writeFileSync(local,JSON.stringify({os_crypt:{encrypted_key:Buffer.concat([Buffer.from('DPAPI'),wrapped]).toString('base64')}}));
    expect(loadDesktopAccess(opts).token).toBe(token);
    expect(calls).not.toContain('NEVER_DECRYPT_THIS_REFRESH');
    expect(calls).toContain('fixture-wrapped-key');
    expect(()=>loadDesktopAccess({...opts,windows:{unprotect:()=>undefined}})).toThrow();
    expect(()=>loadDesktopAccess({...opts,platform:'darwin'})).toThrow();
  }finally{f.cleanup();}
});

test('Spec2 cross-process logout invalidates an in-flight login completion, including after new login',async()=>{
  for(const restart of [false,true]){
    const f=fixture(),received=gate(),release=gate();
    let hits=0;
    const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,async fetch(){
      hits++;if(hits===1){received.resolve();await release.promise;return Response.json({accessToken:'SECRET_LOGIN_ACCESS',refreshToken:'SECRET_LOGIN_REFRESH'});}
      return Response.json({error:'sign_in_policy_violation'},{status:403});
    }});
    const env={...f.env,AGENTWATCH_API_BASE:`http://127.0.0.1:${server.port}`};
    const child=Bun.spawn([process.execPath,resolve('test/auth-race-child.ts')],{env,stdout:'pipe',stderr:'pipe'});
    try{
      await received.promise;
      const sibling=createAuthSession({platform:'darwin',env});
      await sibling.logout();
      if(restart){await sibling.beginLogin();await sibling.waitForLogin().catch(()=>{});}
      release.resolve();
      const [out,err]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
      expect(await child.exited).toBe(0);expect(JSON.parse(out).completed).toBe(false);
      expect(existsSync(f.file)).toBe(false);expect(out+err).not.toContain('SECRET_');
    }finally{release.resolve();child.kill();await child.exited;server.stop(true);f.cleanup();}
  }
});

test('Spec3 explicit shouldLogout/policy outrank HTTP 429/5xx and ambiguous invalid_grant protection',async()=>{
  for(const status of [200,400,429,500,503])for(const body of [{shouldLogout:true},{error:'sign_in_policy_violation'},{shouldLogout:true,error:'invalid_grant'}]){
    const f=fixture();f.save({session_id:'ambiguous'});
    rememberAmbiguous('ambiguous','SECRET_RT',Date.now());
    try{
      const session=createAuthSession({platform:'darwin',env:f.env,fetch:asFetch(async()=>Response.json(body,{status}))});
      await expect(session.getAccessToken()).rejects.toMatchObject({details:{revoked:true,canFallback:false}});
      expect(existsSync(f.file)).toBe(false);
    }finally{clearAmbiguousForTests();f.cleanup();}
  }
});

test('Spec4 non-TTY login prints only a public URL to stderr and returns pending JSON promptly while daemon polls',async()=>{
  const f=fixture(),old={...process.env};let host:Awaited<ReturnType<typeof startDaemon>>;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(null,{status:404})});
  try{
    Object.assign(process.env,f.env,{AGENTWATCH_API_BASE:`http://127.0.0.1:${server.port}`});
    setAuthPlatformForTests('darwin');
    host=await startDaemon(join(f.root,'state'));
    const child=Bun.spawn([process.execPath,resolve('test/auth-cli-child.ts'),'login','--state',join(f.root,'state')],{env:{...process.env},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
    const code=await Promise.race([child.exited,new Promise<number>(r=>setTimeout(()=>{child.kill();r(-1);},900))]);
    const [out,err]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({command:'login',data:{status:'pending'}});
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(err.trim()).toStartWith('https://cursor.com/loginDeepControl?');
    expect(err+out).not.toContain('verifier');expect(err+out).not.toContain('SECRET_');
    expect((await request(host!.info,'login_status',{})).status).toBe('pending');
  }finally{
    if(host!){await request(host!.info,'logout',{});await host!.close();}
    server.stop(true);setAuthPlatformForTests(undefined);
    for(const key of Object.keys(process.env))if(!(key in old))delete process.env[key];Object.assign(process.env,old);f.cleanup();
  }
});

test('Spec5 login HTTP bounds stalled headers and body, cancels readers, and has a total deadline including sleeps',async()=>{
  for(const phase of ['headers','success-body','policy-body']){
    let canceled=false;
    const fetch=asFetch(async()=>phase==='headers'?new Promise<Response>(()=>{}):new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){canceled=true;}}),{status:phase==='policy-body'?403:200}));
    const opts={apiBase:'http://127.0.0.1:1',uuid:'public',verifier:'SECRET_VERIFIER',fetch,requestDeadlineMs:30};
    const result=await Promise.race([pollOnce(opts),new Promise<any>(r=>setTimeout(()=>r({status:'hung'}),180))]);
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('SECRET_VERIFIER');
    if(phase!=='headers')expect(canceled).toBe(true);
  }
  const result=await Promise.race([pollForLogin({apiBase:'http://127.0.0.1:1',uuid:'public',verifier:'SECRET_VERIFIER',fetch:asFetch(async()=>new Response(null,{status:404})),totalDeadlineMs:35,sleep:()=>new Promise<void>(()=>{})}),new Promise<any>(r=>setTimeout(()=>r({status:'hung'}),180))]);
  expect(result.status).toBe('timeout');
});

test('Spec6 terminal poll failure is observable, clears pending and a later login creates a fresh challenge',async()=>{
  for(const kind of ['policy','xai','errors','timeout']){
    const f=fixture();
    const fetch=asFetch(async()=>kind==='policy'?Response.json({error:'sign_in_policy_violation'},{status:403}):kind==='xai'?Response.json({xaiAccessToken:'SECRET_XAI'}):new Response(null,{status:kind==='timeout'?404:500}));
    const session=createAuthSession({platform:'darwin',env:f.env,poll:{fetch,maxTries:2,sleep:async()=>{}}});
    try{
      const first=await session.beginLogin();
      await expect(session.waitForLogin()).rejects.toMatchObject({code:'AUTH_NOT_CONFIGURED'});
      await tick();
      expect(session.loginStatus().status).toBe('failed');
      expect(existsSync(join(f.auth,'pending-login.json'))).toBe(false);
      const peer=createAuthSession({platform:'darwin',env:f.env,poll:{fetch,maxTries:2,sleep:async()=>{}}});
      expect(peer.loginStatus().status).toBe('failed');
      const next=await peer.beginLogin();expect(next.reused).toBe(false);expect(next.uuid).not.toBe(first.uuid);
      await peer.waitForLogin().catch(()=>{});
    }finally{await session.logout();f.cleanup();}
  }
});

test('Spec7 bound subject cannot rotate to missing/opaque/different sub and binding cannot be dropped',async()=>{
  for(const access of ['OPAQUE_TOKEN',jwt({exp:Math.floor(Date.now()/1000)+3600}),jwt({sub:'other',exp:Math.floor(Date.now()/1000)+3600})]){
    const f=fixture();f.save({expires_at_ms:Date.now()-1});
    try{
      const before=readFileSync(f.file,'utf8');
      const session=createAuthSession({platform:'darwin',env:f.env,fetch:asFetch(async()=>Response.json({access_token:access,refresh_token:'NEW_SECRET_RT'}))});
      await expect(session.getAccessToken()).rejects.toMatchObject({details:{kind:'subject_mismatch'}});
      expect(readFileSync(f.file,'utf8')).toBe(before);
    }finally{f.cleanup();}
  }
  const f=fixture();f.save({expires_at_ms:Date.now()-1});
  try{
    const next=jwt({sub:'owner',exp:Math.floor(Date.now()/1000)+3600});
    const session=createAuthSession({platform:'darwin',env:f.env,fetch:asFetch(async()=>Response.json({access_token:next}))});
    expect((await session.getAccessToken()).accessToken).toBe(next);
    expect(JSON.parse(readFileSync(f.file,'utf8'))).toMatchObject({account_subject:'owner',refresh_token:'SECRET_RT'});
  }finally{f.cleanup();}
});

test('Spec8 pre-canceled callers start no refresh; canceled caller detaches while shared refresh completes once',async()=>{
  const f=fixture();f.save();const release=gate();let calls=0;
  const next=jwt({sub:'owner',exp:Math.floor(Date.now()/1000)+3600});
  const session=createAuthSession({platform:'darwin',env:f.env,fetch:asFetch(async()=>{calls++;await release.promise;return Response.json({access_token:next,refresh_token:'ROTATED_SECRET_RT'});})});
  try{
    const pre=new AbortController();pre.abort();
    const result=await Promise.race([session.getAccessToken(pre.signal).then(()=> 'resolved',()=> 'aborted'),new Promise<string>(r=>setTimeout(()=>r('hung'),100))]);
    expect(result).toBe('aborted');expect(calls).toBe(0);
    const controller=new AbortController();
    const waiting=session.getAccessToken(controller.signal);await tick();const peer=session.getAccessToken();
    controller.abort();
    expect(await Promise.race([waiting.then(()=> 'resolved',()=> 'aborted'),new Promise<string>(r=>setTimeout(()=>r('hung'),100))])).toBe('aborted');
    release.resolve();
    expect((await peer).accessToken).toBe(next);expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(f.file,'utf8')).refresh_token).toBe('ROTATED_SECRET_RT');
  }finally{release.resolve();f.cleanup();}
});

test('Spec8 Connect overall 3s deadline includes authentication; abandoned write is never dispatched or replayed',async()=>{
  const f=fixture(),old={...process.env},release=gate();let exchanges=0,writes=0;
  const next=jwt({sub:'owner',exp:Math.floor(Date.now()/1000)+3600});
  const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,async fetch(req){
    if(new URL(req.url).pathname==='/oauth/token'){exchanges++;await release.promise;return Response.json({access_token:next,refresh_token:'BG_SECRET_RT'});}
    writes++;return Response.json({delivery:2});
  }});
  try{
    f.save({backend:`http://127.0.0.1:${server.port}`});
    Object.assign(process.env,f.env);setAuthPlatformForTests('darwin');
    const canceled=new AbortController();canceled.abort();
    await expect(connectRpc('SendGrokBotUserMessage',{},canceled.signal)).rejects.toBeDefined();
    expect(exchanges).toBe(0);expect(writes).toBe(0);
    const started=Date.now();
    const outcome=await Promise.race([connectRpc('SendGrokBotUserMessage',{}).then(()=> 'resolved',()=> 'deadline'),new Promise<string>(r=>setTimeout(()=>r('hung'),3400))]);
    expect(outcome).toBe('deadline');expect(Date.now()-started).toBeLessThan(3350);
    expect(exchanges).toBe(1);expect(writes).toBe(0);
    release.resolve();
    for(let i=0;i<100&&JSON.parse(readFileSync(f.file,'utf8')).refresh_token!=='BG_SECRET_RT';i++)await tick();
    expect(JSON.parse(readFileSync(f.file,'utf8')).refresh_token).toBe('BG_SECRET_RT');
    expect(writes).toBe(0);
  }finally{
    release.resolve();await tick();server.stop(true);setAuthPlatformForTests(undefined);
    for(const key of Object.keys(process.env))if(!(key in old))delete process.env[key];Object.assign(process.env,old);f.cleanup();
  }
},10_000);

test('Standards Bun URL.hostname includes IPv6 brackets and numeric IPv6 loopback is allowed, not arbitrary HTTP',()=>{
  expect(new URL('http://[::1]:4321').hostname).toBe('[::1]');
  expect(originUrl('http://[::1]:4321','test')).toBe('http://[::1]:4321');
  expect(originUrl('https://cursor.com','test')).toBe('https://cursor.com');
  for(const value of ['http://[::2]','http://[2001:db8::1]','http://localhost','http://example.com'])expect(()=>originUrl(value,'test')).toThrow();
});

test('Standards desktop result names encryption provenance as source, not API backend, and omits refresh cipher',()=>{
  const f=fixture();
  try{
    const file=join(f.root,'sand-secrets.json');
    writeFileSync(file,JSON.stringify({'cursor-accounts':{accounts:{one:{'cursor-access-token':Buffer.from('fixture-access').toString('base64'),'cursor-refresh-token':'SECRET_UNUSED'}}}}));
    const result=loadDesktopAccess({platform:'win32',env:{...f.env,AGENTWATCH_SECRETS_FILE:file},windows:{unprotect:()=>Buffer.from('SYNTHETIC_ACCESS_TOKEN')}});
    expect(result).toMatchObject({source:'windows-dpapi'});
    expect(result).not.toHaveProperty('backend');expect(result).not.toHaveProperty('refreshTokenCipher');
  }finally{f.cleanup();}
});

test('Spec8 cancel during credential lock wait is prompt and does not destroy shared refresh ownership',async()=>{
  const f=fixture();f.save();const acquired=gate(),release=gate();let calls=0;
  const held=withCredentialLock(f.env,async()=>{acquired.resolve();await release.promise;});
  const next=jwt({sub:'owner',exp:Math.floor(Date.now()/1000)+3600});
  const session=createAuthSession({platform:'darwin',env:f.env,fetch:asFetch(async()=>{calls++;return Response.json({access_token:next});})});
  try{
    await acquired.promise;
    const controller=new AbortController();
    const caller=session.getAccessToken(controller.signal);await tick();controller.abort();
    expect(await Promise.race([caller.then(()=> 'resolved',()=> 'canceled'),new Promise<string>(r=>setTimeout(()=>r('hung'),100))])).toBe('canceled');
    expect(calls).toBe(0);release.resolve();await held;
    expect((await session.getAccessToken()).accessToken).toBe(next);expect(calls).toBe(1);
  }finally{release.resolve();await held;f.cleanup();}
});

test('Spec3/8 refresh revocation or uncertain notification never alters task success or replays a send',async()=>{
  for(const mode of ['revoked','uncertain']){
    const f=fixture(),old={...process.env};let refreshes=0,sends=0;
    const next=jwt({sub:'owner',exp:Math.floor(Date.now()/1000)+3600});
    const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
      const path=new URL(req.url).pathname;
      if(path==='/oauth/token'){refreshes++;return Response.json(mode==='revoked'?{shouldLogout:true}:{access_token:next});}
      if(path.endsWith('/SendGrokBotUserMessage')){sends++;return Response.json({code:'unauthenticated'},{status:401});}
      return Response.json({status:'GROK_BOT_SEND_STATUS_NOT_FOUND'});
    }});
    let db:Awaited<ReturnType<typeof openStorage>>|undefined,engine:Awaited<ReturnType<typeof createTaskEngine>>|undefined;
    try{
      f.save({backend:`http://127.0.0.1:${server.port}`});Object.assign(process.env,f.env);setAuthPlatformForTests('darwin');
      delete process.env.AGENTWATCH_CLIENT_ID;delete process.env.AGENTWATCH_OAUTH_CLIENT_ID;
      const state=join(f.root,'state');mkdirSync(state,{mode:0o700});db=await openStorage(state);
      engine=await createTaskEngine({state,store:db.store,verify:async()=>{},execute:()=>({pid:123456,exited:Promise.resolve(0),cancel(){}}),notifications:connectNotifications});
      const task=await engine.run({request_id:'refresh-notice-'+mode,bot:'test-bot',cwd:f.root,argv:['claude']});
      expect((await engine.wait(task.id,2000)).task.state).toBe('succeeded');
      for(let i=0;i<200;i++){
        const status=await engine.status(task.id);
        if((mode==='revoked'&&refreshes===1&&!existsSync(f.file))||(mode==='uncertain'&&status.notification.reconciliation_attempts===1))break;
        await tick();
      }
      const status=await engine.status(task.id);expect(status.state).toBe('succeeded');expect(refreshes).toBe(1);
      expect(sends).toBe(mode==='revoked'?0:1);
      expect(status.notification.state).toBe(mode==='revoked'?'pending':'unknown');
      expect(JSON.stringify(status)).not.toContain('SECRET_');
    }finally{
      await engine?.close();await db?.close();server.stop(true);setAuthPlatformForTests(undefined);
      for(const key of Object.keys(process.env))if(!(key in old))delete process.env[key];Object.assign(process.env,old);f.cleanup();
    }
  }
});
