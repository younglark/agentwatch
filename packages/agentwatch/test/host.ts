// Separately compiled test executable only; never imported by the production bin.
import { startDaemon } from '../src/service.ts';
import { fixtureExecutor } from './fixtures.ts';
import { runFixture } from './child.ts';
import { CoreError } from '../src/domain.ts';
if(process.argv[2]==='fixture-child')await runFixture(JSON.parse(process.argv[3]!));
else {
  const host=await startDaemon(process.argv[2]!,{testOnly:true,verify:async input=>{if(input.bot!=='test-bot')throw new CoreError('BOT_FORBIDDEN','Test bot rejected');},execute:fixtureExecutor});
  if(host) {
    const close=()=>{void host.close();};process.once('SIGTERM',close);process.once('SIGINT',close);
    await host.stopped;
  }
}
