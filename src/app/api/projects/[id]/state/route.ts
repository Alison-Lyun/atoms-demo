import { z } from 'zod';
import type { JsonValue } from '@/lib/types';
import { getRepository } from '@/lib/server/repository';
import { saveState } from '@/lib/server/engine';
import { json,failure,readJson } from '@/lib/server/http';
export const runtime='nodejs';
export async function POST(request:Request,context:{params:Promise<{id:string}>}){try{const {id}=await context.params;const input=await readJson(request,z.object({versionId:z.uuid(),expectedDataRevision:z.number().int().nonnegative(),key:z.string().min(1).max(64),value:z.json()}),70000);return json(await saveState(await getRepository(),id,{...input,value:input.value as JsonValue}));}catch(e){return failure(e);}}
