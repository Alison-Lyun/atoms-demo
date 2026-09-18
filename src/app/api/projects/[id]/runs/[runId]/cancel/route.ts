import { getRepository } from '@/lib/server/repository';
import { cancelRun } from '@/lib/server/engine';
import { json,failure,checkOrigin } from '@/lib/server/http';
export const runtime='nodejs';
export async function POST(request:Request,context:{params:Promise<{id:string;runId:string}>}){try{checkOrigin(request);const {id,runId}=await context.params;return json({project:await cancelRun(await getRepository(),id,runId)});}catch(e){return failure(e);}}
