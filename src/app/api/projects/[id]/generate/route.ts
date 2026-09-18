import { z } from 'zod';
import { getRepository } from '@/lib/server/repository';
import { beginGeneration,runGeneration,emitSnapshot } from '@/lib/server/engine';
import { failure,readJson,eventResponse } from '@/lib/server/http';
export const runtime='nodejs';export const maxDuration=180;
export async function POST(request:Request,context:{params:Promise<{id:string}>}){try{const {id}=await context.params;const input=await readJson(request,z.object({prompt:z.string().trim().min(1).max(4000),requestId:z.uuid(),baseVersionId:z.uuid().nullable()}));const repo=await getRepository();const result=await beginGeneration(repo,id,input);return eventResponse(async emit=>{if(result.started)await runGeneration(repo,id,result.runId,emit);else emitSnapshot(result.project,result.runId,emit);});}catch(e){return failure(e);}}
