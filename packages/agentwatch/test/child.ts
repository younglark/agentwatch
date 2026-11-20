import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunInput } from '../src/domain.ts';
export async function runFixture(input:RunInput) {
  const argv=input.argv;
  appendFileSync(join(input.cwd,'fixture-spawns.jsonl'),JSON.stringify({request_id:input.request_id,pid:process.pid})+'\n',{mode:0o600});
  console.log(JSON.stringify({argv,cwd:process.cwd(),pid:process.pid}));
  console.error('fixture stderr');
  if(argv.includes('flood'))await Bun.write(Bun.stdout,'x'.repeat(200000));
  await Bun.sleep(argv.includes('long')?10000:150);
  process.exitCode=argv.includes('fail')?7:0;
}
if(import.meta.main)await runFixture(JSON.parse(process.argv[2]!));
