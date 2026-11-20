import { Schema } from 'effect';
import { execFile } from 'node:child_process';
import { CoreError } from './domain.ts';
import { type Verifier } from './process.ts';

// External CLI boundary only: no gbc SDK, protocol, credential reads or login flow.
export const gbcPath=()=>Bun.which('gbc',{PATH:process.env.PATH??''});
const Envelope=Schema.Struct({
  schema_version:Schema.Literal('1.0.0'),ok:Schema.Boolean,
  outcome:Schema.Literals(['known_success','known_failure','unknown']),
  code:Schema.String,retryable:Schema.Boolean,request_id:Schema.String,
  simulated:Schema.optional(Schema.Boolean),data:Schema.optional(Schema.Unknown),
});
const BotData=Schema.Struct({bot:Schema.Struct({agent_id:Schema.String})});
const unavailable=()=>new CoreError('TRANSPORT_NOT_CONFIGURED','External bot lookup failed; no task was started');
export const verifyGbc:Verifier=async input=>{
  const file=gbcPath();
  if(!file)throw new CoreError('AUTH_NOT_CONFIGURED','Install gbc and log in independently before starting tasks');
  const env={...process.env};
  // A production verifier must never opt into gbc simulation via inherited env.
  for(const key of Object.keys(env))if(key.startsWith('GBT_MOCK'))delete env[key];
  delete env.GBT_ALLOW_WRITES;
  const result=await new Promise<{code:number;out:string;err:string}>((resolve,reject)=>{
    execFile(file,['--json','bot','get',`--agent-id=${input.bot}`],{
      env,timeout:3000,maxBuffer:1048576,killSignal:'SIGKILL',windowsHide:true,
    },(error,stdout,stderr)=>{
      if(error&&typeof error.code!=='number'){
        if(error.code==='ENOENT'||error.code==='EACCES')reject(new CoreError('AUTH_NOT_CONFIGURED','External gbc is not executable'));
        else reject(unavailable());
      }else resolve({code:typeof error?.code==='number'?error.code:0,out:stdout,err:stderr});
    }).stdin?.end();
  });
  let envelope:typeof Envelope.Type;
  try{envelope=Schema.decodeUnknownSync(Envelope)(JSON.parse(result.code===0?result.out:result.err));}
  catch{throw unavailable();}
  if(envelope.simulated)throw unavailable();
  if(envelope.outcome==='unknown')throw new CoreError('UNKNOWN','External bot lookup is inconclusive; no task was started');
  // bot.get preserves structured auth codes; gbc emitResult maps these to exit 9.
  const credentialFailure=result.code===9&&[
    'auth_revoked','auth_refresh_unconfigured','auth_refresh_client_mismatch','auth_refresh_subject_mismatch',
  ].includes(envelope.code);
  if(!envelope.ok&&envelope.outcome==='known_failure'&&!envelope.retryable&&
    ((result.code===4&&['auth','unauthenticated'].includes(envelope.code))||credentialFailure))
    throw new CoreError('AUTH_NOT_CONFIGURED','Log in with gbc independently before starting tasks');
  if(!envelope.ok&&envelope.outcome==='known_failure'&&
    ((result.code===5&&envelope.code==='not_found')||(result.code===7&&['denied','permission_denied'].includes(envelope.code))))
    throw new CoreError('BOT_FORBIDDEN','Target agent_id is not accessible to the gbc account');
  if(result.code===0&&envelope.ok&&envelope.code==='ok'&&envelope.outcome==='known_success'&&!envelope.retryable){
    let data:typeof BotData.Type;
    try{data=Schema.decodeUnknownSync(BotData)(envelope.data);}catch{throw unavailable();}
    // gbc get also accepts numeric server ids. agentwatch deliberately does not.
    if(data.bot.agent_id!==input.bot)throw new CoreError('BOT_FORBIDDEN','Target must match an exact accessible agent_id');
    return;
  }
  throw unavailable();
};
