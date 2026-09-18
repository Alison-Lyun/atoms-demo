import { describe,it,expect } from 'vitest';
import { checkOrigin,readJson } from '../src/lib/server/http';
import { z } from 'zod';
describe('origin and request boundaries',()=>{
  it('uses external Host when Next normalizes its URL',()=>{expect(()=>checkOrigin(new Request('http://localhost:3000/api/projects',{headers:{host:'127.0.0.1:3000',origin:'http://127.0.0.1:3000','sec-fetch-site':'same-origin'}}))).not.toThrow();});
  it('rejects unrelated and opaque origins',()=>{for(const origin of ['https://evil.example','null'])expect(()=>checkOrigin(new Request('http://localhost:3000/api',{headers:{host:'localhost:3000',origin}}))).toThrow();});
  it('rejects explicit cross-site request even with matching origin',()=>{expect(()=>checkOrigin(new Request('https://app.example/api',{headers:{host:'app.example',origin:'https://app.example','sec-fetch-site':'cross-site'}}))).toThrow();});
  it('enforces byte limits without trusting Content-Length',async()=>{const req=new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'x'.repeat(100)})});await expect(readJson(req,z.object({text:z.string()}),30)).rejects.toMatchObject({status:413});});
});
