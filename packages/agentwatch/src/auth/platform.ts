/** Platform auth is hard-wired: no auto mode and no production --auth / AUTH_MODE escape. */
export type AuthMode='independent'|'desktop';
let injected:NodeJS.Platform|undefined;
export function setAuthPlatformForTests(platform?:NodeJS.Platform){injected=platform;}
export function authPlatform():NodeJS.Platform{return injected??process.platform;}
export function authMode(platform:NodeJS.Platform=authPlatform()):AuthMode{
  return platform==='darwin'?'independent':'desktop';
}
export function independentHint(){return 'Open and sign in to the official Grok Bot desktop app. Independent login is only available on macOS.';}
export function desktopRejectedOnMac(){return 'macOS uses independent agentwatch credentials and will not read official sand-secrets.json or the keychain.';}
export function loginUnsupportedOnDesktop(){return 'This platform uses the official Grok Bot desktop session. Run the official app and sign in there; agentwatch login/logout are macOS-only.';}
