import { Schema } from 'effect';
import { openSync,closeSync,readSync,realpathSync,fstatSync,lstatSync,constants } from 'node:fs';
import { join,dirname,resolve } from 'node:path';
import { homedir } from 'node:os';
import { CoreError } from './domain.ts';
const Credentials=Schema.Struct({version:Schema.Literal(1),backend:Schema.String,client_id:Schema.optional(Schema.String),access_token:Schema.String,expires_at_ms:Schema.Number});
const authFailure=()=>new CoreError('AUTH_NOT_CONFIGURED','Configure agentwatch private credentials; browser login and refresh are not yet implemented');
export function loadCredentials(){
  let fd:number|undefined;
  try{
    const path=resolve(process.env.AGENTWATCH_CREDENTIALS??join(homedir(),'.agentwatch','auth','credentials.json'));
    // Never consume another application's credential store, even by explicit misconfiguration.
    if(path.split('/').some(s=>s==='.gbc'||s==='sand-secrets'))throw authFailure();
    if(process.platform==='win32'||realpathSync(path)!==path)throw authFailure();
    const dir=dirname(path),parent=lstatSync(dir);
    if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid?.()||(parent.mode&0o077)!==0)throw authFailure();
    fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.size>16384||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw authFailure();
    const buffer=Buffer.alloc(16385);let size=0;
    for(;;){const n=readSync(fd,buffer,size,buffer.length-size,null);size+=n;if(size>16384)throw authFailure();if(n===0)break;}
    const data=Schema.decodeUnknownSync(Credentials)(JSON.parse(buffer.subarray(0,size).toString('utf8'))),url=new URL(data.backend);
    const client=process.env.AGENTWATCH_CLIENT_ID??data.client_id;
    if(!client||client.length>512||/[\s\x00-\x1f]/.test(client)||(data.client_id!==undefined&&data.client_id!==client)||!Number.isSafeInteger(data.expires_at_ms)||data.expires_at_ms<=Date.now()||!data.access_token||data.access_token.length>8192||!/^[A-Za-z0-9._~+\/-]+=*$/.test(data.access_token))throw authFailure();
    if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname))))throw authFailure();
    const after=lstatSync(dir);if(parent.dev!==after.dev||parent.ino!==after.ino)throw authFailure();
    return {backend:url.origin,accessToken:data.access_token,clientId:client};
  }catch{throw authFailure();}finally{if(fd!==undefined)closeSync(fd);}
}
export const connectReady=()=>{try{loadCredentials();return true;}catch{return false;}};
export class RpcFailure extends Error {constructor(readonly code:string){super('Backend request failed');}}
const ErrorBody=Schema.Struct({code:Schema.String});
export async function connectRpc(method:'ListGrokBotAgents'|'SendGrokBotUserMessage'|'GetGrokBotSendStatus',body:unknown,signal?:AbortSignal):Promise<unknown>{
  const credentials=loadCredentials();
  const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(3000)]):AbortSignal.timeout(3000);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
    const response=await fetch(`${credentials.backend}/aiserver.v1.GrokBotService/${method}`,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${credentials.accessToken}`,'content-type':'application/json','connect-protocol-version':'1'},body:JSON.stringify(body),signal:bounded});
    reader=response.body?.getReader();if(!reader)throw new RpcFailure('invalid_response');
    const chunks:Uint8Array[]=[];let size=0;
    for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>1048576)throw new RpcFailure('invalid_response');chunks.push(item.value);}
    if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))throw new RpcFailure('invalid_response');
    const data:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(response.status!==200){let code:string;try{code=Schema.decodeUnknownSync(ErrorBody)(data).code;}catch{throw new RpcFailure('invalid_response');}throw new RpcFailure(code);}
    return data;
  }catch(error){if(error instanceof RpcFailure)throw error;throw new RpcFailure('transport');}
  finally{try{await reader?.cancel();}catch{}reader?.releaseLock();}
}
