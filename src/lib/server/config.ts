import type { AppConfig } from '@/lib/types';
export const LIMITS={maxRepairAttempts:2,runTimeoutSeconds:180,maxPromptLength:4000,maxHtmlBytes:150_000,maxStateBytes:65_536,maxStateKeys:100};
export function modelSettings(){return {apiKey:process.env.MODEL_API_KEY||process.env.OPENAI_API_KEY||'',baseURL:process.env.MODEL_BASE_URL||'https://api.openai.com/v1',name:process.env.MODEL_NAME||'',mode:process.env.MODEL_API_MODE==='responses'?'responses':'chat'};}
export function appConfig():AppConfig {
  const model=modelSettings();
  const cloudConfigured=Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY||process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY));
  return {modelConfigured:Boolean(model.apiKey&&model.name),model:model.name||null,storageMode:process.env.STORAGE_MODE==='supabase'||(!process.env.STORAGE_MODE&&cloudConfigured)?'supabase':'local',cloudConfigured,fixturesEnabled:process.env.NODE_ENV!=='production'&&process.env.ENABLE_DEV_FIXTURES==='true',limits:LIMITS};
}
