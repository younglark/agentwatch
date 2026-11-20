import { Database } from 'bun:sqlite';
import { test,expect } from 'bun:test';
import { readFileSync,writeFileSync,statSync,existsSync,chmodSync,linkSync,renameSync,symlinkSync,unlinkSync,mkdirSync,realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { commandHarness,until,alive } from './command-harness.ts';
import { readRegistration,request } from '../src/service.ts';
function ledgerRows(state:string,requestId:string) {
  const db=new Database(join(state,'tasks.sqlite'),{readonly:true});
  try{return db.query('SELECT id FROM tasks WHERE request_id=?').all(requestId);}
  finally{db.close();}
}
export function commandContracts(label:string,cli:readonly string[],host:readonly string[],env?:NodeJS.ProcessEnv) {
  const check=(name:string,body:(h:ReturnType<typeof commandHarness>)=>Promise<void>)=>test(`${label}: ${name}`,async()=>{
    const h=commandHarness(cli,host,env);try{await body(h);}finally{await h.cleanup();}
  },20000);
  check('five JSON commands preserve native argv and timeout never cancels',async h=>{
    const info=(await h.startHost())!;expect((await request(info,'health',{})).bot_verifier).toBe('test_only');
    const argv=['claude','-p','hello 空格','', '--resume','session-id','--json','long'];
    const run=await h.call('run',['--json','--bot','test-bot','--request-id','five','--cwd',h.cwd,'--',...argv]);
    expect(run.code,run.err).toBe(0);expect(run.err).toBe('');const id=run.value.data.id;
    await until(async()=>h.call('status',[id]),r=>r.value?.data.state==='running');
    const waiting=await h.call('wait',[id,'--timeout','0','--json']);expect(waiting.code).toBe(9);expect(waiting.value.data.wait_timed_out).toBe(true);
    const log=await until(async()=>h.call('logs',[id]),r=>!!r.value?.data.text);
    expect(JSON.parse(log.value.data.text).argv).toEqual(argv);expect(JSON.parse(log.value.data.text).cwd).toBe(h.cwd);
    expect(log.value.data.bytes).toBeLessThanOrEqual(4096);
    const cancel=await h.call('cancel',[id]);expect(cancel.code,cancel.err).toBe(0);
    const done=await h.call('wait',[id,'--timeout','5']);expect(done.code,done.err).toBe(0);expect(done.value.data.task.state).toBe('cancelled');
    expect(alive(done.value.data.task.pid)).toBe(false);
    const errlog=await h.call('logs',[id,'--stream','stderr']);expect(errlog.value.data.text).toBe('fixture stderr\n');
    expect((await h.call('logs',[id,'--limit','65537'])).code).toBe(2);
  });
  check('concurrent same ID returns one fixture process; changed argv conflicts',async h=>{
    await h.startHost();const args=['--bot','test-bot','--request-id','duplicate','--cwd',h.cwd,'--','codex','exec','hi'];
    const runs=await Promise.all(Array.from({length:4},()=>h.call('run',args)));
    for(const r of runs)expect(r.code,r.err).toBe(0);
    expect(new Set(runs.map(r=>r.value.data.id)).size).toBe(1);
    const id=runs[0]!.value.data.id;expect((await h.call('wait',[id,'--timeout','5'])).code).toBe(0);
    expect(h.receipts().filter(r=>r.request_id==='duplicate')).toHaveLength(1);
    const conflict=await h.call('run',[...args.slice(0,-1),'different']);expect(conflict.code).toBe(6);expect(conflict.out).toBe('');
    expect(JSON.parse(conflict.err).error.code).toBe('CONFLICT');
  });
  check('unconfigured production verifier is visible and cannot be bypassed',async h=>{
    const run=await h.call('run',['--bot','test-bot','--request-id','no-auth','--cwd',h.cwd,'--','opencode','run','hi']);
    expect(run.code,run.err).toBe(4);expect(run.out).toBe('');expect(JSON.parse(run.err).error.code).toBe('AUTH_NOT_CONFIGURED');
    const info=readRegistration(h.state)!;expect((await request(info,'health',{})).bot_verifier).toBe('not_configured');
    expect(h.receipts()).toHaveLength(0);expect(ledgerRows(h.state,'no-auth')).toHaveLength(0);
    await expect(request(info,'run',{request_id:'forged-test-adapter',bot:'test-bot',cwd:h.cwd,argv:['claude'],testOnly:true,verifier:'fake'})).rejects.toMatchObject({code:'AUTH_NOT_CONFIGURED'});
    expect(ledgerRows(h.state,'forged-test-adapter')).toHaveLength(0);
    const bypass=await h.call('run',['--fake-verifier','--bot','test-bot','--request-id','bypass','--','claude']);
    expect(bypass.code).toBe(2);expect(bypass.out).toBe('');expect(ledgerRows(h.state,'bypass')).toHaveLength(0);
    const wizard=await h.call('run',['--wizard']);expect(wizard.code).toBe(2);expect(wizard.out).toBe('');expect(JSON.parse(wizard.err).error.code).toBe('USAGE');
    expect(run.err).not.toContain(info.token);
  });
  check('direct Connect exact agent_id uses bound private credentials without a tool on PATH',async h=>{
    h.mockConnect();
    const run=await h.call('run',['--bot','test-bot','--request-id','direct-ok','--cwd',h.cwd,'--',h.nativeFixture()]);
    expect(run.code,run.err).toBe(0);
    const done=await h.call('wait',[run.value.data.id,'--timeout','5']);expect(done.code,done.err).toBe(0);
    const lookups=h.calls.filter(c=>c.method==='ListGrokBotAgents');expect(lookups).toHaveLength(2);
    for(const call of lookups){expect(call.body).toEqual({});expect(call.authorization).toBe('Bearer SYNTHETIC_PRIVATE_TOKEN');expect(call.headers['connect-protocol-version']).toBe('1');expect(call.headers['content-type']).toBe('application/json');}
    expect((await request(readRegistration(h.state)!,'health',{})).bot_verifier).toBe('connect_http');expect(existsSync(join(h.bin,'gbc'))).toBe(false);expect(h.oauthCalls).toHaveLength(0);
  });
  for(const code of ['auth','unauthenticated','auth_revoked','auth_refresh_unconfigured','auth_refresh_client_mismatch','auth_refresh_subject_mismatch'])
    check(`direct Connect ${code} is auth unavailable before admission and launch`,async h=>{
      h.mockConnect({lookup:()=>({status:401,body:{code,message:'SECRET_REFRESH_TOKEN'}})});
      const rejected=await h.call('run',['--bot','test-bot','--request-id',code,'--cwd',h.cwd,'--','claude']);
      expect(rejected.code,rejected.err).toBe(4);expect(rejected.out).toBe('');expect(JSON.parse(rejected.err).error.code).toBe('AUTH_NOT_CONFIGURED');expect(ledgerRows(h.state,code)).toHaveLength(0);expect(rejected.err).not.toContain('SECRET_REFRESH_TOKEN');
      h.mockConnect({lookup:(_,count)=>count===2?{body:{agents:[{agentId:'test-bot'}]}}:{status:401,body:{code,message:'SECRET_REFRESH_TOKEN'}}});
      const run=await h.call('run',['--bot','test-bot','--request-id',code+'-launch','--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code,run.err).toBe(0);
      const done=await h.call('wait',[run.value.data.id,'--timeout','5']);expect(done.code).toBe(1);expect(done.value.data.task.error_code).toBe('AUTH_NOT_CONFIGURED');expect(done.value.data.task.pid).toBeNull();expect(done.out+done.err+readFileSync(join(h.state,'diagnostics.log'),'utf8')).not.toContain('SECRET_REFRESH_TOKEN');
    });
  for(const [name,reply,exit,error] of [
    ['missing',{body:{agents:[]}},5,'BOT_FORBIDDEN'],
    ['aliases',{body:{agents:[{agentId:'other',id:'test-bot',name:'test-bot'}]}},5,'BOT_FORBIDDEN'],
    ['denied',{status:403,body:{code:'permission_denied',message:'SECRET_BODY'}},5,'BOT_FORBIDDEN'],
    ['truncated',{body:{agents:[],truncated:true}},10,'UNKNOWN'],
    ['bad-json',{body:'SECRET_BODY'},8,'TRANSPORT_NOT_CONFIGURED'],
    ['redirect',{status:302,body:{},headers:{location:'/trap'}},8,'TRANSPORT_NOT_CONFIGURED'],
    ['missing-agent-id',{body:{agents:[{name:'test-bot'}]}},8,'TRANSPORT_NOT_CONFIGURED'],
    ['error-on-200',{body:{code:'unauthenticated'}},8,'TRANSPORT_NOT_CONFIGURED'],
    ['cli-envelope',{body:{schema_version:'1.0.0',ok:true,data:{bot:{agent_id:'test-bot'}}}},8,'TRANSPORT_NOT_CONFIGURED'],
    ['unsupported',{status:500,body:{code:'unsupported'}},8,'TRANSPORT_NOT_CONFIGURED'],
    ['unknown-auth',{status:401,body:{code:'auth_future_code'}},8,'TRANSPORT_NOT_CONFIGURED'],
    ['refresh-network',{status:503,body:{code:'auth_refresh_network'}},8,'TRANSPORT_NOT_CONFIGURED'],
    ['timeout',{hang:true},8,'TRANSPORT_NOT_CONFIGURED'],
    ['oversized',{oversized:true},8,'TRANSPORT_NOT_CONFIGURED'],
  ] as const)check(`direct Connect lookup ${name} is bounded and fail closed`,async h=>{
    h.mockConnect({lookup:()=>reply});const started=Date.now();
    const run=await h.call('run',['--bot','test-bot','--request-id',name,'--cwd',h.cwd,'--','claude']);expect(run.code,run.err).toBe(exit);expect(run.out).toBe('');expect(JSON.parse(run.err).error.code).toBe(error);expect(ledgerRows(h.state,name)).toHaveLength(0);expect(run.err).not.toContain('SECRET_BODY');expect(Date.now()-started).toBeLessThan(8000);
    const health=await request(readRegistration(h.state)!,'health',{});expect(health.bot_verifier).toBe('connect_http');
  });
  for(const mode of ['expired','unsafe-backend','secrets-symlink','missing-secrets'] as const)
    check(`desktop credentials ${mode} never reach HTTP or admission`,async h=>{
      if(mode!=='missing-secrets')h.configureAuth();
      if(mode==='expired')h.configureAuth({expires_at_ms:1});
      if(mode==='unsafe-backend')h.configureAuth({backend:'http://example.invalid'});
      if(mode==='secrets-symlink'){const value=readFileSync(h.credentials);unlinkSync(h.credentials);writeFileSync(join(h.home,'synthetic-secrets'),value,{mode:0o600});symlinkSync(join(h.home,'synthetic-secrets'),h.credentials);}
      const run=await h.call('run',['--bot','test-bot','--request-id',mode,'--cwd',h.cwd,'--','claude']);expect(run.code,run.err).toBe(4);expect(run.out).toBe('');expect(h.calls).toHaveLength(0);expect(h.oauthCalls).toHaveLength(0);expect(ledgerRows(h.state,mode)).toHaveLength(0);expect(run.err).not.toContain('SYNTHETIC_PRIVATE_TOKEN');expect(run.err).not.toContain('SECRET_DESKTOP_REFRESH');expect((await request(readRegistration(h.state)!,'health',{})).bot_verifier).toBe('not_configured');
    });
  check('Linux production ignores independent credentials.json and does not refresh desktop tokens',async h=>{
    mkdirSync(join(h.home,'.agentwatch','auth'),{recursive:true,mode:0o700});
    writeFileSync(join(h.home,'.agentwatch','auth','credentials.json'),JSON.stringify({version:1,backend:`http://127.0.0.1:1`,client_id:'synthetic-client',access_token:'SECRET_INDEPENDENT_TOKEN',refresh_token:'SECRET_INDEPENDENT_REFRESH',expires_at_ms:Date.now()+60000}),{mode:0o600});
    h.env.AGENTWATCH_CREDENTIALS=join(h.home,'.agentwatch','auth','credentials.json');
    h.mockConnect();
    const run=await h.call('run',['--bot','test-bot','--request-id','desktop-ok','--cwd',h.cwd,'--',h.nativeFixture()]);
    expect(run.code,run.err).toBe(0);
    expect((await h.call('wait',[run.value.data.id,'--timeout','5'])).code).toBe(0);
    expect(h.oauthCalls).toHaveLength(0);expect(h.pollCalls).toHaveLength(0);
    const lookup=h.calls.filter(c=>c.method==='ListGrokBotAgents');expect(lookup.length).toBeGreaterThan(0);
    for(const call of lookup)expect(call.authorization).toBe('Bearer SYNTHETIC_PRIVATE_TOKEN');
    const text=run.out+run.err+JSON.stringify(await request(readRegistration(h.state)!,'health',{}));
    expect(text).not.toContain('SECRET_INDEPENDENT_TOKEN');expect(text).not.toContain('SECRET_INDEPENDENT_REFRESH');expect(text).not.toContain('SECRET_DESKTOP_REFRESH');
  });
  check('client id may be explicitly configured but gbc files and GBT env are never consulted',async h=>{
    mkdirSync(join(h.home,'.gbc'));writeFileSync(join(h.home,'.gbc','credentials.json'),'SECRET_GBC_TOKEN',{mode:0o600});
    writeFileSync(join(h.bin,'gbc'),'#!/bin/sh\nexit 99\n',{mode:0o700});h.env.GBT_MOCK='1';
    const help=await h.call('run',['--help']);expect(help.code).toBe(0);expect(h.calls).toHaveLength(0);
    h.mockConnect();h.configureAuth({client_id:undefined});h.env.AGENTWATCH_CLIENT_ID='explicit-client';
    const run=await h.call('run',['--bot','test-bot','--request-id','env-client','--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code,run.err).toBe(0);expect((await h.call('wait',[run.value.data.id,'--timeout','5'])).code).toBe(0);
    expect(run.out+run.err+help.out+help.err).not.toContain('SECRET_GBC_TOKEN');
    expect(h.oauthCalls).toHaveLength(0);
  });
  check('login and logout are rejected on desktop platforms',async h=>{
    for(const command of ['login','logout']){
      const result=await h.call(command,[]);
      expect(result.code,result.err).toBe(4);expect(result.out).toBe('');
      expect(JSON.parse(result.err).error.code).toBe('AUTH_NOT_CONFIGURED');
      expect(result.err.toLowerCase()).toMatch(/official|desktop|grok bot/);
      expect(result.err).not.toContain('verifier');expect(result.out+result.err).not.toContain('SECRET_');
    }
    expect(h.pollCalls).toHaveLength(0);expect(h.oauthCalls).toHaveLength(0);
  });
  check('direct notification acceptance persists once with frozen bounded request fields',async h=>{
    h.mockConnect();const args=['--bot','test-bot','--request-id','notify-accepted','--cwd',h.cwd,'--',h.nativeFixture(),'SECRET_ARGV'];
    const run=await h.call('run',args);expect(run.code,run.err).toBe(0);const id=run.value.data.id;
    const accepted=await until(()=>h.call('status',[id]),r=>r.value?.data.notification.state==='accepted',4000);
    expect(accepted.value.data.state).toBe('succeeded');expect(accepted.value.data.notification).toMatchObject({transport:'connect_http',attempts:1,durability:'unverified',needs_reconciliation:false,receipt:{delivery:'accepted_temporal',delivery_code:2,dispatched:true,workflow_id:'workflow-fixture'}});
    const sent=h.calls.filter(c=>c.method==='SendGrokBotUserMessage');expect(sent).toHaveLength(1);expect(Object.keys(sent[0]!.body)).toEqual(['agentId','messageId','sessionId','text','sentAtMs']);expect(sent[0]!.body).toMatchObject({agentId:'test-bot',messageId:accepted.value.data.notification.message_id,sessionId:''});expect(sent[0]!.body.sentAtMs).toMatch(/^\d{13}$/);
    const body=readFileSync(join(h.root,'notification-body'),'utf8');
    expect(body).toBe([
      '任务已成功','',`- 任务：\`${id}\``,`- 事件：\`${id}:terminal:1\``,'- 退出码：0','',
      '## stdout','','```','SECRET_NATIVE_LOG','```','',
      '## stderr','','（无输出）',
    ].join('\n'));
    expect(body).not.toContain('已省略');expect(body).not.toContain('agentwatch logs');expect(body).not.toContain(hostname());
    expect(()=>JSON.parse(body)).toThrow();
    expect(body).not.toContain('SECRET_ARGV');expect(body).not.toContain('argv');expect(body).not.toContain(h.cwd);expect(body).not.toContain('notify-accepted');expect(body).not.toContain('request_id');
    expect(body).not.toContain(join(realpathSync(h.state),id+'.stdout'));
    expect(accepted.out).not.toContain('SECRET_');expect(JSON.parse(accepted.out).data.id).toBe(id);expect((await h.call('run',args)).value.data.id).toBe(id);
    const info=readRegistration(h.state)!;expect((await request(info,'health',{})).notification_transport).toBe('connect_http');await request(info,'shutdown',{});await until(async()=>alive(info.pid),v=>!v,3000);
    expect((await h.call('status',[id])).value.data.notification).toEqual(accepted.value.data.notification);expect(h.notificationCalls()).toHaveLength(1);
  });
  check('credential loss after admission fails before native spawn without a real credential read',async h=>{
    h.mockConnect({lookup:()=>{unlinkSync(h.credentials);return {body:{agents:[{agentId:'test-bot'}]}};}});
    const fixture=join(h.bin,'claude');writeFileSync(fixture,'#!/bin/sh\nprintf yes > launched\n',{mode:0o700});
    const run=await h.call('run',['--bot','test-bot','--request-id','lost-credentials','--cwd',h.cwd,'--',fixture]);expect(run.code,run.err).toBe(0);
    const done=await h.call('wait',[run.value.data.id,'--timeout','5']);expect(done.code).toBe(1);expect(done.value.data.task).toMatchObject({state:'failed',pid:null,error_code:'AUTH_NOT_CONFIGURED'});expect(existsSync(join(h.cwd,'launched'))).toBe(false);expect(h.calls).toHaveLength(1);
    expect(done.value.data.task.notification).toMatchObject({state:'pending',transport:'not_configured',attempts:0});
  });
  check('credential loss after launch preserves terminal pending outbox until configured again',async h=>{
    h.mockConnect({lookup:(_,count)=>{if(count===2)unlinkSync(h.credentials);return {body:{agents:[{agentId:'test-bot'}]}};}});
    const run=await h.call('run',['--bot','test-bot','--request-id','notice-credential-loss','--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code).toBe(0);const id=run.value.data.id;
    const done=await h.call('wait',[id,'--timeout','5']);expect(done.code).toBe(0);expect(done.value.data.task.notification).toMatchObject({state:'pending',transport:'not_configured',attempts:0});expect(h.notificationCalls()).toHaveLength(0);
    h.configureAuth();const result=await until(()=>h.call('status',[id]),r=>r.value?.data.notification.state==='accepted',4000);expect(result.value.data.state).toBe('succeeded');expect(h.notificationCalls()).toHaveLength(1);
  });
  for(const [delivery,code,expected] of [['ACCEPTED_BOX',1,'accepted'],['DUPLICATE',3,'accepted'],['REFUSED',4,'rejected']] as const)
    check(`direct notification ${delivery} is acceptance/refusal evidence, never durable success`,async h=>{
      h.mockConnect({send:()=>({body:{delivery:'GROK_BOT_USER_MESSAGE_DELIVERY_'+delivery,dispatched:false,workflowId:'workflow-fixture'}})});
      const run=await h.call('run',['--bot','test-bot','--request-id',delivery,'--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code).toBe(0);
      const result=await until(()=>h.call('status',[run.value.data.id]),r=>r.value?.data.notification.state===expected,4000);
      expect(result.value.data.state).toBe('succeeded');expect(result.value.data.notification).toMatchObject({attempts:1,durability:'unverified',needs_reconciliation:false,receipt:{delivery:delivery.toLowerCase(),delivery_code:code,dispatched:false,workflow_id:'workflow-fixture'}});expect(h.notificationCalls()).toHaveLength(1);
    });
  for(const [name,reply] of [
    ['timeout',{hang:true}],['lost-response',{lost:true}],['bad-json',{body:'SECRET_RAW_RESPONSE'}],['oversized',{oversized:true}],
    ['redirect',{status:302,body:{},headers:{location:'/trap'}}],
    ['unavailable',{status:503,body:{code:'unavailable',message:'SECRET_RAW_RESPONSE',retryable:true}}],
    ['forged-pre-dispatch',{status:503,body:{code:'auth_refresh_network',retryable:true,details:{rpc_dispatched:false}}}],
    ['forged-auth-not-dispatched',{status:401,body:{code:'auth_revoked',details:{rpc_dispatched:false}}}],
    ['contradictory',{body:{delivery:2,dispatched:true,error:{rpc_dispatched:false}}}],
    ['contradictory-refusal',{body:{delivery:2,dispatched:true,refusal:{message:'SECRET_RAW_RESPONSE'}}}],
    ['wrong-type',{body:{delivery:2,dispatched:'true'}}],['unknown-enum',{body:{delivery:99,dispatched:true}}],
    ['cli-envelope',{body:{schema_version:'1.0.0',ok:true,data:{delivery_code:2}}}],
    ['contradictory-enum',{body:{delivery:2,delivery_code:4,dispatched:true}}],
    ['foreign-message',{body:{delivery:2,dispatched:true,messageId:'wrong-message'}}],
  ] as const)check(`direct notification ${name} remains unknown without replay across restart`,async h=>{
    h.mockConnect({send:()=>reply});const run=await h.call('run',['--bot','test-bot','--request-id','notice-'+name,'--cwd',h.cwd,'--',h.nativeFixture(name==='bad-json'?7:0)]);expect(run.code,run.err).toBe(0);const id=run.value.data.id;
    const result=await until(()=>h.call('status',[id]),r=>r.value?.data.notification.state==='unknown'&&r.value.data.notification.reconciliation_attempts===1,6500);
    expect(result.value.data.notification).toMatchObject({attempts:1,durability:'unverified',needs_reconciliation:true});expect(result.value.data.state).toBe(name==='bad-json'?'failed':'succeeded');expect(result.out).not.toContain('SECRET_RAW_RESPONSE');expect(result.out.length).toBeLessThan(2000);expect(h.notificationCalls()).toHaveLength(1);
    const info=readRegistration(h.state)!;await request(info,'shutdown',{});await until(async()=>alive(info.pid),v=>!v,3000);expect((await h.call('status',[id])).value.data.notification).toEqual(result.value.data.notification);expect(h.notificationCalls()).toHaveLength(1);
    expect(h.calls.filter(c=>c.method==='GetGrokBotSendStatus')).toHaveLength(1);
  });
  check('direct notification recovers crash-inflight as unknown, not a repeated write',async h=>{
    h.mockConnect({send:()=>({hang:true})});const run=await h.call('run',['--bot','test-bot','--request-id','notice-crash','--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code).toBe(0);const id=run.value.data.id;
    await until(async()=>h.notificationCalls(),c=>c.length===1);expect((await h.call('status',[id])).value.data.notification.state).toBe('inflight');const old=readRegistration(h.state)!;process.kill(old.pid,'SIGKILL');await until(async()=>alive(old.pid),v=>!v,3000);
    const result=await h.call('status',[id]);expect(result.code).toBe(0);expect(result.value.data).toMatchObject({state:'succeeded',notification:{state:'unknown',attempts:1,needs_reconciliation:true,last_code:'INTERRUPTED_SEND'}});await h.call('status',[id]);expect(h.notificationCalls()).toHaveLength(1);
  });
  for(const [wire,code,expected] of [['ACCEPTED',2,'accepted'],['REJECTED',3,'rejected'],['NOT_FOUND',1,'unknown'],['PENDING',4,'unknown'],['UNKNOWN_DURABILITY',5,'unknown']] as const)
    check(`direct read-only status ${wire} is reconciled at most once without a repeated send`,async h=>{
      h.mockConnect({send:()=>({lost:true}),status:()=>({body:{status:'GROK_BOT_SEND_STATUS_'+wire,echoEntryId:'echo-fixture',acceptedAtMs:'1794454564087'}})});
      const run=await h.call('run',['--bot','test-bot','--request-id','status-'+wire,'--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code).toBe(0);
      const result=await until(()=>h.call('status',[run.value.data.id]),r=>r.value?.data.notification.state===expected&&r.value.data.notification.reconciliation_attempts===1,4000);
      expect(result.value.data.notification).toMatchObject({attempts:1,durability:'unverified',needs_reconciliation:expected==='unknown'});
      if(expected!=='unknown')expect(result.value.data.notification.receipt).toMatchObject({status:wire.toLowerCase(),status_code:code,echo_entry_id:'echo-fixture',accepted_at_ms:'1794454564087'});
      const reads=h.calls.filter(c=>c.method==='GetGrokBotSendStatus');expect(reads).toHaveLength(1);expect(reads[0]!.body).toEqual({agentId:'test-bot',messageId:h.notificationCalls()[0]!.message_id,sessionId:''});expect(h.notificationCalls()).toHaveLength(1);
    });
  for(const [name,reply] of [['timeout',{hang:true}],['bad-json',{body:'SECRET_STATUS'}],['oversized',{oversized:true}],['unauthenticated',{status:401,body:{code:'unauthenticated',message:'SECRET_STATUS'}}],['invalid-type',{body:{status:'GROK_BOT_SEND_STATUS_ACCEPTED',echoEntryId:42}}],['contradictory',{body:{status:2,status_code:3}}]] as const)
    check(`direct reconciliation ${name} remains unknown with one persisted read attempt`,async h=>{
      h.mockConnect({send:()=>({lost:true}),status:()=>reply});const run=await h.call('run',['--bot','test-bot','--request-id','status-failure-'+name,'--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code).toBe(0);const id=run.value.data.id;
      await until(()=>h.call('status',[id]),r=>r.value?.data.notification.state==='unknown'&&r.value.data.notification.reconciliation_attempts===1,4000);
      // Persisted reconciliation claim precedes its network response; wait through timeout before restart.
      if(name==='timeout')await until(async()=>h.activeHttp(),n=>n===0,4500);
      const info=readRegistration(h.state)!;await request(info,'shutdown',{});await until(async()=>alive(info.pid),v=>!v,3000);
      const result=await h.call('status',[id]);expect(result.value.data.notification).toMatchObject({state:'unknown',attempts:1,reconciliation_attempts:1,durability:'unverified'});expect(result.out).not.toContain('SECRET_STATUS');expect(h.calls.filter(c=>c.method==='GetGrokBotSendStatus')).toHaveLength(1);expect(h.notificationCalls()).toHaveLength(1);
    });
  check('direct notification receipt values are bounded and secret-shaped values omitted',async h=>{
    h.mockConnect({send:()=>({body:{delivery:2,dispatched:true,workflowId:'Bearer SYNTHETIC_PRIVATE_TOKEN'}}),status:()=>({body:{status:2,echoEntryId:'Bearer PRIVATE',rejectionCode:'x'.repeat(100),acceptedAtMs:'not-an-int'}})});
    const run=await h.call('run',['--bot','test-bot','--request-id','safe-receipt','--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code).toBe(0);
    const result=await until(()=>h.call('status',[run.value.data.id]),r=>r.value?.data.notification.state==='accepted',4000);expect(result.value.data.notification.receipt.workflow_id).toBeNull();expect(result.out).not.toContain('SYNTHETIC_PRIVATE_TOKEN');expect(result.out).not.toContain('SECRET_REFUSAL');
  });
  check('no credentials preserve pending outbox across restart and later direct configuration',async h=>{
    const host=(await h.startHost())!;const run=await h.call('run',['--bot','test-bot','--request-id','notice-unconfigured','--cwd',h.cwd,'--','claude']);expect(run.code).toBe(0);const id=run.value.data.id;
    expect((await h.call('wait',[id,'--timeout','5'])).value.data.task.notification).toMatchObject({state:'pending',transport:'not_configured',attempts:0});await request(host,'shutdown',{});await until(async()=>alive(host.pid),v=>!v,3000);
    expect((await h.call('status',[id])).value.data.notification).toMatchObject({state:'pending',transport:'not_configured',attempts:0,event_id:id+':terminal:1'});expect(h.notificationCalls()).toHaveLength(0);
    const mid=readRegistration(h.state)!;await request(mid,'shutdown',{});await until(async()=>alive(mid.pid),v=>!v,3000);
    h.mockConnect();const restored=await until(()=>h.call('status',[id]),r=>r.value?.data.notification.state==='accepted',4000);expect(restored.value.data.notification).toMatchObject({event_id:id+':terminal:1',attempts:1});expect(h.notificationCalls()).toHaveLength(1);
  });
  for(const phase of ['send','status'] as const)check(`direct HTTP drain aborts hung ${phase} within bounded stop`,async h=>{
    h.mockConnect(phase==='send'?{send:()=>({hang:true})}:{send:()=>({lost:true}),status:()=>({hang:true})});
    const run=await h.call('run',['--bot','test-bot','--request-id','notice-drain-'+phase,'--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code).toBe(0);await until(async()=>h.activeHttp(),n=>n===1);
    const info=readRegistration(h.state)!,started=Date.now();expect((await request(info,'drain',{})).active).toBe(0);expect(Date.now()-started).toBeLessThan(1500);
    await until(async()=>h.activeHttp(),n=>n===0);expect((await h.call('status',[run.value.data.id])).value.data.notification).toMatchObject({state:'unknown',attempts:1,needs_reconciliation:true});expect(h.notificationCalls()).toHaveLength(1);
  });
  check('bot denial, program allowlist and malformed requests fail without stdout or spawn',async h=>{
    await h.startHost();
    const rejected=await h.call('run',['--bot','forbidden','--request-id','denied','--cwd',h.cwd,'--','grok','-p','hi']);
    expect(rejected.code).toBe(5);expect(rejected.out).toBe('');expect(h.receipts()).toHaveLength(0);expect(ledgerRows(h.state,'denied')).toHaveLength(0);
    const arbitrary=await h.call('run',['--bot','test-bot','--request-id','shell','--','sh','-c','echo hi']);expect(arbitrary.code).toBe(2);expect(ledgerRows(h.state,'shell')).toHaveLength(0);
    const missing=await h.call('status',['no-such-task']);expect(missing.code).toBe(3);expect(missing.out).toBe('');
    expect(JSON.parse(missing.err).version).toBe(1);
  });
  check('IPC log reads reject replaced links, nonregular files and ledger traversal',async h=>{
    await h.startHost();
    const run=await h.call('run',['--bot','test-bot','--request-id','log-links','--cwd',h.cwd,'--','claude']);
    expect(run.code,run.err).toBe(0);const id=run.value.data.id;
    expect((await h.call('wait',[id,'--timeout','5'])).code).toBe(0);
    const sentinel=join(h.root,'outside.stdout');writeFileSync(sentinel,'OWNED_PRIVATE_SENTINEL',{mode:0o600});
    for(const stream of ['stdout','stderr']) {
      const file=join(h.state,id+'.'+stream);unlinkSync(file);symlinkSync(sentinel,file);
      const result=await h.call('logs',[id,'--stream',stream]);expect(result.code).toBe(7);expect(result.out).toBe('');expect(result.err).not.toContain('OWNED_PRIVATE_SENTINEL');
    }
    unlinkSync(join(h.state,id+'.stdout'));mkdirSync(join(h.state,id+'.stdout'));
    expect((await h.call('logs',[id])).code).toBe(7);
    const raw=new Database(join(h.state,'tasks.sqlite'));
    try{raw.query('UPDATE tasks SET id=? WHERE id=?').run('../outside',id);}finally{raw.close();}
    const traversal=await h.call('logs',['../outside']);expect(traversal.code).toBe(7);expect(traversal.out).toBe('');
  });
  check('private registration rejects wrong credentials/scope and unsafe permissions',async h=>{
    const info=(await h.startHost())!;
    await expect(request({...info,token:'wrong-capability'},'health',{})).rejects.toMatchObject({code:'IPC_AUTH'});
    await expect(request({...info,scope:'wrong-state'},'health',{})).rejects.toMatchObject({code:'IPC_AUTH'});
    expect(statSync(join(h.state,'service.json')).mode&0o777).toBe(0o600);
    expect(statSync(h.state).mode&0o777).toBe(0o700);
    chmodSync(join(h.state,'service.json'),0o644);
    try{expect(()=>readRegistration(h.state)).toThrow('Unsafe service file');}finally{chmodSync(join(h.state,'service.json'),0o600);}
    const raw=await fetch(`http://127.0.0.1:${info.port}/rpc`,{method:'POST',body:'{}'});
    expect(raw.status).toBe(401);expect(await raw.text()).not.toContain(info.token);
  });
  check('crash releases ownership, recovers unknown without replay and does not block drain',async h=>{
    const old=(await h.startHost())!;
    const args=['--bot','test-bot','--request-id','crashed','--cwd',h.cwd,'--','claude','long'];
    const run=await h.call('run',args);expect(run.code,run.err).toBe(0);const id=run.value.data.id;
    await until(async()=>h.receipts(),r=>r.length===1);
    process.kill(old.pid,'SIGKILL');await until(async()=>alive(old.pid),v=>!v);
    const next=(await h.startHost())!;expect(next.instance).not.toBe(old.instance);
    const wait=await h.call('wait',[id,'--timeout','0']);expect(wait.code).toBe(10);expect(wait.value.data.task.state).toBe('unknown');
    expect((await h.call('run',args)).value.data.id).toBe(id);expect(h.receipts()).toHaveLength(1);
    expect(await request(next,'drain',{})).toEqual({active:0,unknown:[id]});
    const blocked=await h.call('run',['--bot','test-bot','--request-id','new','--cwd',h.cwd,'--','claude']);expect(blocked.code).toBe(11);
  });
  check('authenticated shutdown drains its fixture and exits before cleanup rescue',async h=>{
    const info=(await h.startHost())!;
    const run=await h.call('run',['--bot','test-bot','--request-id','shutdown','--cwd',h.cwd,'--','claude','short']);
    expect(run.code,run.err).toBe(0);
    const response=await request(info,'shutdown',{});expect(response.stopping).toBe(true);
    await until(async()=>alive(info.pid),v=>!v,3000);
    expect(readRegistration(h.state)).toBeUndefined();
    expect(h.receipts().filter(r=>alive(r.pid))).toHaveLength(0);
    console.log('FORMAL_SHUTDOWN_EXIT_OBSERVED_BEFORE_CLEANUP');
  });
  check('concurrent production CLI ensure elects one compatible daemon',async h=>{
    const attempts=await Promise.all(Array.from({length:5},()=>h.call('status',['absent'])));
    for(const result of attempts)expect(result.code,result.err).toBe(3);
    const info=readRegistration(h.state)!;const health=await request(info,'health',{});
    expect(health.pid).toBe(info.pid);expect(health.scope).toBe(info.scope);
    const before=readFileSync(join(h.state,'service.json'),'utf8');
    const again=await h.call('status',['absent']);expect(again.code).toBe(3);expect(readFileSync(join(h.state,'service.json'),'utf8')).toBe(before);
  });
}
