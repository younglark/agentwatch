import { test,expect } from 'bun:test';
import { readFileSync,writeFileSync,statSync,chmodSync } from 'node:fs';
import { join } from 'node:path';
import { commandHarness,until,alive } from './command-harness.ts';
import { readRegistration,request } from '../src/service.ts';
export function commandContracts(label:string,cli:readonly string[],host:readonly string[],env?:NodeJS.ProcessEnv) {
  const check=(name:string,body:(h:ReturnType<typeof commandHarness>)=>Promise<void>)=>test(`${label}: ${name}`,async()=>{
    const h=commandHarness(cli,host,env);try{await body(h);}finally{await h.cleanup();}
  },20000);
  check('five JSON commands preserve native argv and timeout never cancels',async h=>{
    await h.startHost();
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
    expect(h.receipts()).toHaveLength(0);
    await expect(request(info,'run',{request_id:'forged-test-adapter',bot:'test-bot',cwd:h.cwd,argv:['claude'],testOnly:true,verifier:'fake'})).rejects.toMatchObject({code:'AUTH_NOT_CONFIGURED'});
    const bypass=await h.call('run',['--fake-verifier','--bot','test-bot','--request-id','bypass','--','claude']);
    expect(bypass.code).toBe(2);expect(bypass.out).toBe('');
    const wizard=await h.call('run',['--wizard']);expect(wizard.code).toBe(2);expect(wizard.out).toBe('');expect(JSON.parse(wizard.err).error.code).toBe('USAGE');
    expect(run.err).not.toContain(info.token);
  });
  check('bot denial, program allowlist and malformed requests fail without stdout or spawn',async h=>{
    await h.startHost();
    const rejected=await h.call('run',['--bot','forbidden','--request-id','denied','--cwd',h.cwd,'--','grok','-p','hi']);
    expect(rejected.code).toBe(5);expect(rejected.out).toBe('');expect(h.receipts()).toHaveLength(0);
    const arbitrary=await h.call('run',['--bot','test-bot','--request-id','shell','--','sh','-c','echo hi']);expect(arbitrary.code).toBe(2);
    const missing=await h.call('status',['no-such-task']);expect(missing.code).toBe(3);expect(missing.out).toBe('');
    expect(JSON.parse(missing.err).version).toBe(1);
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
