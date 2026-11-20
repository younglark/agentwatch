// Test-only adapter. Not imported or selectable by production main/serve.
import { resolve } from 'node:path';
import { spawnArgv,type Executor } from '../src/process.ts';
declare const TEST_HOST_COMPILED:boolean;
export const fixtureExecutor:Executor=(input,files)=>spawnArgv(typeof TEST_HOST_COMPILED!=='undefined'&&TEST_HOST_COMPILED
 ?[process.execPath,'fixture-child',JSON.stringify(input)]
 :[process.execPath,resolve(import.meta.dir,'child.ts'),JSON.stringify(input)],input.cwd,files);
