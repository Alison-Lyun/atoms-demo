import { getRepository } from '@/lib/server/repository';
import { createFixture } from '@/lib/server/engine';
import { json,failure,checkOrigin } from '@/lib/server/http';
export const runtime='nodejs';
export async function POST(request:Request,context:{params:Promise<{id:string}>}){try{checkOrigin(request);const {id}=await context.params;return json({project:await createFixture(await getRepository(),id)});}catch(e){return failure(e);}}
