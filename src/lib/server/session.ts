import 'server-only';
import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RepositoryError } from './repository';

const cookieName = 'atoms_local_session';
type StorageSession = { mode: 'local'; ownerId: string } | { mode: 'supabase'; client: SupabaseClient };

export function storageConfiguration(): { mode: 'local' | 'supabase'; url?: string; key?: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const requestedMode = process.env.STORAGE_MODE;
  if (requestedMode && requestedMode !== 'local' && requestedMode !== 'supabase') {
    throw new RepositoryError('STORAGE_MODE 必须为 local 或 supabase。', 503, 'STORAGE_CONFIGURATION_ERROR');
  }
  if (requestedMode === 'supabase' || (requestedMode !== 'local' && (url || key))) {
    if (!url || !key) throw new RepositoryError('请同时配置 Supabase URL 与 publishable key。', 503, 'STORAGE_CONFIGURATION_ERROR');
    return { mode: 'supabase', url, key };
  }
  if (process.env.VERCEL || (process.env.NODE_ENV === 'production' && process.env.ATOMS_ALLOW_LOCAL_STORAGE !== 'true')) {
    throw new RepositoryError('生产部署需要 Supabase 持久化，请配置 STORAGE_MODE=supabase；本机生产预览需显式启用 ATOMS_ALLOW_LOCAL_STORAGE。', 503, 'PERSISTENT_STORAGE_REQUIRED');
  }
  return { mode: 'local' };
}

/** Call only inside a route handler before streaming a response, so refreshed cookies can be sent. */
export async function getStorageSession(): Promise<StorageSession> {
  const configuration = storageConfiguration();
  const jar = await cookies();
  if (configuration.mode === 'local') {
    let ownerId = jar.get(cookieName)?.value;
    if (!ownerId || !/^[a-f0-9]{64}$/.test(ownerId)) {
      ownerId = randomBytes(32).toString('hex');
      jar.set(cookieName, ownerId, {
        httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax',
        path: '/', maxAge: 60 * 60 * 24 * 365,
      });
    }
    return { mode: 'local', ownerId };
  }
  const client = createServerClient(configuration.url!, configuration.key!, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: values => { for (const { name, value, options } of values) jar.set(name, value, { ...options, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' }); },
    },
  });
  // getUser validates against Supabase Auth; never authorize from an unverified getSession result.
  const { data, error } = await client.auth.getUser();
  if (data.user) return { mode: 'supabase', client };
  if (error && error.name !== 'AuthSessionMissingError' && error.status !== 401 && error.status !== 403) {
    throw new RepositoryError('身份服务暂时不可用，请稍后重试。', 503, 'AUTH_UNAVAILABLE');
  }
  const { data: signedIn, error: signInError } = await client.auth.signInAnonymously();
  if (signInError || !signedIn.user) {
    throw new RepositoryError('匿名登录失败，请在 Supabase Auth 中启用 Anonymous Sign-Ins，并检查匿名登录配额。', 503, 'ANONYMOUS_AUTH_UNAVAILABLE');
  }
  return { mode: 'supabase', client };
}
