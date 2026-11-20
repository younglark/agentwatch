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
  check('production gbc not_found denies admission and reports adapter availability',async h=>{
    h.mockGbc(5,{schema_version:'1.0.0',ok:false,outcome:'known_failure',code:'not_found',retryable:false,request_id:'fixture'});
    const run=await h.call('run',['--bot','test-bot','--request-id','gbc-missing','--cwd',h.cwd,'--','claude']);
    expect(run.code,run.err).toBe(5);expect(run.out).toBe('');expect(JSON.parse(run.err).error.code).toBe('BOT_FORBIDDEN');
    expect(ledgerRows(h.state,'gbc-missing')).toHaveLength(0);expect(h.receipts()).toHaveLength(0);
    const health=await request(readRegistration(h.state)!,'health',{});
    expect(health.bot_verifier).toBe('gbc');expect(health.notification_transport).toBe('not_configured');
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
