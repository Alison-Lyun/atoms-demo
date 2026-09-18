import { z } from 'zod';
import { getRepository } from '@/lib/server/repository';
import { json,failure,readJson } from '@/lib/server/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(){try{const repo=await getRepository();return json({projects:await repo.listProjects()});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const input=await readJson(request,z.object({title:z.string().trim().min(1).max(120)}));const repo=await getRepository();return json({project:await repo.createProject(input.title)},201);}catch(e){return failure(e);}}
