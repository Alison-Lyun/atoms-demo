import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Project } from '../src/lib/types';
import { createLocalRepository, createSupabaseRepository } from '../src/lib/server/repository';
import { getStorageSession, storageConfiguration } from '../src/lib/server/session';

const sessionMocks = vi.hoisted(() => ({
  cookieValues: new Map<string, string>(),
  setCookie: vi.fn(),
  getUser: vi.fn(),
  signInAnonymously: vi.fn(),
  createServerClient: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({
  get: (name: string) => sessionMocks.cookieValues.has(name) ? { value: sessionMocks.cookieValues.get(name) } : undefined,
  getAll: () => [...sessionMocks.cookieValues].map(([name, value]) => ({ name, value })),
  set: sessionMocks.setCookie,
}) }));
vi.mock('@supabase/ssr', () => ({ createServerClient: sessionMocks.createServerClient }));

const directories: string[] = [];
const ownerA = 'a'.repeat(64);
const ownerB = 'b'.repeat(64);
async function directory() {
  const result = await mkdtemp(path.join(tmpdir(), 'atoms-repository-'));
  directories.push(result);
  return result;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('local repository persistence and isolation', () => {
  it('reopens messages, app data and ready versions from disk', async () => {
    const dir = await directory();
    const repository = createLocalRepository(ownerA, dir);
    const project = await repository.createProject('持久化测试');
    await repository.mutateProject(project.id, draft => {
      draft.messages.push({ id: 'message-1', role: 'user', content: '创建笔记', createdAt: project.createdAt });
      draft.versions.push({ id: 'version-1', number: 1, parentVersionId: null, html: '<p>Notes</p>', title: '笔记', summary: '第一版', createdAt: project.createdAt, status: 'ready', source: 'generate', validationErrors: [] });
      draft.currentVersionId = 'version-1';
      draft.appState = { notes: [{ content: '内容保留', done: false }] };
      draft.dataRevision = 1;
    });
    const reopened = createLocalRepository(ownerA, dir);
    const loaded = await reopened.getProject(project.id);
    expect(loaded).toMatchObject({ revision: 1, dataRevision: 1, currentVersionId: 'version-1', appState: { notes: [{ content: '内容保留', done: false }] } });
    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.versions).toHaveLength(1);
    expect(await reopened.listProjects()).toEqual([expect.objectContaining({ id: project.id, versionCount: 1 })]);
    expect(loaded).not.toHaveProperty('ownerId');
  });

  it('does not reveal or mutate another session project, including with a known id', async () => {
    const dir = await directory();
    const a = createLocalRepository(ownerA, dir);
    const b = createLocalRepository(ownerB, dir);
    const project = await a.createProject('私有项目');
    expect(await b.listProjects()).toEqual([]);
    expect(await b.getProject(project.id)).toBeNull();
    await expect(b.mutateProject(project.id, draft => { draft.title = '越权'; })).rejects.toMatchObject({ status: 404 });
    expect((await a.getProject(project.id))?.title).toBe('私有项目');
    expect(await a.getProject('../../outside')).toBeNull();
    await expect(a.mutateProject('../../outside', () => {})).rejects.toMatchObject({ status: 404 });
  });

  it('serializes concurrent updates across independent local repository instances', async () => {
    const dir = await directory();
    const repository = createLocalRepository(ownerA, dir);
    const project = await repository.createProject('并发计数');
    await Promise.all(Array.from({ length: 40 }, () => createLocalRepository(ownerA, dir).mutateProject(project.id, draft => {
      draft.appState.count = Number(draft.appState.count ?? 0) + 1;
    })));
    expect(await repository.getProject(project.id)).toMatchObject({ revision: 40, appState: { count: 40 } });
    const [ownerDir] = await readdir(dir);
    expect(await readdir(path.join(dir, ownerDir))).toEqual([`${project.id}.json`]);
  });

  it('rolls back thrown mutations and releases the lock for subsequent work', async () => {
    const repository = createLocalRepository(ownerA, await directory());
    const project = await repository.createProject('事务测试');
    await expect(repository.mutateProject(project.id, draft => {
      draft.appState.secret = 'must not persist';
      draft.title = 'must not persist';
      throw new Error('validation failed');
    })).rejects.toThrow('validation failed');
    expect(await repository.getProject(project.id)).toEqual(project);
    const updated = await repository.mutateProject(project.id, draft => { draft.appState.ok = true; });
    expect(updated).toMatchObject({ revision: 1, title: '事务测试', appState: { ok: true } });
  });

  it('protects identity, creation time and revision from mutator changes', async () => {
    const repository = createLocalRepository(ownerA, await directory());
    const project = await repository.createProject('身份测试');
    const updated = await repository.mutateProject(project.id, draft => {
      draft.id = 'different'; draft.createdAt = 'different'; draft.revision = 500;
    });
    expect(updated).toMatchObject({ id: project.id, createdAt: project.createdAt, revision: 1 });
    updated.appState.changedOutside = true;
    expect((await repository.getProject(project.id))?.appState).toEqual({});
  });
});

describe('Supabase repository compare-and-swap adapter', () => {
  it('sends an expected revision and reports concurrent commits as a 409', async () => {
    // Models the RPC contract. Real RLS and PostgreSQL transaction checks require
    // a configured Supabase deployment; this does not claim to verify them.
    let stored: Project | null = null;
    const client = {
      async rpc(name: string, args: { p_project?: Project; p_expected_revision?: number }) {
        if (name === 'load_project_snapshot') return { data: structuredClone(stored), error: null };
        if (stored && args.p_expected_revision !== stored.revision) return { data: null, error: { code: '40001' } };
        stored = structuredClone(args.p_project!);
        return { data: null, error: null };
      },
    } as unknown as SupabaseClient;
    const repository = createSupabaseRepository(client);
    const project = await repository.createProject('CAS 测试');
    const results = await Promise.allSettled([
      repository.mutateProject(project.id, draft => { draft.appState.winner = 'a'; }),
      repository.mutateProject(project.id, draft => { draft.appState.winner = 'b'; }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    expect(await repository.getProject(project.id)).toMatchObject({ revision: 1, appState: { winner: 'a' } });
  });

  it('does not call the save RPC after a mutation throws', async () => {
    let saves = 0;
    const snapshot = await createLocalRepository(ownerA, await directory()).createProject('回滚');
    const client = {
      async rpc(name: string) {
        if (name === 'load_project_snapshot') return { data: structuredClone(snapshot), error: null };
        saves += 1; return { data: null, error: null };
      },
    } as unknown as SupabaseClient;
    await expect(createSupabaseRepository(client).mutateProject(snapshot.id, draft => {
      draft.appState.invalid = true; throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(saves).toBe(0);
  });
});

describe('server storage sessions', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    for (const name of ['STORAGE_MODE', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'VERCEL', 'ATOMS_ALLOW_LOCAL_STORAGE']) vi.stubEnv(name, '');
    vi.clearAllMocks();
    sessionMocks.cookieValues.clear();
    sessionMocks.setCookie.mockImplementation((name: string, value: string) => sessionMocks.cookieValues.set(name, value));
    sessionMocks.createServerClient.mockReturnValue({ auth: { getUser: sessionMocks.getUser, signInAnonymously: sessionMocks.signInAnonymously } });
  });

  it('creates a 32-byte random HttpOnly cookie and reuses the identity', async () => {
    const first = await getStorageSession();
    expect(first.mode).toBe('local');
    if (first.mode !== 'local') throw new Error('unexpected storage');
    expect(first.ownerId).toMatch(/^[a-f0-9]{64}$/);
    expect(sessionMocks.setCookie).toHaveBeenCalledWith('atoms_local_session', first.ownerId, expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }));
    expect(await getStorageSession()).toEqual(first);
    expect(sessionMocks.setCookie).toHaveBeenCalledTimes(1);
    sessionMocks.cookieValues.clear();
    const second = await getStorageSession();
    expect(second).not.toEqual(first);
  });

  it('replaces an invalid local cookie', async () => {
    sessionMocks.cookieValues.set('atoms_local_session', '../outside');
    await getStorageSession();
    expect(sessionMocks.cookieValues.get('atoms_local_session')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed in production and never permits local storage on Vercel', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(storageConfiguration).toThrow(expect.objectContaining({ code: 'PERSISTENT_STORAGE_REQUIRED' }));
    vi.stubEnv('ATOMS_ALLOW_LOCAL_STORAGE', 'true');
    expect(storageConfiguration()).toEqual({ mode: 'local' });
    vi.stubEnv('VERCEL', '1');
    expect(storageConfiguration).toThrow(expect.objectContaining({ code: 'PERSISTENT_STORAGE_REQUIRED' }));
  });

  it('rejects partial cloud credentials without silently selecting local storage', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    expect(storageConfiguration).toThrow(expect.objectContaining({ code: 'STORAGE_CONFIGURATION_ERROR' }));
  });

  it('validates an existing cloud user before repository access', async () => {
    vi.stubEnv('STORAGE_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'test-public-key');
    sessionMocks.getUser.mockResolvedValue({ data: { user: { id: 'verified-user' } }, error: null });
    expect((await getStorageSession()).mode).toBe('supabase');
    expect(sessionMocks.getUser).toHaveBeenCalledTimes(1);
    expect(sessionMocks.signInAnonymously).not.toHaveBeenCalled();
  });

  it('creates anonymous auth only when the validated session is absent', async () => {
    vi.stubEnv('STORAGE_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'test-public-key');
    sessionMocks.getUser.mockResolvedValue({ data: { user: null }, error: { name: 'AuthSessionMissingError' } });
    sessionMocks.signInAnonymously.mockResolvedValue({ data: { user: { id: 'new-anonymous-user' } }, error: null });
    expect((await getStorageSession()).mode).toBe('supabase');
    expect(sessionMocks.signInAnonymously).toHaveBeenCalledTimes(1);
    const options = sessionMocks.createServerClient.mock.calls[0][2];
    options.cookies.setAll([{ name: 'sb-auth-token', value: 'test-token', options: { maxAge: 60 } }], {});
    expect(sessionMocks.setCookie).toHaveBeenCalledWith('sb-auth-token', 'test-token', expect.objectContaining({ httpOnly: true, maxAge: 60 }));
  });

  it('does not mint a new identity or fall back to disk when Auth is unavailable', async () => {
    vi.stubEnv('STORAGE_MODE', 'supabase');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'test-public-key');
    sessionMocks.getUser.mockResolvedValue({ data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 503 } });
    await expect(getStorageSession()).rejects.toMatchObject({ status: 503, code: 'AUTH_UNAVAILABLE' });
    expect(sessionMocks.signInAnonymously).not.toHaveBeenCalled();
    expect(sessionMocks.setCookie).not.toHaveBeenCalled();
  });
});
