import {Schema} from 'effect';
import {CoreError} from './domain.ts';
import {defaultAuthSession,getAccessToken,peekAuthReady} from './auth/session.ts';
export const connectReady=()=>peekAuthReady();
export class RpcFailure extends Error {constructor(readonly code:string){super('Backend request failed');}}
const ErrorBody=Schema.Struct({code:Schema.String});
export async function connectRpc(method:'ListGrokBotAgents'|'SendGrokBotUserMessage'|'GetGrokBotSendStatus',body:unknown,signal?:AbortSignal):Promise<unknown>{
  const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(3000)]):AbortSignal.timeout(3000);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
    bounded.throwIfAborted();
    const credentials=await getAccessToken(bounded);
    bounded.throwIfAborted();
    const response=await fetch(`${credentials.backend}/aiserver.v1.GrokBotService/${method}`,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${credentials.accessToken}`,'content-type':'application/json','connect-protocol-version':'1'},body:JSON.stringify(body),signal:bounded});
    reader=response.body?.getReader();if(!reader)throw new RpcFailure('invalid_response');
    const chunks:Uint8Array[]=[];let size=0;
    for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>1048576)throw new RpcFailure('invalid_response');chunks.push(item.value);}
    if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))throw new RpcFailure('invalid_response');
    const data:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(response.status!==200){let code:string;try{code=Schema.decodeUnknownSync(ErrorBody)(data).code;}catch{throw new RpcFailure('invalid_response');}throw new RpcFailure(code);}
    return data;
  }catch(error){if(error instanceof RpcFailure)throw error;if(error instanceof CoreError)throw error;throw new RpcFailure('transport');}
  finally{try{await reader?.cancel();}catch{}reader?.releaseLock();}
}
export {defaultAuthSession};
