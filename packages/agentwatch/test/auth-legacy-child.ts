// Test-only darwin fixture host. No production environment platform/auth override.
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createAuthSession} from '../src/auth/session.ts';
const pending=createAuthSession({platform:'darwin',env:process.env}).getAccessToken().then(value=>({ok:!process.env.AGENTWATCH_TEST_EXPECTED_ACCESS_SHA256||createHash('sha256').update(value.accessToken).digest('hex')===process.env.AGENTWATCH_TEST_EXPECTED_ACCESS_SHA256}),error=>({ok:false,code:error.code}));
await new Promise(resolve=>setTimeout(resolve,100));
writeFileSync(process.env.AGENTWATCH_TEST_READY!,'ready',{mode:0o600});
console.log(JSON.stringify(await pending));
