/** Unverified JWT display/binding fields only. Never derive client_id from a token. */
export type JwtClaims={exp?:number;sub?:string;iss?:string};
export function decodeJwtClaims(token:string):JwtClaims|undefined{
  const parts=token.split('.');
  if(parts.length!==3||!parts[1])return undefined;
  try{
    const json=Buffer.from(parts[1], 'base64url').toString('utf8');
    const data=JSON.parse(json) as Record<string,unknown>;
    if(!data||typeof data!=='object')return undefined;
    const claims:JwtClaims={};
    if(typeof data.exp==='number'&&Number.isFinite(data.exp))claims.exp=data.exp;
    if(typeof data.sub==='string'&&data.sub)claims.sub=data.sub;
    if(typeof data.iss==='string'&&data.iss)claims.iss=data.iss;
    return claims;
  }catch{return undefined;}
}
export function decodeJwtExpMs(token:string):number|undefined{
  const exp=decodeJwtClaims(token)?.exp;
  return exp===undefined?undefined:exp*1000;
}
export function decodeJwtSubject(token:string):string|undefined{
  return decodeJwtClaims(token)?.sub;
}
