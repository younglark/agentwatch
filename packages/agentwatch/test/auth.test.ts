import {afterEach,expect,test} from 'bun:test';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setAuthPlatformForTests} from '../src/auth/platform.ts';
import {setAuthPollHooksForTests,createAuthSession} from '../src/auth/session.ts';
import {clearAmbiguousForTests,REFRESH_EARLY_MS,rememberAmbiguous} from '../src/auth/refresh.ts';
import {setAdvisoryLockBindingForTests} from '../src/auth/lock.ts';
import {buildLoginUrl,generateLoginChallenge} from '../src/auth/login.ts';
import {encryptOscryptV10,LINUX_BASIC_PASSWORD,LINUX_PBKDF2_ITERATIONS} from '../src/auth/oscrypt.ts';
import {listSecretsCandidates} from '../src/auth/desktop.ts';
import {connectRpc} from '../src/connect-client.ts';
import {startDaemon,request} from '../src/service.ts';
import {CoreError} from '../src/domain.ts';

function unsignedJwt(claims:Record<string,unknown>){
  const header=Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url');
  const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}
function sandbox(){
  const root=mkdtempSync(join(tmpdir(),'aw-auth-'));
  const home=join(root,'home');mkdirSync(home,{mode:0o700});
  const auth=join(home,'.agentwatch','auth');mkdirSync(auth,{recursive:true,mode:0o700});chmodSync(auth,0o700);
  const credentials=join(auth,'credentials.json');
  const env:NodeJS.ProcessEnv={HOME:home,PATH:join(root,'bin'),XDG_CONFIG_HOME:join(home,'.config'),APPDATA:join(home,'AppData','Roaming'),AGENTWATCH_CREDENTIALS:credentials};
  mkdirSync(env.PATH!,{recursive:true});mkdirSync(env.XDG_CONFIG_HOME!,{recursive:true});mkdirSync(env.APPDATA!,{recursive:true});
  return {root,home,auth,credentials,env,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
function writeCreds(file:string,overrides:Record<string,unknown>={}){
  writeFileSync(file,JSON.stringify({version:1,backend:'http://127.0.0.1:1',access_token:'SYNTHETIC_ACCESS',refresh_token:'SYNTHETIC_REFRESH',client_id:'synthetic-client',expires_at_ms:Date.now()+3_600_000,...overrides}),{mode:0o600});
}
function writeDesktop(home:string,token:string,env:NodeJS.ProcessEnv){
  const dir=join(env.XDG_CONFIG_HOME||join(home,'.config'),'Grok Bot');mkdirSync(dir,{recursive:true,mode:0o700});
  const file=join(dir,'sand-secrets.json');
  const access=encryptOscryptV10(token,LINUX_BASIC_PASSWORD,LINUX_PBKDF2_ITERATIONS).toString('base64');
  const refresh=encryptOscryptV10('SECRET_DESKTOP_REFRESH',LINUX_BASIC_PASSWORD,LINUX_PBKDF2_ITERATIONS).toString('base64');
  writeFileSync(file,JSON.stringify({version:1,'cursor-accounts':{active:'acct-1',accounts:{'acct-1':{'cursor-access-token':access,'cursor-refresh-token':refresh}}}}),{mode:0o600});
  return file;
}

afterEach(()=>{
  setAuthPlatformForTests(undefined);
  setAuthPollHooksForTests(undefined);
  setAdvisoryLockBindingForTests(undefined);
  clearAmbiguousForTests();
});

test('macOS login URL uses the cli preset and never includes the verifier or team param',()=>{
  const challenge=generateLoginChallenge();
  const url=buildLoginUrl('https://cursor.com',challenge);
  const parsed=new URL(url);
  expect(parsed.origin).toBe('https://cursor.com');
  expect(parsed.pathname).toBe('/loginDeepControl');
  expect(parsed.searchParams.get('challenge')).toBe(challenge.challenge);
  expect(parsed.searchParams.get('uuid')).toBe(challenge.uuid);
  expect(parsed.searchParams.get('mode')).toBe('login');
  expect(parsed.searchParams.get('redirectTarget')).toBe('cli');
  expect(parsed.searchParams.has('supportsSelectedTeamLogin')).toBe(false);
  expect(url).not.toContain(challenge.verifier);
  expect(url).not.toContain('device');
});

test('injected darwin polls 404 then persists tokens, and stderr printing omits the verifier',async()=>{
  const fx=sandbox();
  let hits=0,verifier='' ;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
    const url=new URL(req.url);
    expect(url.pathname).toBe('/auth/poll');
    expect(url.searchParams.get('uuid')).toBeTruthy();
    verifier=url.searchParams.get('verifier')||'';
    hits+=1;
    if(hits===1)return new Response(null,{status:404});
    return Response.json({accessToken:'access-from-poll',refreshToken:'refresh-from-poll'});
  }});
  const err:string[]=[];const print=(s:string)=>err.push(s);
  try{
    fx.env.AGENTWATCH_API_BASE=`http://127.0.0.1:${server.port}`;
    fx.env.AGENTWATCH_WEBSITE='https://cursor.com';
    const session=createAuthSession({platform:'darwin',env:fx.env,home:fx.home,poll:{sleep:async()=>{}}});
    const started=await session.beginLogin();
    print(started.login_url);
    expect(started.login_url).toContain('/loginDeepControl?');
    expect(started.login_url).toContain('redirectTarget=cli');
    expect(started.login_url).not.toContain('supportsSelectedTeamLogin');
    await session.waitForLogin();
    const saved=JSON.parse(readFileSync(fx.credentials,'utf8'));
    expect(saved.access_token).toBe('access-from-poll');
    expect(saved.refresh_token).toBe('refresh-from-poll');
    const text=err.join('\n')+JSON.stringify(session.loginStatus());
    expect(text).toContain(started.login_url);
    expect(verifier.length).toBeGreaterThan(10);
    expect(text).not.toContain(verifier);
    expect(text).not.toContain('refresh-from-poll');
    expect(text).not.toContain('access-from-poll');
    await session.logout();
    expect(existsSync(fx.credentials)).toBe(false);
  }finally{server.stop(true);fx.cleanup();}
});

test('injected darwin policy denial, xAI identity, timeout and consecutive poll errors fail closed',async()=>{
  const cases:Array<{name:string;handle:(n:number)=>Response;expect:RegExp;hooks?:{maxTries?:number}}>=[
    {name:'policy',handle:()=>Response.json({error:'sign_in_policy_violation'},{status:403}),expect:/policy/i},
    {name:'xai',handle:()=>Response.json({xaiAccessToken:'SECRET_XAI',accessToken:'should-not-use',refreshToken:'SECRET_REFRESH'}),expect:/xAI/i},
    {name:'timeout',handle:()=>new Response(null,{status:404}),expect:/timed out/i,hooks:{maxTries:3}},
    {name:'errors',handle:()=>new Response('nope',{status:500}),expect:/HTTP 500|failed/i},
  ];
  for(const item of cases){
    const fx=sandbox();let n=0;
    const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>item.handle(++n)});
    try{
      fx.env.AGENTWATCH_API_BASE=`http://127.0.0.1:${server.port}`;
      fx.env.AGENTWATCH_WEBSITE='https://cursor.com';
      const session=createAuthSession({platform:'darwin',env:fx.env,home:fx.home,poll:{sleep:async()=>{},maxTries:item.hooks?.maxTries??5,maxConsecutiveErrors:3}});
      await session.beginLogin();
      await expect(session.waitForLogin()).rejects.toMatchObject({code:'AUTH_NOT_CONFIGURED'});
      try{await session.waitForLogin();}catch(error){expect((error as Error).message).toMatch(item.expect);expect(JSON.stringify(error)).not.toContain('SECRET_');}
      expect(existsSync(fx.credentials)).toBe(false);
    }finally{server.stop(true);fx.cleanup();}
  }
});

test('refresh rotates 300s early, persists the new pair, and keeps a still-valid token on network failure',async()=>{
  const fx=sandbox();
  const now=1_700_000_000_000;
  const current=unsignedJwt({sub:'user-1',exp:Math.floor((now+REFRESH_EARLY_MS-1000)/1000)});
  const rotated=unsignedJwt({sub:'user-1',exp:Math.floor((now+3_600_000)/1000)});
  writeCreds(fx.credentials,{access_token:current,refresh_token:'old-refresh',account_subject:'user-1',expires_at_ms:now+REFRESH_EARLY_MS-1000,backend:'http://127.0.0.1:1'});
  const oauth:{body:any}[]=[];
  let mode:'ok'|'network'='ok';
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
    expect(new URL(req.url).pathname).toBe('/oauth/token');
    const body=await req.json();oauth.push({body});
    if(mode==='network')return new Response(null,{status:503});
    expect(body).toEqual({client_id:'synthetic-client',grant_type:'refresh_token',refresh_token:'old-refresh'});
    return Response.json({access_token:rotated,refresh_token:'new-refresh'});
  }});
  try{
    writeFileSync(fx.credentials,JSON.stringify({...JSON.parse(readFileSync(fx.credentials,'utf8')),backend:`http://127.0.0.1:${server.port}`}),{mode:0o600});
    const session=createAuthSession({platform:'darwin',env:fx.env,home:fx.home,now:()=>now,fetch:((input,init)=>fetch(input,init)) as typeof fetch});
    const first=await session.getAccessToken();
    expect(first.accessToken).toBe(rotated);
    expect(JSON.parse(readFileSync(fx.credentials,'utf8'))).toMatchObject({access_token:rotated,refresh_token:'new-refresh'});
    writeFileSync(fx.credentials,JSON.stringify({...JSON.parse(readFileSync(fx.credentials,'utf8')),access_token:current,refresh_token:'old-refresh',expires_at_ms:now+REFRESH_EARLY_MS-1000}),{mode:0o600});
    mode='network';
    const fallback=await session.getAccessToken();
    expect(fallback.accessToken).toBe(current);
    expect(JSON.parse(readFileSync(fx.credentials,'utf8')).refresh_token).toBe('old-refresh');
    expect(oauth).toHaveLength(2);
  }finally{server.stop(true);fx.cleanup();}
});

test('expired token without client_id fails; valid token without client_id still works; client_id is never guessed from a JWT',async()=>{
  const fx=sandbox();
  try{
    writeCreds(fx.credentials,{client_id:undefined,refresh_token:'SECRET_REFRESH',access_token:'SYNTHETIC_ACCESS',expires_at_ms:Date.now()+60_000});
    delete fx.env.AGENTWATCH_CLIENT_ID;delete fx.env.AGENTWATCH_OAUTH_CLIENT_ID;
    const session=createAuthSession({platform:'darwin',env:fx.env,home:fx.home,fetch:Object.assign(async()=>{throw new Error('refresh should not run');},{preconnect(){}}) as typeof fetch});
    expect((await session.getAccessToken()).accessToken).toBe('SYNTHETIC_ACCESS');
    const expired=unsignedJwt({exp:Math.floor(Date.now()/1000)-10,azp:'guessed-client',aud:'guessed-client',client_id:'guessed-client'});
    writeCreds(fx.credentials,{client_id:undefined,access_token:expired,refresh_token:'SECRET_REFRESH',expires_at_ms:Date.now()-10});
    await expect(session.getAccessToken()).rejects.toMatchObject({code:'AUTH_NOT_CONFIGURED'});
    try{await session.getAccessToken();}catch(error){expect((error as Error).message).not.toContain('SECRET_REFRESH');expect((error as Error).message).not.toContain('guessed-client');}
  }finally{fx.cleanup();}
});

test('shouldLogout does not fall back to the previous token, and a subject mismatch is refused',async()=>{
  const fx=sandbox();
  const now=Date.now();
  const current=unsignedJwt({sub:'user-1',exp:Math.floor((now+60_000)/1000)});
  const other=unsignedJwt({sub:'user-2',exp:Math.floor((now+3_600_000)/1000)});
  let body:any={shouldLogout:true};
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(){return Response.json(body);}});
  try{
    writeCreds(fx.credentials,{access_token:current,refresh_token:'rt',account_subject:'user-1',expires_at_ms:now+30_000,backend:`http://127.0.0.1:${server.port}`});
    const session=createAuthSession({platform:'darwin',env:fx.env,home:fx.home,now:()=>now,fetch:((i,init)=>fetch(i,init)) as typeof fetch});
    await expect(session.getAccessToken()).rejects.toMatchObject({code:'AUTH_NOT_CONFIGURED'});
    expect(existsSync(fx.credentials)).toBe(false);
    writeCreds(fx.credentials,{access_token:current,refresh_token:'rt',account_subject:'user-1',expires_at_ms:now+30_000,backend:`http://127.0.0.1:${server.port}`});
    body={access_token:other,refresh_token:'new-rt'};
    const kept=await session.getAccessToken();
    expect(kept.accessToken).toBe(current);
    expect(JSON.parse(readFileSync(fx.credentials,'utf8')).access_token).toBe(current);
  }finally{server.stop(true);fx.cleanup();}
});

test('conflicting client id env vars fail closed and invalid_grant after an ambiguous timeout keeps credentials',async()=>{
  const fx=sandbox();
  const now=Date.now();
  const current=unsignedJwt({sub:'user-1',exp:Math.floor((now+60_000)/1000)});
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({error:'invalid_grant'},{status:400})});
  try{
    fx.env.AGENTWATCH_CLIENT_ID='a';fx.env.AGENTWATCH_OAUTH_CLIENT_ID='b';
    writeCreds(fx.credentials,{access_token:current,expires_at_ms:now-1,backend:`http://127.0.0.1:${server.port}`});
    const conflict=createAuthSession({platform:'darwin',env:fx.env,home:fx.home});
    await expect(conflict.getAccessToken()).rejects.toMatchObject({code:'AUTH_NOT_CONFIGURED'});
    fx.env.AGENTWATCH_OAUTH_CLIENT_ID='a';
    writeCreds(fx.credentials,{access_token:current,refresh_token:'rt-ambiguous',client_id:'a',session_id:'sess',account_subject:'user-1',expires_at_ms:now+30_000,backend:`http://127.0.0.1:${server.port}`});
    rememberAmbiguous('sess','rt-ambiguous',now);
    const session=createAuthSession({platform:'darwin',env:fx.env,home:fx.home,now:()=>now,fetch:((i,init)=>fetch(i,init)) as typeof fetch});
    const kept=await session.getAccessToken();
    expect(kept.accessToken).toBe(current);
    expect(existsSync(fx.credentials)).toBe(true);
  }finally{server.stop(true);fx.cleanup();}
});

test('write RPCs are not automatically replayed after a backend 401, even when refresh would succeed',async()=>{
  const fx=sandbox();
  const now=Date.now();
  const current=unsignedJwt({sub:'user-1',exp:Math.floor((now+3_600_000)/1000)});
  const methods:string[]=[];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
    const path=new URL(req.url).pathname;
    methods.push(path);
    if(path.endsWith('/oauth/token'))return Response.json({access_token:unsignedJwt({sub:'user-1',exp:Math.floor((now+7_200_000)/1000)}),refresh_token:'new'});
    return Response.json({code:'unauthenticated'},{status:401});
  }});
  const previousHome=process.env.HOME,previousCreds=process.env.AGENTWATCH_CREDENTIALS,previousBase=process.env.AGENTWATCH_API_BASE;
  try{
    writeCreds(fx.credentials,{access_token:current,refresh_token:'rt',client_id:'synthetic-client',expires_at_ms:now+3_600_000,backend:`http://127.0.0.1:${server.port}`});
    setAuthPlatformForTests('darwin');
    process.env.HOME=fx.home;process.env.AGENTWATCH_CREDENTIALS=fx.credentials;process.env.AGENTWATCH_API_BASE=`http://127.0.0.1:${server.port}`;
    process.env.AGENTWATCH_CLIENT_ID='synthetic-client';
    await expect(connectRpc('SendGrokBotUserMessage',{agentId:'bot',messageId:'m',sessionId:'',text:'t',sentAtMs:'1'})).rejects.toMatchObject({code:'unauthenticated'});
    expect(methods.filter(p=>p.endsWith('/SendGrokBotUserMessage'))).toHaveLength(1);
    expect(methods.some(p=>p.endsWith('/oauth/token'))).toBe(false);
  }finally{
    server.stop(true);fx.cleanup();setAuthPlatformForTests(undefined);
    if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;
    if(previousCreds===undefined)delete process.env.AGENTWATCH_CREDENTIALS;else process.env.AGENTWATCH_CREDENTIALS=previousCreds;
    if(previousBase===undefined)delete process.env.AGENTWATCH_API_BASE;else process.env.AGENTWATCH_API_BASE=previousBase;
    delete process.env.AGENTWATCH_CLIENT_ID;
  }
});

test('Linux desktop reads a peanuts fixture, never refreshes, and macOS ignores sand-secrets overrides',async()=>{
  const fx=sandbox();
  const file=writeDesktop(fx.home,'SYNTHETIC_DESKTOP_TOKEN',fx.env);
  const oauth:string[]=[];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:(req)=>{oauth.push(new URL(req.url).pathname);return new Response('nope',{status:500});}});
  try{
    fx.env.AGENTWATCH_SECRETS_FILE=file;
    fx.env.AGENTWATCH_API_BASE=`http://127.0.0.1:${server.port}`;
    const linux=createAuthSession({platform:'linux',env:fx.env,home:fx.home,fetch:((i,init)=>fetch(i,init)) as typeof fetch});
    expect((await linux.getAccessToken()).accessToken).toBe('SYNTHETIC_DESKTOP_TOKEN');
    expect(oauth).toHaveLength(0);
    expect(linux.peekReady()).toBe(true);
    const expired=writeDesktop(fx.home,unsignedJwt({exp:Math.floor(Date.now()/1000)-20}),fx.env);
    fx.env.AGENTWATCH_SECRETS_FILE=expired;
    await expect(linux.getAccessToken()).rejects.toMatchObject({code:'AUTH_NOT_CONFIGURED'});
    expect(oauth).toHaveLength(0);
    delete fx.env.AGENTWATCH_SECRETS_FILE;
    const missing=createAuthSession({platform:'linux',env:{...fx.env,XDG_CONFIG_HOME:join(fx.home,'empty-config')},home:fx.home});
    mkdirSync(join(fx.home,'empty-config'),{recursive:true});
    await expect(missing.getAccessToken()).rejects.toMatchObject({code:'AUTH_NOT_CONFIGURED'});
    fx.env.AGENTWATCH_SECRETS_FILE=file;
    writeDesktop(fx.home,'SYNTHETIC_DESKTOP_TOKEN',fx.env);
    const mac=createAuthSession({platform:'darwin',env:fx.env,home:fx.home,fetch:Object.assign(async()=>{throw new Error('mac should not refresh desktop secrets');},{preconnect(){}}) as typeof fetch});
    await expect(mac.getAccessToken()).rejects.toMatchObject({code:'AUTH_NOT_CONFIGURED'});
    expect(oauth).toHaveLength(0);
    const win=listSecretsCandidates({platform:'win32',home:fx.home,env:fx.env});
    expect(win[0]?.path.includes('Grok Bot')).toBe(true);
    const winSession=createAuthSession({platform:'win32',env:{...fx.env,AGENTWATCH_SECRETS_FILE:file},home:fx.home});
    await expect(winSession.getAccessToken()).rejects.toMatchObject({code:'AUTH_NOT_CONFIGURED'});
    await expect(linux.beginLogin()).rejects.toMatchObject({code:'AUTH_NOT_CONFIGURED'});
    await expect(linux.logout()).rejects.toMatchObject({code:'AUTH_NOT_CONFIGURED'});
  }finally{server.stop(true);fx.cleanup();}
});

test('independent credential reread after refresh is visible to the next request, and health never includes secrets',async()=>{
  const fx=sandbox();
  const state=join(fx.root,'state');mkdirSync(state,{mode:0o700});
  const now=Date.now();
  const first=unsignedJwt({sub:'user-1',exp:Math.floor((now+3_600_000)/1000)});
  const second=unsignedJwt({sub:'user-1',exp:Math.floor((now+7_200_000)/1000)});
  writeCreds(fx.credentials,{access_token:first,refresh_token:'SECRET_REFRESH_TOKEN',expires_at_ms:now+3_600_000,backend:'http://127.0.0.1:1'});
  const seen:string[]=[];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
    const auth=req.headers.get('authorization')||'';
    seen.push(auth);
    return Response.json({agents:[{agentId:'test-bot'}]});
  }});
  const prev={HOME:process.env.HOME,CRED:process.env.AGENTWATCH_CREDENTIALS,BASE:process.env.AGENTWATCH_API_BASE,CID:process.env.AGENTWATCH_CLIENT_ID};
  let host:Awaited<ReturnType<typeof startDaemon>>|undefined;
  try{
    writeFileSync(fx.credentials,JSON.stringify({...JSON.parse(readFileSync(fx.credentials,'utf8')),backend:`http://127.0.0.1:${server.port}`}),{mode:0o600});
    setAuthPlatformForTests('darwin');
    process.env.HOME=fx.home;process.env.AGENTWATCH_CREDENTIALS=fx.credentials;process.env.AGENTWATCH_CLIENT_ID='synthetic-client';
    process.env.AGENTWATCH_API_BASE=`http://127.0.0.1:${server.port}`;
    host=await startDaemon(state);
    expect(host).toBeTruthy();
    const health=await request(host!.info,'health',{});
    expect(health.bot_verifier).toBe('connect_http');
    expect(JSON.stringify(health)).not.toContain('SECRET_REFRESH_TOKEN');
    expect(JSON.stringify(health)).not.toContain(first);
    await connectRpc('ListGrokBotAgents',{});
    const next={...JSON.parse(readFileSync(fx.credentials,'utf8')),access_token:second};
    writeFileSync(fx.credentials,JSON.stringify(next),{mode:0o600});
    await connectRpc('ListGrokBotAgents',{});
    expect(seen).toEqual([`Bearer ${first}`,`Bearer ${second}`]);
  }finally{
    await host?.close();server.stop(true);fx.cleanup();setAuthPlatformForTests(undefined);
    for(const [key,value] of [['HOME',prev.HOME],['AGENTWATCH_CREDENTIALS',prev.CRED],['AGENTWATCH_API_BASE',prev.BASE],['AGENTWATCH_CLIENT_ID',prev.CID]] as const){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
});
