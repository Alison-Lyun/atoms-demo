import { z } from 'zod';
import { getRepository } from '@/lib/server/repository';
import { restoreVersion } from '@/lib/server/engine';
import { json,failure,readJson } from '@/lib/server/http';
export const runtime='nodejs';
export async function POST(request:Request,context:{params:Promise<{id:string}>}){try{const {id}=await context.params;const input=await readJson(request,z.object({versionId:z.uuid(),requestId:z.uuid()}));return json({project:await restoreVersion(await getRepository(),id,input)});}catch(e){return failure(e);}}
