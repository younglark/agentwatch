import { beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { contracts } from './contracts.ts';
const sandbox=mkdtempSync(join(tmpdir(),'aw-binary-'));
const exe=join(sandbox,'spike');
const source=resolve('src'),hidden=resolve('.source-hidden-for-compiled-test');
let moved=false;
beforeAll(()=>{
  copyFileSync(resolve('dist/spike'),exe);chmodSync(exe,0o700);
  mkdirSync(join(sandbox,'empty-path'));
  renameSync(source,hidden);moved=true;
});
afterAll(()=>{
  if(moved)renameSync(hidden,source);
  rmSync(sandbox,{recursive:true,force:true});
});
contracts('compiled PATH/source-isolated',[exe],{PATH:join(sandbox,'empty-path'),HOME:sandbox,TMPDIR:sandbox,LANG:'C'});
