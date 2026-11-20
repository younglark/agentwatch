import { Schema } from 'effect';
import { connectReady,connectRpc } from './connect-client.ts';
import { CoreError } from './domain.ts';
import { exitCodes,terminalStates } from './domain.ts';
import { type Store,type NotificationRecord } from './storage.ts';
export interface NoticeInput {message_id:string;bot:string;body:string;attempts:number}
export interface NoticeResult {state:'accepted'|'rejected'|'not_dispatched'|'unknown'|'pending';code:string;receipt?:Record<string,unknown>;next_attempt_at?:number}
export interface NotificationTransport {
  available():boolean;
  reconcile?(input:NoticeInput,signal:AbortSignal):Promise<NoticeResult & {state:'accepted'|'rejected'|'unknown'}>;
  send(input:NoticeInput,signal:AbortSignal):Promise<NoticeResult>;
}
const unknown=():NoticeResult=>({state:'unknown',code:'SEND_UNCERTAIN'});
// Receipt identifiers only: omit oversized/credential-shaped values rather than truncate them.
const receiptId=(value:string|null,max=128)=>value!==null&&value.length<=max&&/^[A-Za-z0-9_.:-]+$/.test(value)&&!/(?:bearer|eyJ[\w-]*\.|djEw|sk-|gh[pousr]_|github_pat_)/i.test(value)?value:null;
const Send=Schema.Struct({dispatched:Schema.optional(Schema.Boolean),delivery:Schema.Union([Schema.String,Schema.Number]),workflowId:Schema.optional(Schema.NullOr(Schema.String))});
const Status=Schema.Struct({status:Schema.Union([Schema.String,Schema.Number]),echoEntryId:Schema.optional(Schema.String),rejectionCode:Schema.optional(Schema.String),acceptedAtMs:Schema.optional(Schema.String)});
function enumCode(value:string|number,prefix:string,names:readonly string[]){
  if(typeof value==='number')return Number.isInteger(value)&&value>=0&&value<names.length?value:-1;
  return names.findIndex(name=>prefix+name.toUpperCase()===value);
}
function wireObject(raw:unknown,allowed:readonly string[]){if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!allowed.includes(key)))throw new Error('Invalid response');return raw;}
export const connectNotifications:NotificationTransport={
  available:connectReady,
  async send(input,signal){
    try{
      const raw=await connectRpc('SendGrokBotUserMessage',{agentId:input.bot,messageId:input.message_id,sessionId:'',text:input.body,sentAtMs:String(Date.now())},signal);
      const data=Schema.decodeUnknownSync(Send)(wireObject(raw,['dispatched','delivery','workflowId','mode','refusal']));
      const names=['unspecified','accepted_box','accepted_temporal','duplicate','refused'],code=enumCode(data.delivery,'GROK_BOT_USER_MESSAGE_DELIVERY_',names),delivery=names[code];
      if(code!==4&&(raw as {refusal?:unknown}).refusal!=null)return unknown();
      const receipt={agent_id:input.bot,message_id:input.message_id,delivery,delivery_code:code,dispatched:data.dispatched??false,workflow_id:receiptId(data.workflowId??null)};
      if(code===4)return {state:'rejected',code:'SEND_REFUSED',receipt};
      if(code>=1&&code<=3)return {state:'accepted',code:'SEND_ACCEPTED',receipt};
      return unknown();
    }catch(error){
      // Only our own credential loader proves that no HTTP request was dispatched.
      // A backend's rpc_dispatched/retryable claim is never pre-dispatch evidence.
      if(error instanceof CoreError&&error.code==='AUTH_NOT_CONFIGURED')return {state:'pending',code:'NOT_CONFIGURED'};
      return unknown();
    }
  },
  async reconcile(input,signal){
    try{
      const raw=await connectRpc('GetGrokBotSendStatus',{agentId:input.bot,messageId:input.message_id,sessionId:''},signal);
      const data=Schema.decodeUnknownSync(Status)(wireObject(raw,['status','echoEntryId','rejectionCode','acceptedAtMs']));
      const names=['unspecified','not_found','accepted','rejected','pending','unknown_durability'],code=enumCode(data.status,'GROK_BOT_SEND_STATUS_',names),status=names[code];
      const receipt={agent_id:input.bot,message_id:input.message_id,status,status_code:code,echo_entry_id:receiptId(data.echoEntryId??null),rejection_code:receiptId(data.rejectionCode??null,64),accepted_at_ms:data.acceptedAtMs!==undefined&&/^\d{1,20}$/.test(data.acceptedAtMs)?data.acceptedAtMs:null};
      if(code===2)return {state:'accepted',code:'STATUS_ACCEPTED',receipt};
      if(code===3)return {state:'rejected',code:'STATUS_REJECTED',receipt};
    }catch{}
    return {state:'unknown',code:'STATUS_UNCERTAIN'};
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
      if(result.state==='pending'&&result.code==='RETRY_NOT_DISPATCHED')result=row.attempts>=3
        ?{state:'not_dispatched',code:'NOT_DISPATCHED'}
        :{...result,next_attempt_at:Date.now()+250*2**(row.attempts-1)};
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
