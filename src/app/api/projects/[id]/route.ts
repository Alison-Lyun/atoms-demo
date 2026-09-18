import { getRepository } from '@/lib/server/repository';
import { loadProject } from '@/lib/server/engine';
import { json,failure } from '@/lib/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){try{const {id}=await context.params;return json({project:await loadProject(await getRepository(),id)});}catch(e){return failure(e);}}
