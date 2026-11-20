import { contracts } from './contracts.ts';
import { resolve } from 'node:path';
contracts('source',[process.execPath,resolve('src/main.ts')]);
