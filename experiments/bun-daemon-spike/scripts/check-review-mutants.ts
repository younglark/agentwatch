// Bounded, reversible fault injection for the two approved review findings.
// Run alone, never concurrently with verify: only this experiment's source changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const mutants=[
  {name:'stale-queued-claim',file:'src/engine.ts',from:"if(t.state!=='queued')return false;",to:'/* mutant: ignore cancelled queue state */',filter:'deterministic claim',marker:'CANCEL_BARRIER_ASSERTION_FAILED claim'},
  {name:'launch-after-cancel',file:'src/engine.ts',from:"if(t.state!=='starting'||closed)return undefined;",to:'if(closed)return undefined;',filter:'deterministic launch',marker:'CANCEL_BARRIER_ASSERTION_FAILED launch'},
  {name:'ignored-stop',file:'src/main.ts',from:'setTimeout(stop,50)',to:'/* mutant: acknowledge but never stop */',filter:'strict stop',marker:'STRICT_STOP_FAILED_BEFORE_CLEANUP'},
  {name:'orphan-on-stop',file:'src/main.ts',from:'setTimeout(stop,50)',to:'setTimeout(()=>process.exit(0),50)',filter:'strict stop',marker:'STRICT_STOP_FAILED_BEFORE_CLEANUP'},
];
for(const mutant of mutants) {
  if(process.argv[2]&&process.argv[2]!==mutant.name)continue;
  const file=resolve(mutant.file),original=readFileSync(file,'utf8');
  if(original.split(mutant.from).length!==2)throw new Error('mutation marker not unique: '+mutant.name);
  console.log('MUTANT_BEGIN '+mutant.name);
  try {
    writeFileSync(file,original.replace(mutant.from,mutant.to));
    const p=Bun.spawn([process.execPath,'test','test/source.test.ts','-t',mutant.filter],{stdout:'pipe',stderr:'pipe'});
    const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
    console.log(out+err);
    if(code===0||!err.includes(mutant.marker)||!err.includes('(fail)'))throw new Error('mutant not rejected by intended assertion: '+mutant.name);
    if(mutant.filter.startsWith('deterministic')) {
      if(!err.includes('e.launches.filter')||!err.includes('Expected length: 0')||!err.includes('Received length: 1'))throw new Error('wrong cancellation failure');
    } else {
      const fallback=err.indexOf('SAFETY_CLEANUP_NOT_STOP_SUCCESS');
      if(fallback<0||err.indexOf(mutant.marker)>fallback)throw new Error('stop did not fail before rescue');
    }
    console.log(`MUTANT_KILLED ${mutant.name} exit=${code}`);
  } finally {
    writeFileSync(file,original);console.log('MUTANT_RESTORED '+mutant.name);
  }
}
