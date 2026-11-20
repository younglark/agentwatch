import { Schema } from 'effect';
import { execFile } from 'node:child_process';
import { gbcPath } from './gbc-verifier.ts';
import { exitCodes,terminalStates } from './domain.ts';
import { type Store,type NotificationRecord } from './storage.ts';
export interface NoticeInput {message_id:string;bot:string;body:string;attempts:number}
export interface NoticeResult {state:'accepted'|'rejected'|'not_dispatched'|'unknown'|'pending';code:string;receipt?:Record<string,unknown>;next_attempt_at?:number}
export interface NotificationTransport {
  available():boolean;
  reconcile?(input:NoticeInput,signal:AbortSignal):Promise<NoticeResult & {state:'accepted'|'rejected'|'unknown'}>;
  send(input:NoticeInput,signal:AbortSignal):Promise<NoticeResult>;
}
const Envelope=Schema.Struct({schema_version:Schema.Literal('1.0.0'),ok:Schema.Boolean,outcome:Schema.String,code:Schema.String,retryable:Schema.Boolean,request_id:Schema.String,simulated:Schema.optional(Schema.Boolean),data:Schema.optional(Schema.Unknown),error:Schema.optional(Schema.Struct({details:Schema.optional(Schema.Struct({rpc_dispatched:Schema.optional(Schema.Boolean)}))}))});
const SendData=Schema.Struct({agent_id:Schema.String,message_id:Schema.String,dispatched:Schema.Boolean,delivery:Schema.String,delivery_code:Schema.Number,workflow_id:Schema.NullOr(Schema.String)});
const unknown=():NoticeResult=>({state:'unknown',code:'SEND_UNCERTAIN'});
// Receipt identifiers only: omit oversized/credential-shaped values rather than truncate them.
const receiptId=(value:string|null,max=128)=>value!==null&&value.length<=max&&/^[A-Za-z0-9_.:-]+$/.test(value)&&!/(?:bearer|eyJ[\w-]*\.|djEw|sk-|gh[pousr]_|github_pat_)/i.test(value)?value:null;
async function runGbc(args:string[],body:string|undefined,signal:AbortSignal){
    if(signal.aborted)return undefined;
    const file=gbcPath();if(!file)return undefined;
    const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('GBT_MOCK'))delete env[key];delete env.GBT_ALLOW_WRITES;
    return await new Promise<{code:number;out:string;err:string}|undefined>(resolve=>{
      try{
        const child=execFile(file,args,{env,timeout:3000,maxBuffer:1048576,killSignal:'SIGKILL',windowsHide:true},(error,out,err)=>{
          signal.removeEventListener('abort',abort);
          resolve(error&&typeof error.code!=='number'?undefined:{code:typeof error?.code==='number'?error.code:0,out,err});
        });
        const abort=()=>{child.kill('SIGKILL');};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
        child.stdin?.on('error',()=>{});
        try{child.stdin?.end(body===undefined?undefined:body+'\n');}catch{abort();} // callback observes close before settling
      }catch{resolve(undefined);}
    });
}
export const gbcNotifications:NotificationTransport={
  available:()=>!!gbcPath(),
  async send(input,signal){
    const result=await runGbc(['--json','--allow-writes','message','send',`--agent-id=${input.bot}`,`--message-id=${input.message_id}`,'--text-stdin'],input.body,signal);
    if(!result)return unknown();
    try{
      const envelope=Schema.decodeUnknownSync(Envelope)(JSON.parse(result.code===0?result.out:result.err));
      if(envelope.simulated)return unknown();
      if(result.code!==0&&!envelope.ok&&envelope.outcome==='known_failure'&&envelope.data===undefined&&envelope.error?.details?.rpc_dispatched===false)
        return envelope.retryable&&result.code===8&&input.attempts<3
          ?{state:'pending',code:'RETRY_NOT_DISPATCHED',next_attempt_at:Date.now()+250*2**(input.attempts-1)}
          :{state:'not_dispatched',code:'NOT_DISPATCHED'};
      if(envelope.retryable)return unknown();
      const data=Schema.decodeUnknownSync(SendData)(envelope.data);
      if(data.agent_id!==input.bot||data.message_id!==input.message_id)return unknown();
      const receipt={agent_id:data.agent_id,message_id:data.message_id,delivery:data.delivery,delivery_code:data.delivery_code,dispatched:data.dispatched,workflow_id:receiptId(data.workflow_id)};
      if(result.code===7&&!envelope.ok&&envelope.outcome==='known_failure'&&envelope.code==='refused'&&data.delivery_code===4&&data.delivery==='refused')
        return {state:'rejected',code:'SEND_REFUSED',receipt};
      if(envelope.ok&&envelope.outcome==='known_success'&&envelope.code==='ok'&&result.code===0&&((data.delivery_code===1&&data.delivery==='accepted_box')||(data.delivery_code===2&&data.delivery==='accepted_temporal')||(data.delivery_code===3&&data.delivery==='duplicate')))
        return {state:'accepted',code:'SEND_ACCEPTED',receipt};
      return unknown();
    }catch{return unknown();}
  },
  async reconcile(input,signal){
    const result=await runGbc(['--json','message','status',`--agent-id=${input.bot}`,`--message-id=${input.message_id}`],undefined,signal);
    if(!result)return {state:'unknown',code:'STATUS_UNCERTAIN'};
    try{
      const envelope=Schema.decodeUnknownSync(Envelope)(JSON.parse(result.code===0?result.out:result.err));
      if(result.code!==0||!envelope.ok||envelope.simulated||envelope.retryable||envelope.outcome!=='known_success'||envelope.code!=='ok')return {state:'unknown',code:'STATUS_UNCERTAIN'};
      const data=Schema.decodeUnknownSync(Schema.Struct({agent_id:Schema.String,message_id:Schema.String,status:Schema.String,status_code:Schema.Number,echo_entry_id:Schema.NullOr(Schema.String),rejection_code:Schema.NullOr(Schema.String),accepted_at_ms:Schema.NullOr(Schema.String)}))(envelope.data);
      if(data.agent_id!==input.bot||data.message_id!==input.message_id)return {state:'unknown',code:'STATUS_UNCERTAIN'};
      const receipt={agent_id:data.agent_id,message_id:data.message_id,status:data.status,status_code:data.status_code,echo_entry_id:receiptId(data.echo_entry_id),rejection_code:receiptId(data.rejection_code,64),accepted_at_ms:data.accepted_at_ms!==null&&/^\d{1,20}$/.test(data.accepted_at_ms)?data.accepted_at_ms:null};
      if(data.status==='accepted'&&data.status_code===2)return {state:'accepted',code:'STATUS_ACCEPTED',receipt};
      if(data.status==='rejected'&&data.status_code===3)return {state:'rejected',code:'STATUS_REJECTED',receipt};
      return {state:'unknown',code:'STATUS_UNCERTAIN'};
    }catch{return {state:'unknown',code:'STATUS_UNCERTAIN'};}
  },
};
function inputFor(row:NotificationRecord & {request:string}):NoticeInput {
  const request=JSON.parse(row.request),payload=JSON.parse(row.payload);
  if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(row.task_id)||row.event_id!==row.task_id+':terminal:1'||!terminalStates.includes(row.terminal as typeof terminalStates[number])||!row.message_id||typeof request.bot!=='string'||!request.bot||request.bot.length>256||request.bot.includes('\0'))throw new Error('Invalid notification');
  // Frozen result fields only: never send argv, cwd, logs, native errors or a report file.
  const error=typeof payload.error_code==='string'&&(Object.hasOwn(exitCodes,payload.error_code)||['OBSERVATION_LOST','SPAWN_FAILED'].includes(payload.error_code))?payload.error_code:null;
  return {attempts:row.attempts,message_id:row.message_id,bot:request.bot,body:JSON.stringify({version:1,event_id:row.event_id,task_id:row.task_id,state:row.terminal,exit_code:Number.isSafeInteger(payload.exit_code)?payload.exit_code:null,error_code:error})};
}
export function createNotifier(store:Store,transport:NotificationTransport,onError?:(error:unknown)=>void){
  let stopped=false,active:Promise<void>|undefined,controller:AbortController|undefined;
  async function work(){
    if(!transport.available())return;
    const pending=await store.claimNotification();
    const row=pending??(transport.reconcile?await store.claimReconciliation():undefined);if(!row)return;
    controller=new AbortController();if(stopped)controller.abort();
    if(pending){
      let result:NoticeResult;try{result=await transport.send(inputFor(row),controller.signal);}catch{result=unknown();}
      await store.completeNotification(row.event_id,result);
    }else{
      let result:NoticeResult & {state:'accepted'|'rejected'|'unknown'};
      try{result=await transport.reconcile!(inputFor(row),controller.signal);}catch{result={state:'unknown',code:'STATUS_UNCERTAIN'};}
      await store.completeReconciliation(row.event_id,result);
    }
  }
  return {
    kick(){if(stopped||active)return;active=work().catch(e=>onError?.(e)).finally(()=>{active=undefined;controller=undefined;});},
    async drain(){stopped=true;controller?.abort();await active;},
  };
}
