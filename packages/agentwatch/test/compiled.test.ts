import { beforeAll,afterAll } from 'bun:test';
import { mkdtempSync,mkdirSync,copyFileSync,chmodSync,rmSync,renameSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { commandContracts } from './command-contracts.ts';
const root=mkdtempSync(join(tmpdir(),'aw core binary-')),dir=join(root,'二进制 space'),empty=join(root,'empty-path');
const cli=join(dir,'agentwatch'),host=join(dir,'test-host');
const source=resolve('src'),hidden=resolve('.compiled-test-src');
beforeAll(()=>{
  mkdirSync(dir,{mode:0o700});mkdirSync(empty,{mode:0o700});
  copyFileSync(resolve('dist/agentwatch'),cli);chmodSync(cli,0o700);
  copyFileSync(resolve('dist/test-host'),host);chmodSync(host,0o700);
  if(existsSync(hidden))throw new Error('Refuse to overwrite hidden source directory');
  renameSync(source,hidden);
});
afterAll(()=>{if(existsSync(hidden)&&!existsSync(source))renameSync(hidden,source);rmSync(root,{recursive:true,force:true});});
// Harness creates per-case HOME and a PATH containing only its initially empty mock dir.
// Shared contracts use loopback HTTP + synthetic credentials; only native claude is executable.
commandContracts('compiled CLI isolated-PATH',[cli],[host],{PATH:empty,HOME:root,LANG:'C.UTF-8'});
