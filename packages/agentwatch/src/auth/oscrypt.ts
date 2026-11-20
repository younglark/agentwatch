import {createCipheriv,createDecipheriv,pbkdf2Sync} from 'node:crypto';
export const OSCRYPT_SALT=Buffer.from('saltysalt');
export const OSCRYPT_IV=Buffer.from(' '.repeat(16));
export const LINUX_BASIC_PASSWORD='peanuts';
export const LINUX_PBKDF2_ITERATIONS=1;
export type OscryptVersion='v10'|'v11';
export function peekOscryptPrefix(blob:Buffer):OscryptVersion|undefined{
  if(blob.length>=3){const p=blob.subarray(0,3).toString('latin1');if(p==='v10'||p==='v11')return p;}
}
export function deriveOscryptKey(password:string|Buffer,iterations:number):Buffer{
  const pw=typeof password==='string'?Buffer.from(password,'utf8'):password;
  return pbkdf2Sync(pw,OSCRYPT_SALT,iterations,16,'sha1');
}
export function decryptOscrypt(blob:Buffer,password:string|Buffer,iterations:number):Buffer|undefined{
  if(!peekOscryptPrefix(blob))return undefined;
  const ct=blob.subarray(3);
  if(ct.length===0||ct.length%16!==0)return undefined;
  try{
    const decipher=createDecipheriv('aes-128-cbc',deriveOscryptKey(password,iterations),OSCRYPT_IV);
    return Buffer.concat([decipher.update(ct),decipher.final()]);
  }catch{return undefined;}
}
/** Test helper and documentation of the public Chromium basic_text password. Not used to persist production secrets. */
export function encryptOscryptV10(plain:Buffer|string,password:string,iterations:number):Buffer{
  const cipher=createCipheriv('aes-128-cbc',deriveOscryptKey(password,iterations),OSCRYPT_IV);
  const data=typeof plain==='string'?Buffer.from(plain,'utf8'):plain;
  return Buffer.concat([Buffer.from('v10','latin1'),cipher.update(data),cipher.final()]);
}
