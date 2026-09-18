import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, open } from 'node:fs/promises';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { summary, type Project, type ProjectSummary } from '../types';

export interface Repository {
  listProjects(): Promise<ProjectSummary[]>;
  createProject(title: string): Promise<Project>;
  getProject(id: string): Promise<Project | null>;
  mutateProject(id: string, mutation: (draft: Project) => void): Promise<Project>;
}

export class RepositoryError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = 'RepositoryError';
  }
}

const notFound = () => new RepositoryError('项目不存在，或当前会话无权访问。', 404, 'PROJECT_NOT_FOUND');
const conflict = () => new RepositoryError('项目已被另一项操作更新，请刷新后重试。', 409, 'REVISION_CONFLICT');
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

// Shared by all repository instances in this Node process, including development reloads.
const globalLocks = globalThis as typeof globalThis & { __atomsRepositoryLocks?: Map<string, Promise<void>> };
const locks = globalLocks.__atomsRepositoryLocks ??= new Map<string, Promise<void>>();
async function locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  locks.set(key, tail);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

function newProject(title: string): Project {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), title: title.trim().slice(0, 120) || '未命名项目', createdAt: now,
    updatedAt: now, revision: 0, dataRevision: 0, currentVersionId: null,
    messages: [], versions: [], runs: [], appState: {},
  };
}

function applyMutation(project: Project, mutation: (draft: Project) => void): Project {
  const draft = structuredClone(project);
  const returned: unknown = mutation(draft);
  if (returned && typeof (returned as unknown as { then?: unknown }).then === 'function') {
    throw new RepositoryError('项目修改函数必须同步执行。', 500, 'ASYNC_MUTATION');
  }
  // The repository owns identity and revision fields; callbacks cannot move records.
  draft.id = project.id;
  draft.createdAt = project.createdAt;
  draft.revision = project.revision + 1;
  draft.updatedAt = new Date().toISOString();
  return draft;
}

async function readJson(file: string): Promise<Project | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as Project; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWrite(file: string, project: Project): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(project)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

/** Local single-process development storage. Use Supabase for multi-process/cloud deployments. */
export function createLocalRepository(ownerId: string, dataDir = process.env.LOCAL_DATA_DIR || path.join(process.cwd(), '.data')): Repository {
  if (!ownerId || ownerId.length < 16) throw new RepositoryError('缺少有效会话。', 401, 'INVALID_SESSION');
  const ownerDirectory = path.join(path.resolve(dataDir), createHash('sha256').update(ownerId).digest('hex'));
  const fileFor = (id: string) => path.join(ownerDirectory, `${id.toLowerCase()}.json`);
  return {
    async listProjects() {
      let entries: string[];
      try { entries = await readdir(ownerDirectory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      const projects = await Promise.all(entries.filter(name => name.endsWith('.json') && validId(name.slice(0, -5))).map(name => readJson(path.join(ownerDirectory, name))));
      return projects.filter((project): project is Project => project !== null).map(summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async createProject(title) {
      const project = newProject(title);
      await locked(fileFor(project.id), () => atomicWrite(fileFor(project.id), project));
      return structuredClone(project);
    },
    async getProject(id) {
      if (!validId(id)) return null;
      return readJson(fileFor(id));
    },
    async mutateProject(id, mutation) {
      if (!validId(id)) throw notFound();
      return locked(fileFor(id), async () => {
        const current = await readJson(fileFor(id));
        if (!current) throw notFound();
        const next = applyMutation(current, mutation);
        await atomicWrite(fileFor(id), next);
        return structuredClone(next);
      });
    },
  };
}

function cloudError(error: { code?: string; message?: string }): RepositoryError {
  if (error.code === '40001') return conflict();
  if (error.code === 'P0002' || error.code === '42501') return notFound();
  if (error.code === 'PGRST202' || error.code === '42P01') {
    return new RepositoryError('云数据库尚未初始化，请先执行 Supabase 迁移。', 503, 'STORAGE_NOT_INITIALIZED');
  }
  return new RepositoryError('云端存储暂时不可用，请稍后重试。', 503, 'STORAGE_UNAVAILABLE');
}

/** The authenticated client carries the user's JWT; no service-role credential is used. */
export function createSupabaseRepository(client: SupabaseClient): Repository {
  const getProject = async (id: string): Promise<Project | null> => {
    if (!validId(id)) return null;
    const { data, error } = await client.rpc('load_project_snapshot', { p_project_id: id });
    if (error) throw cloudError(error);
    return data as Project | null;
  };
  const save = async (project: Project, expectedRevision: number) => {
    const { error } = await client.rpc('save_project_snapshot', { p_project: project, p_expected_revision: expectedRevision });
    if (error) throw cloudError(error);
    return structuredClone(project);
  };
  return {
    async listProjects() {
      const { data, error } = await client.from('projects').select('id,title,created_at,updated_at,current_version_id,version_count').order('updated_at', { ascending: false });
      if (error) throw cloudError(error);
      return (data ?? []).map(row => ({ id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at, currentVersionId: row.current_version_id, versionCount: row.version_count }));
    },
    createProject: title => save(newProject(title), -1),
    getProject,
    async mutateProject(id, mutation) {
      const current = await getProject(id);
      if (!current) throw notFound();
      return save(applyMutation(current, mutation), current.revision);
    },
  };
}

export async function getRepository(): Promise<Repository> {
  const { getStorageSession } = await import('./session');
  const session = await getStorageSession();
  return session.mode === 'supabase' ? createSupabaseRepository(session.client) : createLocalRepository(session.ownerId);
}
