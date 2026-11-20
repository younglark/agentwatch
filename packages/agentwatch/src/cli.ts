import { Effect } from 'effect';
import { Argument,Command,Flag,CliOutput,CliConfig,GlobalFlag } from 'effect/cli';
import { BunServices } from '@effect/platform-bun';
import { homedir } from 'node:os';
import { join,resolve } from 'node:path';
import { CoreError,exitCodes,failure,integer,PROTOCOL } from './domain.ts';
import { ensure,request,startDaemon } from './service.ts';
declare const AGENTWATCH_COMPILED:boolean;
export const selfCommand=()=>typeof AGENTWATCH_COMPILED!=='undefined'&&AGENTWATCH_COMPILED
  ?[process.execPath]:[process.execPath,resolve(import.meta.dir,'main.ts')];
export async function runCli(args:string[]) {
  const task=<A>(run:()=>Promise<A>)=>Effect.tryPromise({try:run,catch:failure});
  const boundary=args.indexOf('--'),native=boundary<0?[]:args.slice(boundary+1),own=boundary<0?args:args.slice(0,boundary);
  const defaults=()=>({state:Flag.String('state').pipe(Flag.withDefault(join(homedir(),'.local','state','agentwatch-core'))),json:Flag.Boolean('json').pipe(Flag.withDefault(false))});
  async function invoke(command:string,state:string,data:unknown) {
    const info=await ensure(state,selfCommand());const value=await request(info,command,data);
    console.log(JSON.stringify({version:PROTOCOL,command,data:value}));
    if(command==='wait') {
      if(value.wait_timed_out)process.exitCode=exitCodes.WAIT_TIMEOUT;
      else if(value.task.state==='unknown')process.exitCode=exitCodes.UNKNOWN;
      else if(value.task.state==='failed')process.exitCode=1;
    }
  }
  const command=Command.make('agentwatch',{},()=>Effect.fail(new CoreError('USAGE','A command is required'))).pipe(Command.withSubcommands([
    Command.make('run',{...defaults(),bot:Flag.String('bot'),requestId:Flag.String('request-id'),cwd:Flag.String('cwd').pipe(Flag.withDefault(process.cwd()))},c=>task(async()=>{
      if(!native.length)throw new CoreError('USAGE','run requires a supported program after --');
      await invoke('run',c.state,{request_id:c.requestId,bot:c.bot,cwd:c.cwd,argv:native});
    })),
    Command.make('status',{...defaults(),id:Argument.String('task-id')},c=>task(()=>invoke('status',c.state,{id:c.id}))),
    Command.make('logs',{...defaults(),id:Argument.String('task-id'),stream:Flag.String('stream').pipe(Flag.withDefault('stdout')),offset:Flag.String('offset').pipe(Flag.withDefault('0')),limit:Flag.String('limit').pipe(Flag.withDefault('4096'))},c=>task(()=>invoke('logs',c.state,{id:c.id,stream:c.stream,offset:integer(Number(c.offset),'offset',Number.MAX_SAFE_INTEGER),limit:integer(Number(c.limit),'limit',65536)}))),
    Command.make('wait',{...defaults(),id:Argument.String('task-id'),timeout:Flag.String('timeout').pipe(Flag.withDefault('30'))},c=>task(()=>invoke('wait',c.state,{id:c.id,timeoutMs:integer(Number(c.timeout),'timeout',300)*1000}))),
    Command.make('cancel',{...defaults(),id:Argument.String('task-id')},c=>task(()=>invoke('cancel',c.state,{id:c.id}))),
    Command.make('internal-serve',defaults(),c=>task(async()=>{
      const service=await startDaemon(c.state);if(!service)return;
      const stop=()=>{void service.close();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
      try{await service.stopped;}finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
    })),
  ]));
  try {
    if(native.length&&own[0]!=='run')throw new CoreError('USAGE','Only run accepts native argv');
    await Effect.runPromise(Command.runWith(command,{version:'0.1.0',renderErrors:false})(own).pipe(Effect.provide(BunServices.layer),Effect.provide(CliConfig.layer({builtIns:[GlobalFlag.Help,GlobalFlag.Version]})),Effect.provide(CliOutput.layerPresenter({present:event=>event._tag==='Version'||(event._tag==='Help'&&event.reason==='Requested')?CliOutput.defaultPresenter.present(event):Effect.void}))));
  } catch(error) {
    const known=error instanceof CoreError?error:(error as {_tag?:string})?._tag==='ShowHelp'?new CoreError('USAGE','Invalid command or flags'):failure(error);
    console.error(JSON.stringify({version:PROTOCOL,error:{code:known.code,message:known.message}}));process.exitCode=exitCodes[known.code];
  }
}
