/** Cancellation bounds the caller, not the owner of a shared exchange. */
export function awaitSignal<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted){void work.catch(()=>{});return Promise.reject(signal.reason);}
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});
    work.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
export function deadline(ms:number,parent?:AbortSignal){
  const controller=new AbortController();
  const abort=()=>controller.abort(parent?.reason);
  if(parent?.aborted)abort();else parent?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(new DOMException('Deadline exceeded','TimeoutError')),ms);
  return {signal:controller.signal,dispose(){clearTimeout(timer);parent?.removeEventListener('abort',abort);}};
}
/** Covers headers AND streamed body; bounded allocation and cleanup even for non-cooperative HTTP adapters. */
export async function fetchJsonBounded(fetcher:typeof fetch,url:string,init:RequestInit,signal:AbortSignal,maxBytes=16384):Promise<{status:number;ok:boolean;body:any}>{
  let response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const work=fetcher(url,{...init,signal});
  void work.then(late=>{if(signal.aborted)void late.body?.cancel().catch(()=>{});},()=>{});
  try{
    response=await awaitSignal(work,signal);
    reader=response.body?.getReader();
    const chunks:Uint8Array[]=[];let size=0;
    if(reader)for(;;){
      const item=await awaitSignal(reader.read(),signal);if(item.done)break;
      size+=item.value.byteLength;if(size>maxBytes)throw new Error('Response too large');chunks.push(item.value);
    }
    let body:any;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{body=undefined;}
    return {status:response.status,ok:response.ok,body};
  }finally{
    if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
    else if(response)void response.body?.cancel().catch(()=>{});
  }
}
