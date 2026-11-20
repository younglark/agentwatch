import { Schema } from 'effect';
import { CoreError } from './domain.ts';
import { type Verifier } from './process.ts';
import { connectRpc,RpcFailure } from './connect-client.ts';
const Agents=Schema.Struct({agents:Schema.optional(Schema.Array(Schema.Struct({agentId:Schema.String}))),truncated:Schema.optional(Schema.Boolean)});
export const verifyConnect:Verifier=async input=>{
  try{
    const raw=await connectRpc('ListGrokBotAgents',{});
    // A CLI result envelope is not a Connect/protobuf response.
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['agents','slackConnections','truncated','teamsConnections'].includes(key)))throw new RpcFailure('invalid_response');
    const response=Schema.decodeUnknownSync(Agents)(raw);
    if(response.agents?.some(a=>a.agentId===input.bot))return;
    if(response.truncated)throw new CoreError('UNKNOWN','Bot lookup is truncated; no task was started');
    throw new CoreError('BOT_FORBIDDEN','Target must match an exact accessible agent_id');
  }catch(error){
    if(error instanceof CoreError)throw error;
    if(error instanceof RpcFailure){
      if(['auth','unauthenticated','auth_revoked','auth_refresh_unconfigured','auth_refresh_client_mismatch','auth_refresh_subject_mismatch'].includes(error.code))throw new CoreError('AUTH_NOT_CONFIGURED','Agentwatch credentials are unavailable');
      if(['not_found','denied','permission_denied'].includes(error.code))throw new CoreError('BOT_FORBIDDEN','Target agent_id is inaccessible');
    }
    throw new CoreError('TRANSPORT_NOT_CONFIGURED','Bot lookup failed; no task was started');
  }
};
