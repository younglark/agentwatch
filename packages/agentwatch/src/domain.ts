import { Schema } from 'effect';
import { basename, resolve } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
export const PROTOCOL=1;
export const terminalStates=['succeeded','failed','cancelled','unknown'] as const;
export type State='queued'|'starting'|'running'|'cancelling'|typeof terminalStates[number];
export const terminal=(state:string)=>terminalStates.includes(state as typeof terminalStates[number]);
export const exitCodes={INTERNAL:1,USAGE:2,NOT_FOUND:3,AUTH_NOT_CONFIGURED:4,BOT_FORBIDDEN:5,CONFLICT:6,IPC_AUTH:7,TRANSPORT_NOT_CONFIGURED:8,WAIT_TIMEOUT:9,UNKNOWN:10,DRAINING:11,VERSION_MISMATCH:12} as const;
export type ErrorCode=keyof typeof exitCodes;
export class CoreError extends Error {
  constructor(readonly code:ErrorCode,message:string){super(message);}
}
export function failure(error:unknown) {
  return error instanceof CoreError?error:new CoreError('INTERNAL','Operation failed; inspect private service diagnostics');
}
export const Input=Schema.Struct({request_id:Schema.String,bot:Schema.String,cwd:Schema.String,argv:Schema.Array(Schema.String)});
export type RunInput=typeof Input.Type;
export function normalize(value:unknown):RunInput {
  let input:RunInput;
  try{input=Schema.decodeUnknownSync(Input)(value);}catch{throw new CoreError('USAGE','Invalid run request');}
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(input.request_id)||!input.bot||input.bot.length>256)throw new CoreError('USAGE','Invalid request ID or bot');
  if(!input.argv.length||input.argv.some(s=>s.includes('\0'))||Buffer.byteLength(JSON.stringify(input.argv))>32768)throw new CoreError('USAGE','Invalid or oversized argv');
  // Program-name allowlist only, NOT a sandbox. Absolute paths are allowed for these names.
  if(!['claude','opencode','codex','grok'].includes(basename(input.argv[0]!)))throw new CoreError('USAGE','Program is not one of the four supported CLIs');
  let cwd:string;try{cwd=realpathSync(resolve(input.cwd));if(!statSync(cwd).isDirectory())throw new Error();}catch{throw new CoreError('USAGE','Working directory must exist');}
  return {request_id:input.request_id,bot:input.bot,cwd,argv:[...input.argv]};
}
export function integer(value:unknown,name:string,max:number) {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>max)throw new CoreError('USAGE',`Invalid ${name}`);
  return value;
}
