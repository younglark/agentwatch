// Dedicated subprocess testhost, never imported by production.
import {createAuthSession} from '../src/auth/session.ts';
const session=createAuthSession({platform:'darwin'});
await session.beginLogin();
try{await session.waitForLogin();console.log(JSON.stringify({completed:true}));}
catch{console.log(JSON.stringify({completed:false}));}
