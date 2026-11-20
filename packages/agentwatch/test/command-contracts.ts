import { Database } from 'bun:sqlite';
import { test,expect } from 'bun:test';
import { readFileSync,writeFileSync,statSync,existsSync,chmodSync,symlinkSync,unlinkSync,mkdirSync } from 'node:fs';
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
  check('production gbc auth failure is closed and never leaks child diagnostics',async h=>{
    h.mockGbc(4,{schema_version:'1.0.0',ok:false,outcome:'known_failure',code:'unauthenticated',retryable:false,request_id:'fixture',error:{message:'SECRET_GBC_TOKEN'}});
    const run=await h.call('run',['--bot','test-bot','--request-id','gbc-auth','--cwd',h.cwd,'--','claude']);
    expect(run.code,run.err).toBe(4);expect(run.out).toBe('');expect(JSON.parse(run.err).error.code).toBe('AUTH_NOT_CONFIGURED');
    expect(run.err).not.toContain('SECRET_GBC_TOKEN');expect(ledgerRows(h.state,'gbc-auth')).toHaveLength(0);expect(h.receipts()).toHaveLength(0);
    expect(readFileSync(join(h.root,'gbc-calls'),'utf8')).toContain('query');
  });
  for(const code of ['auth_revoked','auth_refresh_unconfigured','auth_refresh_client_mismatch','auth_refresh_subject_mismatch'] as const)
    check(`production gbc ${code} exit9 is auth unavailable before admission and launch`,async h=>{
      const error={schema_version:'1.0.0',ok:false,outcome:'known_failure',code,retryable:false,request_id:'fixture',error:{message:'SECRET_REFRESH_TOKEN'}};
      h.mockGbc(9,error);
      const rejected=await h.call('run',['--bot','test-bot','--request-id',code,'--cwd',h.cwd,'--','claude']);
      expect(rejected.code,rejected.err).toBe(4);expect(rejected.out).toBe('');expect(JSON.parse(rejected.err).error.code).toBe('AUTH_NOT_CONFIGURED');
      expect(ledgerRows(h.state,code)).toHaveLength(0);expect(rejected.err).not.toContain('SECRET_REFRESH_TOKEN');
      h.mockGbc(0,{schema_version:'1.0.0',ok:true,outcome:'known_success',code:'ok',retryable:false,request_id:'fixture',data:{bot:{agent_id:'test-bot'}}},`if [ -f "$HOME/review-checked" ]; then
printf '%s\\n' '${JSON.stringify(error)}' >&2
exit 9
fi
: > "$HOME/review-checked"`);
      const fixture=join(h.bin,'claude');writeFileSync(fixture,'#!/bin/sh\nprintf yes > auth-launched\n',{mode:0o700});
      const run=await h.call('run',['--bot','test-bot','--request-id',code+'-launch','--cwd',h.cwd,'--',fixture]);
      expect(run.code,run.err).toBe(0);expect(ledgerRows(h.state,code+'-launch')).toHaveLength(1);
      const done=await h.call('wait',[run.value.data.id,'--timeout','5']);expect(done.code).toBe(1);
      expect(done.value.data.task.error_code).toBe('AUTH_NOT_CONFIGURED');expect(done.value.data.task.pid).toBeNull();expect(existsSync(join(h.cwd,'auth-launched'))).toBe(false);
      expect(run.out+run.err+done.out+done.err+readFileSync(join(h.state,'diagnostics.log'),'utf8')).not.toContain('SECRET_REFRESH_TOKEN');
    });
  check('production gbc not_found denies admission and reports adapter availability',async h=>{
    h.mockGbc(5,{schema_version:'1.0.0',ok:false,outcome:'known_failure',code:'not_found',retryable:false,request_id:'fixture'});
    const run=await h.call('run',['--bot','test-bot','--request-id','gbc-missing','--cwd',h.cwd,'--','claude']);
    expect(run.code,run.err).toBe(5);expect(run.out).toBe('');expect(JSON.parse(run.err).error.code).toBe('BOT_FORBIDDEN');
    expect(ledgerRows(h.state,'gbc-missing')).toHaveLength(0);expect(h.receipts()).toHaveLength(0);
    const health=await request(readRegistration(h.state)!,'health',{});
    expect(health.bot_verifier).toBe('gbc');expect(health.notification_transport).toBe('gbc');
  });
  check('production gbc exact agent_id admits a fixture and rechecks before launch',async h=>{
    h.env.GBT_MOCK='1';
    h.mockGbc(0,{schema_version:'1.0.0',ok:true,outcome:'known_success',code:'ok',retryable:false,request_id:'fixture',data:{bot:{agent_id:'test-bot',id:'42',name:'not a selector'}}},'[ "${GBT_MOCK+x}" != x ] || exit 2');
    const fixture=join(h.bin,'claude');writeFileSync(fixture,'#!/bin/sh\nprintf "fixture only\\n"\n',{mode:0o700});
    const run=await h.call('run',['--bot','test-bot','--request-id','gbc-allowed','--cwd',h.cwd,'--',fixture]);
    expect(run.code,run.err).toBe(0);expect(run.err).toBe('');expect(ledgerRows(h.state,'gbc-allowed')).toHaveLength(1);
    const done=await h.call('wait',[run.value.data.id,'--timeout','5']);
    expect(done.code,done.err).toBe(0);expect(done.value.data.task.state).toBe('succeeded');
    expect((await h.call('logs',[run.value.data.id])).value.data.text).toBe('fixture only\n');
    expect(readFileSync(join(h.root,'gbc-calls'),'utf8').trim().split('\n')).toHaveLength(2);
    expect((await request(readRegistration(h.state)!,'health',{})).bot_verifier).toBe('gbc');
  });
  check('production gbc unknown outcome preserves uncertainty without inserting a task',async h=>{
    h.mockGbc(10,{schema_version:'1.0.0',ok:false,outcome:'unknown',code:'lookup_incomplete',retryable:false,request_id:'fixture',error:{message:'SECRET_GBC_TOKEN'}});
    const run=await h.call('run',['--bot','test-bot','--request-id','gbc-unknown','--cwd',h.cwd,'--','claude']);
    expect(run.code,run.err).toBe(10);expect(run.out).toBe('');expect(JSON.parse(run.err).error.code).toBe('UNKNOWN');
    expect(run.err).not.toContain('SECRET_GBC_TOKEN');expect(ledgerRows(h.state,'gbc-unknown')).toHaveLength(0);
  });
  check('production gbc permission_denied maps to bot authorization failure',async h=>{
    h.mockGbc(7,{schema_version:'1.0.0',ok:false,outcome:'known_failure',code:'permission_denied',retryable:false,request_id:'fixture'});
    const run=await h.call('run',['--bot','test-bot','--request-id','gbc-denied','--cwd',h.cwd,'--','claude']);
    expect(run.code,run.err).toBe(5);expect(run.out).toBe('');expect(JSON.parse(run.err).error.code).toBe('BOT_FORBIDDEN');
    expect(ledgerRows(h.state,'gbc-denied')).toHaveLength(0);
  });
  check('production gbc rejects server-id and name aliases even with forged fake fields',async h=>{
    h.mockGbc(0,{schema_version:'1.0.0',ok:true,outcome:'known_success',code:'ok',retryable:false,request_id:'fixture',data:{bot:{agent_id:'other-agent',id:'test-bot',name:'test-bot'}}});
    const run=await h.call('run',['--bot','test-bot','--request-id','gbc-alias','--cwd',h.cwd,'--','claude']);
    expect(run.code,run.err).toBe(5);expect(run.out).toBe('');expect(ledgerRows(h.state,'gbc-alias')).toHaveLength(0);
    await expect(request(readRegistration(h.state)!,'run',{request_id:'gbc-forged',bot:'test-bot',cwd:h.cwd,argv:['claude'],testOnly:true,verifier:'fake'})).rejects.toMatchObject({code:'BOT_FORBIDDEN'});
    expect(ledgerRows(h.state,'gbc-forged')).toHaveLength(0);
  });
  check('production gbc rejects simulated envelopes despite inherited mock env',async h=>{
    h.env.GBT_MOCK='1';
    h.mockGbc(0,{schema_version:'1.0.0',ok:true,outcome:'known_success',code:'ok',retryable:false,request_id:'fixture',simulated:true,data:{bot:{agent_id:'test-bot'}}},'[ "${GBT_MOCK+x}" != x ] || exit 2');
    const run=await h.call('run',['--bot','test-bot','--request-id','gbc-simulated','--cwd',h.cwd,'--','claude']);
    expect(run.code,run.err).toBe(8);expect(run.out).toBe('');expect(JSON.parse(run.err).error.code).toBe('TRANSPORT_NOT_CONFIGURED');expect(ledgerRows(h.state,'gbc-simulated')).toHaveLength(0);
  });
  for(const [name,code,envelope,extra] of [
    ['non-json',0,'SECRET_GBC_TOKEN',''],
    ['schema-mismatch',0,{schema_version:'2.0.0',ok:true,outcome:'known_success',code:'ok',retryable:false,request_id:'fixture',data:{bot:{agent_id:'test-bot'}}},''],
    ['missing-agent-id',0,{schema_version:'1.0.0',ok:true,outcome:'known_success',code:'ok',retryable:false,request_id:'fixture',data:{bot:{name:'test-bot'}}},''],
    ['non-auth-exit9',9,{schema_version:'1.0.0',ok:false,outcome:'known_failure',code:'unsupported',retryable:false,request_id:'fixture'},''],
    ['unknown-auth-code',9,{schema_version:'1.0.0',ok:false,outcome:'known_failure',code:'auth_future_code',retryable:false,request_id:'fixture'},''],
    ['retryable-auth-refresh',8,{schema_version:'1.0.0',ok:false,outcome:'known_failure',code:'auth_refresh_network',retryable:true,request_id:'fixture'},''],
    ['inconsistent-exit',4,{schema_version:'1.0.0',ok:true,outcome:'known_success',code:'ok',retryable:false,request_id:'fixture',data:{bot:{agent_id:'test-bot'}}},''],
    ['timeout',0,'SECRET_GBC_TOKEN','while :; do :; done'],
    ['oversized',0,'SECRET_GBC_TOKEN',`while :; do printf '%s' '${'x'.repeat(4096)}'; done`],
  ] as const)check(`production gbc ${name} fails closed with bounded private diagnostics`,async h=>{
    h.mockGbc(code,envelope,extra);
    const started=Date.now(),requestId='gbc-'+name;
    const run=await h.call('run',['--bot','test-bot','--request-id',requestId,'--cwd',h.cwd,'--','claude']);
    expect(run.code,run.err).toBe(8);expect(run.out).toBe('');expect(JSON.parse(run.err).error.code).toBe('TRANSPORT_NOT_CONFIGURED');
    expect(run.err).not.toContain('SECRET_GBC_TOKEN');expect(ledgerRows(h.state,requestId)).toHaveLength(0);expect(Date.now()-started).toBeLessThan(8000);
  });
  check('production ignores a non-executable gbc and help never consults credentials',async h=>{
    const file=join(h.bin,'gbc');writeFileSync(file,'SECRET_GBC_TOKEN',{mode:0o600});
    const run=await h.call('run',['--bot','test-bot','--request-id','gbc-nonexec','--cwd',h.cwd,'--','claude']);
    expect(run.code,run.err).toBe(4);expect(run.out).toBe('');expect(ledgerRows(h.state,'gbc-nonexec')).toHaveLength(0);
    expect((await request(readRegistration(h.state)!,'health',{})).bot_verifier).toBe('not_configured');
    mkdirSync(join(h.home,'.gbc'));writeFileSync(join(h.home,'.gbc','credentials.json'),'SECRET_GBC_TOKEN',{mode:0o600});
    const help=await h.call('run',['--help']);expect(help.code,help.err).toBe(0);expect(help.out).toContain('--bot');expect(help.out+help.err+run.err).not.toContain('SECRET_GBC_TOKEN');
  });
  check('production gbc credential loss after admission prevents native launch',async h=>{
    h.mockGbc(0,{schema_version:'1.0.0',ok:true,outcome:'known_success',code:'ok',retryable:false,request_id:'fixture',data:{bot:{agent_id:'test-bot'}}},`if [ -f "$HOME/checked" ]; then
printf '%s\\n' '{"schema_version":"1.0.0","ok":false,"outcome":"known_failure","code":"auth","retryable":false,"request_id":"fixture"}' >&2
exit 4
fi
: > "$HOME/checked"`);
    const fixture=join(h.bin,'claude');writeFileSync(fixture,'#!/bin/sh\nprintf yes > launched\n',{mode:0o700});
    const run=await h.call('run',['--bot','test-bot','--request-id','gbc-expired','--cwd',h.cwd,'--',fixture]);
    expect(run.code,run.err).toBe(0);expect(ledgerRows(h.state,'gbc-expired')).toHaveLength(1);
    const done=await h.call('wait',[run.value.data.id,'--timeout','5']);expect(done.code).toBe(1);
    expect(done.value.data.task.error_code).toBe('AUTH_NOT_CONFIGURED');expect(done.value.data.task.pid).toBeNull();expect(existsSync(join(h.cwd,'launched'))).toBe(false);
  });
  check('gbc notification acceptance is persisted once without claiming durable delivery',async h=>{
    h.mockNotifications();
    const args=['--bot','test-bot','--request-id','notify-accepted','--cwd',h.cwd,'--',h.nativeFixture(),'SECRET_ARGV'];
    const run=await h.call('run',args);expect(run.code,run.err).toBe(0);const id=run.value.data.id;
    const accepted=await until(()=>h.call('status',[id]),r=>r.value?.data.notification.state==='accepted',4000);
    expect(accepted.value.data.state).toBe('succeeded');expect(accepted.value.data.notification).toMatchObject({transport:'gbc',attempts:1,needs_reconciliation:false,receipt:{delivery:'accepted_temporal',delivery_code:2,dispatched:true,workflow_id:'workflow-fixture'}});
    expect(accepted.out).not.toContain('SECRET_');expect(accepted.out).not.toContain('delivered');
    const body=readFileSync(join(h.root,'notification-body'),'utf8');expect(body.length).toBeLessThan(1024);expect(body).not.toContain('SECRET_');
    expect(Object.keys(JSON.parse(body))).toEqual(['version','event_id','task_id','state','exit_code','error_code']);
    expect(JSON.parse(body)).toMatchObject({version:1,event_id:id+':terminal:1',task_id:id,state:'succeeded',exit_code:0,error_code:null});
    expect((await h.call('run',args)).value.data.id).toBe(id);
    const info=readRegistration(h.state)!;expect((await request(info,'health',{})).notification_transport).toBe('gbc');
    await request(info,'shutdown',{});await until(async()=>alive(info.pid),v=>!v,3000);
    expect((await h.call('status',[id])).value.data.notification).toEqual(accepted.value.data.notification);
    expect(h.notificationCalls()).toHaveLength(1);expect(ledgerRows(h.state,'notify-accepted')).toHaveLength(1);
  });
  check('gbc notification explicit refusal is persistent and never changes task success',async h=>{
    h.mockNotifications({code:7,envelope:{schema_version:'1.0.0',ok:false,outcome:'known_failure',code:'refused',retryable:false,request_id:'fixture',data:{agent_id:'test-bot',message_id:'__MESSAGE_ID__',session_id:null,session_source:'default_unreported',dispatched:false,delivery:'refused',delivery_code:4,workflow_id:'workflow-refused',refusal:{failure_code:'denied',message:'SECRET_REFUSAL'}}}});
    const run=await h.call('run',['--bot','test-bot','--request-id','notice-refused','--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code,run.err).toBe(0);const id=run.value.data.id;
    const rejected=await until(()=>h.call('status',[id]),r=>r.value?.data.notification.state==='rejected',4000);
    expect(rejected.value.data.state).toBe('succeeded');expect(rejected.value.data.notification).toMatchObject({attempts:1,needs_reconciliation:false,last_code:'SEND_REFUSED',receipt:{delivery:'refused',delivery_code:4,dispatched:false,workflow_id:'workflow-refused'}});
    expect(rejected.out).not.toContain('SECRET_REFUSAL');expect((await h.call('wait',[id,'--timeout','0'])).code).toBe(0);
    await h.call('status',[id]);expect(h.notificationCalls()).toHaveLength(1);
  });
  check('gbc notification proven not dispatched is separate from uncertain writes',async h=>{
    h.mockNotifications({code:9,envelope:{schema_version:'1.0.0',ok:false,outcome:'known_failure',code:'auth_revoked',retryable:false,request_id:'fixture',error:{message:'SECRET_AUTH_DIAGNOSTIC',details:{rpc_dispatched:false}}}});
    const run=await h.call('run',['--bot','test-bot','--request-id','notice-not-dispatched','--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code).toBe(0);const id=run.value.data.id;
    const result=await until(()=>h.call('status',[id]),r=>r.value?.data.notification.state==='not_dispatched',4000);
    expect(result.value.data.state).toBe('succeeded');expect(result.value.data.notification).toMatchObject({attempts:1,last_code:'NOT_DISPATCHED',needs_reconciliation:false});
    expect(result.out).not.toContain('SECRET_AUTH_DIAGNOSTIC');expect(h.notificationCalls()).toHaveLength(1);
  });
  check('gbc notification retries only proven pre-dispatch retryable failures with a fixed budget',async h=>{
    h.mockNotifications({code:8,envelope:{schema_version:'1.0.0',ok:false,outcome:'known_failure',code:'auth_refresh_network',retryable:true,request_id:'fixture',error:{message:'SECRET_RETRY',details:{rpc_dispatched:false}}}});
    const run=await h.call('run',['--bot','test-bot','--request-id','notice-safe-retry','--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code).toBe(0);const id=run.value.data.id;
    const result=await until(()=>h.call('status',[id]),r=>r.value?.data.notification.state==='not_dispatched'&&r.value.data.notification.attempts===3,4000);
    expect(result.value.data.state).toBe('succeeded');expect(result.out).not.toContain('SECRET_RETRY');
    expect(h.notificationCalls()).toHaveLength(3);expect(new Set(h.notificationCalls().map(c=>c.message_id)).size).toBe(1);
    const info=readRegistration(h.state)!;await request(info,'shutdown',{});await until(async()=>alive(info.pid),v=>!v,3000);
    expect((await h.call('status',[id])).value.data.notification.attempts).toBe(3);expect(h.notificationCalls()).toHaveLength(3);
  });
  check('gbc notification daemon crash recovers inflight as unknown without replay',async h=>{
    h.mockNotifications({extra:'while :; do :; done'});
    const run=await h.call('run',['--bot','test-bot','--request-id','notice-crash','--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code).toBe(0);const id=run.value.data.id;
    await until(async()=>h.notificationCalls(),calls=>calls.length===1);
    const old=readRegistration(h.state)!;expect((await h.call('status',[id])).value.data.notification.state).toBe('inflight');
    process.kill(old.pid,'SIGKILL');await until(async()=>alive(old.pid),v=>!v,3000);
    const sender=h.notificationCalls()[0]!.pid;if(alive(sender)){process.kill(sender,'SIGKILL');await until(async()=>alive(sender),v=>!v,3000);}
    const restarted=await h.call('status',[id]);expect(restarted.code,restarted.err).toBe(0);
    expect(restarted.value.data).toMatchObject({state:'succeeded',notification:{state:'unknown',attempts:1,needs_reconciliation:true,last_code:'INTERRUPTED_SEND'}});
    await h.call('status',[id]);expect(h.notificationCalls()).toHaveLength(1);
  });
  check('gbc notification uncertain write reconciles by read-only send status without resending',async h=>{
    h.mockNotifications({envelope:'SECRET_LOST_RESPONSE',status:{schema_version:'1.0.0',ok:true,outcome:'known_success',code:'ok',retryable:false,request_id:'fixture',data:{agent_id:'test-bot',message_id:'__MESSAGE_ID__',session_id:null,session_source:'default_unreported',status:'accepted',status_code:2,echo_entry_id:'echo-fixture',rejection_code:null,accepted_at_ms:'1794454564087'}}});
    const run=await h.call('run',['--bot','test-bot','--request-id','notice-reconcile','--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code).toBe(0);const id=run.value.data.id;
    const result=await until(()=>h.call('status',[id]),r=>r.value?.data.notification.last_code==='STATUS_ACCEPTED',4000);
    expect(result.value.data).toMatchObject({state:'succeeded',notification:{state:'accepted',attempts:1,reconciliation_attempts:1,receipt:{status:'accepted',status_code:2,echo_entry_id:'echo-fixture',accepted_at_ms:'1794454564087'}}});
    expect(result.out).not.toContain('SECRET_LOST_RESPONSE');expect(result.out).not.toContain('delivered');expect(h.notificationCalls()).toHaveLength(1);
    const reads=readFileSync(join(h.root,'reconciliation-calls'),'utf8').trim().split('\n');expect(reads).toEqual([h.notificationCalls()[0]!.message_id]);
  });
  for(const [delivery,delivery_code] of [['accepted_box',1],['duplicate',3]] as const)
    check(`gbc notification preserves ${delivery} as acceptance evidence only`,async h=>{
      h.mockNotifications({envelope:{schema_version:'1.0.0',ok:true,outcome:'known_success',code:'ok',retryable:false,request_id:'fixture',data:{agent_id:'test-bot',message_id:'__MESSAGE_ID__',dispatched:false,delivery,delivery_code,workflow_id:null}}});
      const run=await h.call('run',['--bot','test-bot','--request-id','notice-'+delivery,'--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code).toBe(0);
      const result=await until(()=>h.call('status',[run.value.data.id]),r=>r.value?.data.notification.state==='accepted',4000);
      expect(result.value.data.notification.receipt).toMatchObject({delivery,delivery_code,dispatched:false,workflow_id:null});expect(h.notificationCalls()).toHaveLength(1);expect(result.out).not.toContain('delivered');
    });
  for(const [name,options] of [
    ['timeout',{extra:'while :; do :; done'}],
    ['lost-response',{extra:'exit 0'}],
    ['bad-json',{envelope:'SECRET_RAW_RESPONSE'}],
    ['unknown-outcome',{code:10,envelope:{schema_version:'1.0.0',ok:false,outcome:'unknown',code:'unknown',retryable:true,request_id:'fixture',error:{message:'SECRET_RAW_RESPONSE'}}}],
    ['possibly-dispatched',{code:8,envelope:{schema_version:'1.0.0',ok:false,outcome:'known_failure',code:'unavailable',retryable:true,request_id:'fixture',error:{message:'SECRET_RAW_RESPONSE',details:{rpc_dispatched:true}}}}],
    ['simulated',{envelope:{schema_version:'1.0.0',ok:true,outcome:'known_success',code:'ok',retryable:false,request_id:'fixture',simulated:true,data:{agent_id:'test-bot',message_id:'__MESSAGE_ID__',delivery:'accepted_temporal',delivery_code:2,dispatched:true,workflow_id:null}}}],
    ['wrong-message',{envelope:{schema_version:'1.0.0',ok:true,outcome:'known_success',code:'ok',retryable:false,request_id:'fixture',data:{agent_id:'test-bot',message_id:'other-message',delivery:'accepted_temporal',delivery_code:2,dispatched:true,workflow_id:null}}}],
    ['contradictory-dispatch',{code:8,envelope:{schema_version:'1.0.0',ok:false,outcome:'known_failure',code:'unavailable',retryable:true,request_id:'fixture',error:{details:{rpc_dispatched:false}},data:{delivery:'accepted_temporal',dispatched:true}}}],
    ['oversized-stdout',{extra:`while :; do printf '%s' '${'x'.repeat(4096)}'; done`}],
    ['oversized-stderr',{extra:`while :; do printf '%s' '${'x'.repeat(4096)}' >&2; done`}],
  ] as const)check(`gbc notification ${name} stays unknown and cannot auto-replay after restart`,async h=>{
    h.mockNotifications(options);
    const run=await h.call('run',['--bot','test-bot','--request-id','notice-'+name,'--cwd',h.cwd,'--',h.nativeFixture(name==='bad-json'?7:0)]);expect(run.code).toBe(0);const id=run.value.data.id;
    const unknown=await until(()=>h.call('status',[id]),r=>r.value?.data.notification.state==='unknown'&&r.value.data.notification.reconciliation_attempts===1,6500);
    expect(unknown.value.data.notification).toMatchObject({attempts:1,needs_reconciliation:true});expect(unknown.value.data.state).toBe(name==='bad-json'?'failed':'succeeded');
    expect(unknown.out).not.toContain('SECRET_RAW_RESPONSE');expect(unknown.out.length).toBeLessThan(2000);expect(h.notificationCalls()).toHaveLength(1);
    const sender=h.notificationCalls()[0]!.pid;expect(alive(sender)).toBe(false);
    const info=readRegistration(h.state)!;await request(info,'shutdown',{});await until(async()=>alive(info.pid),v=>!v,3000);
    expect((await h.call('status',[id])).value.data.notification).toEqual(unknown.value.data.notification);expect(h.notificationCalls()).toHaveLength(1);
    expect(readFileSync(join(h.root,'reconciliation-calls'),'utf8').trim().split('\n')).toHaveLength(1);
  });
  check('gbc notification absent transport preserves pending across daemon restart',async h=>{
    const host=(await h.startHost())!;
    const run=await h.call('run',['--bot','test-bot','--request-id','notice-unconfigured','--cwd',h.cwd,'--','claude']);expect(run.code).toBe(0);const id=run.value.data.id;
    expect((await h.call('wait',[id,'--timeout','5'])).value.data.task.notification).toMatchObject({state:'pending',transport:'not_configured',attempts:0});
    await request(host,'shutdown',{});await until(async()=>alive(host.pid),v=>!v,3000);
    expect((await h.call('status',[id])).value.data.notification).toMatchObject({state:'pending',transport:'not_configured',attempts:0,event_id:id+':terminal:1'});
    expect((await request(readRegistration(h.state)!,'health',{})).notification_transport).toBe('not_configured');expect(h.notificationCalls()).toHaveLength(0);
    h.mockNotifications();const restored=await until(()=>h.call('status',[id]),r=>r.value?.data.notification.state==='accepted',4000);
    expect(restored.value.data.notification).toMatchObject({event_id:id+':terminal:1',attempts:1});expect(h.notificationCalls()).toHaveLength(1);
  });
  check('gbc notification drain aborts a hung sender and persists uncertainty within a bounded stop',async h=>{
    h.mockNotifications({extra:'while :; do :; done'});
    const run=await h.call('run',['--bot','test-bot','--request-id','notice-drain','--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code).toBe(0);const id=run.value.data.id;
    await until(async()=>h.notificationCalls(),c=>c.length===1);const info=readRegistration(h.state)!;
    const started=Date.now();expect((await request(info,'drain',{})).active).toBe(0);expect(Date.now()-started).toBeLessThan(1500);
    expect(alive(h.notificationCalls()[0]!.pid)).toBe(false);
    expect((await h.call('status',[id])).value.data.notification).toMatchObject({state:'unknown',needs_reconciliation:true,attempts:1});expect(h.notificationCalls()).toHaveLength(1);
    await request(info,'shutdown',{});await until(async()=>alive(info.pid),v=>!v,3000);
  });
  check('gbc notification receipt fields are bounded and redact credential-shaped values',async h=>{
    h.mockNotifications({envelope:{schema_version:'1.0.0',ok:true,outcome:'known_success',code:'ok',retryable:false,request_id:'fixture',data:{agent_id:'test-bot',message_id:'__MESSAGE_ID__',dispatched:true,delivery:'accepted_temporal',delivery_code:2,workflow_id:'Bearer SYNTHETIC_PRIVATE_TOKEN',unexpected:'SECRET_UNEXPECTED'}}});
    const run=await h.call('run',['--bot','test-bot','--request-id','notice-safe-receipt','--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code).toBe(0);
    const result=await until(()=>h.call('status',[run.value.data.id]),r=>r.value?.data.notification.state==='accepted',4000);
    expect(result.value.data.notification.receipt.workflow_id).toBeNull();expect(result.out).not.toContain('SYNTHETIC_PRIVATE_TOKEN');expect(result.out).not.toContain('SECRET_UNEXPECTED');expect(result.out.length).toBeLessThan(2000);
  });
  for(const [status,status_code,expected] of [['rejected',3,'rejected'],['pending',4,'unknown'],['unknown_durability',5,'unknown']] as const)
    check(`gbc notification read-only ${status} never implies durable delivery or a resend`,async h=>{
      h.mockNotifications({extra:'exit 0',status:{schema_version:'1.0.0',ok:true,outcome:'known_success',code:'ok',retryable:false,request_id:'fixture',data:{agent_id:'test-bot',message_id:'__MESSAGE_ID__',status,status_code,echo_entry_id:null,rejection_code:status==='rejected'?'denied':null,accepted_at_ms:null}}});
      const run=await h.call('run',['--bot','test-bot','--request-id','notice-status-'+status,'--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code).toBe(0);
      const result=await until(()=>h.call('status',[run.value.data.id]),r=>r.value?.data.notification.state===expected&&r.value.data.notification.reconciliation_attempts===1,4000);
      expect(result.value.data.notification).toMatchObject({attempts:1,durability:'unverified',needs_reconciliation:expected==='unknown'});expect(h.notificationCalls()).toHaveLength(1);expect(result.out).not.toContain('delivered');
    });
  check('gbc notification drain also aborts read-only reconciliation without leaking its process',async h=>{
    h.mockNotifications({extra:'exit 0',statusExtra:'while :; do :; done'});
    const run=await h.call('run',['--bot','test-bot','--request-id','notice-drain-status','--cwd',h.cwd,'--',h.nativeFixture()]);expect(run.code).toBe(0);
    await until(async()=>h.reconciliationPids(),p=>p.length===1);const info=readRegistration(h.state)!;
    const started=Date.now();await request(info,'drain',{});expect(Date.now()-started).toBeLessThan(1500);expect(alive(h.reconciliationPids()[0]!)).toBe(false);
    expect((await h.call('status',[run.value.data.id])).value.data.notification).toMatchObject({state:'unknown',attempts:1,reconciliation_attempts:1});expect(h.notificationCalls()).toHaveLength(1);
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
