import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError,publicError } from './errors';
import type { RunEvent } from '@/lib/types';
export const noStore={'Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','Expires':'0','X-Content-Type-Options':'nosniff'};
export function json(data:unknown,status=200){return NextResponse.json(data,{status,headers:noStore});}
export function failure(e:unknown){const out=publicError(e);return json(out,out.status);}
export function checkOrigin(request:Request){
  const origin=request.headers.get('origin');
  if(origin){
    let parsed:URL;try{parsed=new URL(origin);}catch{throw new AppError('请求来源无效。',403,'ORIGIN_MISMATCH');}
    // Next may normalize the internal request URL to localhost. The browser's Host header preserves the public authority.
    const authority=request.headers.get('host')||new URL(request.url).host;
    if(!['http:','https:'].includes(parsed.protocol)||parsed.host!==authority)throw new AppError('请求来源不匹配，请刷新后重试。',403,'ORIGIN_MISMATCH');
  }
  if(request.headers.get('sec-fetch-site')==='cross-site')throw new AppError('不允许跨站操作。',403,'ORIGIN_MISMATCH');
}
export async function readJson<T>(request:Request,schema:z.ZodType<T>,maxBytes=180_000):Promise<T>{
  checkOrigin(request);
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new AppError('请使用 JSON 请求。',415);
  if(Number(request.headers.get('content-length'))>maxBytes)throw new AppError('请求内容过大。',413);
  const reader=request.body?.getReader(); if(!reader)throw new AppError('请求为空。');
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new AppError('请求内容过大。',413);}chunks.push(value);}
  let parsed:unknown;try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AppError('请求 JSON 无效。');}
  const result=schema.safeParse(parsed);if(!result.success)throw new AppError('请求参数无效。请刷新后重试。',400,'INVALID_INPUT');return result.data;
}
export function eventResponse(work:(emit:(event:RunEvent)=>void)=>Promise<void>){
  const encoder=new TextEncoder();let connected=true;
  const stream=new ReadableStream<Uint8Array>({
    start(controller){
      const emit=(event:RunEvent)=>{if(connected){try{controller.enqueue(encoder.encode(JSON.stringify(event)+'\n'));}catch{connected=false;}}};
      void work(emit).catch(e=>{const err=publicError(e);emit({type:'error',error:err.error,code:err.code});}).finally(()=>{if(connected){try{controller.close();}catch{connected=false;}}});
    },cancel(){connected=false;}
  });
  return new Response(stream,{headers:{...noStore,'Content-Type':'application/x-ndjson; charset=utf-8','X-Accel-Buffering':'no'}});
}
