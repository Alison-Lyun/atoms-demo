import { z } from 'zod';
import type { AppState } from '@/lib/types';
import { getRepository } from '@/lib/server/repository';
import { reportPreview,runGeneration,emitSnapshot } from '@/lib/server/engine';
import { assertState } from '@/lib/server/lifecycle';
import { failure,readJson,eventResponse } from '@/lib/server/http';
export const runtime='nodejs';export const maxDuration=180;
export async function POST(request:Request,context:{params:Promise<{id:string;runId:string}>}){try{const {id,runId}=await context.params;const input=await readJson(request,z.object({versionId:z.uuid(),ok:z.boolean(),error:z.string().max(2000).optional(),stagedState:z.record(z.string(),z.unknown()),expectedDataRevision:z.number().int().nonnegative()}));assertState(input.stagedState);const repo=await getRepository();const result=await reportPreview(repo,id,runId,{...input,stagedState:input.stagedState as AppState});return eventResponse(async emit=>{if(result.repair)await runGeneration(repo,id,runId,emit,result.repair);else emitSnapshot(result.project,runId,emit);});}catch(e){return failure(e);}}
