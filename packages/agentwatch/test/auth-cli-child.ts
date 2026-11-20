// Testhost only: exercise CLI platform branch without a production env escape.
import {setAuthPlatformForTests} from '../src/auth/platform.ts';
import {runCli} from '../src/cli.ts';
setAuthPlatformForTests('darwin');
await runCli(process.argv.slice(2));
