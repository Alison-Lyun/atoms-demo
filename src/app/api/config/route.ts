import { appConfig } from '@/lib/server/config';
import { json } from '@/lib/server/http';
export const dynamic='force-dynamic';
export async function GET(){return json(appConfig());}
