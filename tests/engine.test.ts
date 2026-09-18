import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { summary, type Project, type RunEvent } from '../src/lib/types';
import { beginGeneration, cancelRun, reportPreview, restoreVersion, runGeneration } from '../src/lib/server/engine';
import { newRun } from '../src/lib/server/lifecycle';
import { generateArtifact } from '../src/lib/server/model';
import { TODO_FIXTURE } from '../src/lib/server/fixture';
import { RepositoryError, type Repository } from '../src/lib/server/repository';

vi.mock('../src/lib/server/model', () => ({ generateArtifact: vi.fn() }));
const generate = vi.mocked(generateArtifact);
const modelResult = {
  artifact: { title: '新版待办', summary: '保留数据并改进界面', html: TODO_FIXTURE, dataSchemaVersion: 1 as const },
  usage: { inputTokens: 123, outputTokens: 456 }, model: 'test-model',
};
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}
function baseline(): Project {
  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(), title: '原项目', createdAt: timestamp, updatedAt: timestamp,
    revision: 0, dataRevision: 2, currentVersionId: 'baseline-version',
    appState: { notes: ['保留内容'] }, messages: [], runs: [],
    versions: [{ id: 'baseline-version', number: 1, parentVersionId: null, html: '<p>Working baseline</p>', title: '原项目', summary: '原有版本', createdAt: timestamp, status: 'ready', source: 'generate', validationErrors: [] }],
  };
}

/** A snapshot repository that really discards failed drafts and compares
 * revisions at commit. Hooks reproduce the windows between read and commit. */
function casRepository(initial = baseline()) {
  let state = structuredClone(initial);
  const harness = {
    mutations: 0,
    commits: 0,
    remainingConflicts: 0,
    conflicts: 0,
    matchesConflict: (_draft: Project) => true,
    beforeCommit: undefined as undefined | ((draft: Project) => Promise<void>),
    afterRead: undefined as undefined | (() => void),
    snapshot: () => structuredClone(state),
    externalUpdate(mutation: (draft: Project) => void) {
      const next = structuredClone(state); mutation(next); next.revision++; state = next;
    },
    repo: undefined as unknown as Repository,
  };
  harness.repo = {
    async listProjects() { return [summary(state)]; },
    async createProject() { throw new Error('not used'); },
    async getProject(id) {
      if (id !== state.id) return null;
      const snapshot = structuredClone(state);
      const hook = harness.afterRead; harness.afterRead = undefined; hook?.();
      return snapshot;
    },
    async mutateProject(id, mutation) {
      harness.mutations++;
      if (id !== state.id) throw new RepositoryError('missing', 404, 'PROJECT_NOT_FOUND');
      const expected = state.revision;
      const draft = structuredClone(state);
      mutation(draft);
      await harness.beforeCommit?.(draft);
      if (harness.remainingConflicts > 0 && harness.matchesConflict(draft)) {
        harness.remainingConflicts--; harness.conflicts++;
        // A different harmless update committed after our snapshot was read.
        state = { ...state, revision: state.revision + 1 };
        throw new RepositoryError('revision conflict', 409, 'REVISION_CONFLICT');
      }
      if (state.revision !== expected) {
        harness.conflicts++;
        throw new RepositoryError('revision conflict', 409, 'REVISION_CONFLICT');
      }
      draft.revision = expected + 1; draft.updatedAt = new Date().toISOString();
      state = structuredClone(draft); harness.commits++;
      return structuredClone(state);
    },
  };
  return harness;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MODEL_API_KEY', 'test-key-not-a-secret');
  vi.stubEnv('MODEL_NAME', 'test-model');
  generate.mockResolvedValue(structuredClone(modelResult));
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('generation engine concurrency', () => {
  it('keeps a duplicate request read-only while the original worker commits a model result', async () => {
    const h = casRepository(), id = h.snapshot().id;
    const input = { prompt: '改进待办', requestId: randomUUID(), baseVersionId: 'baseline-version' };
    const start = await beginGeneration(h.repo, id, input);
    const enteredCommit = deferred<void>(), releaseCommit = deferred<void>();
    h.beforeCommit = async draft => {
      if (draft.runs[0].status === 'validating') { enteredCommit.resolve(); await releaseCommit.promise; }
    };
    const events: RunEvent[] = [];
    const worker = runGeneration(h.repo, id, start.runId, event => events.push(event));
    await enteredCommit.promise;
    const before = h.snapshot(), mutationCount = h.mutations;
    const duplicate = await beginGeneration(h.repo, id, input);
    expect(duplicate).toMatchObject({ started: false, runId: start.runId });
    expect(h.snapshot()).toEqual(before);
    expect(h.mutations).toBe(mutationCount);
    releaseCommit.resolve();
    await worker;
    expect(h.snapshot().runs[0].status).toBe('previewing');
    expect(h.conflicts).toBe(0);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.type).toBe('candidate');
  });

  it('does not claim to start or write a run that appeared between the idempotency read and mutation', async () => {
    const h = casRepository(), id = h.snapshot().id;
    const input = { prompt: '创建应用', requestId: randomUUID(), baseVersionId: 'baseline-version' };
    h.afterRead = () => h.externalUpdate(project => { newRun(project, input.prompt, input.requestId, 'generate', input.baseVersionId); });
    const result = await beginGeneration(h.repo, id, input);
    expect(result.started).toBe(false);
    expect(h.snapshot().runs).toHaveLength(1);
    expect(h.snapshot().revision).toBe(1);
    expect(h.commits).toBe(0);
  });

  it('retries a conflicted model-result write three times without charging tokens or adding versions twice', async () => {
    const h = casRepository(), id = h.snapshot().id;
    const start = await beginGeneration(h.repo, id, { prompt: '改进应用', requestId: randomUUID(), baseVersionId: 'baseline-version' });
    h.remainingConflicts = 3;
    h.matchesConflict = draft => draft.runs[0].status === 'validating' && draft.versions.length === 1;
    const events: RunEvent[] = [];
    await runGeneration(h.repo, id, start.runId, event => events.push(event));
    const project = h.snapshot();
    expect(h.conflicts).toBe(3);
    expect(project.runs[0]).toMatchObject({ status: 'previewing', inputTokens: 123, outputTokens: 456, attempt: 0 });
    expect(project.versions).toHaveLength(2);
    expect(project.currentVersionId).toBe('baseline-version');
    expect(project.appState).toEqual({ notes: ['保留内容'] });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.type).toBe('candidate');
  });

  it('stops after the initial attempt plus three CAS retries without marking another active worker failed', async () => {
    const h = casRepository(), id = h.snapshot().id;
    const start = await beginGeneration(h.repo, id, { prompt: '改进应用', requestId: randomUUID(), baseVersionId: 'baseline-version' });
    h.remainingConflicts = 99;
    const before = h.mutations, events: RunEvent[] = [];
    await runGeneration(h.repo, id, start.runId, event => events.push(event));
    expect(h.mutations - before).toBe(4);
    expect(h.conflicts).toBe(4);
    expect(h.snapshot().runs[0]).toMatchObject({ status: 'generating', error: null });
    expect(h.snapshot().versions).toHaveLength(1);
    expect(generate).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'REVISION_CONFLICT' });
  });

  it('retries cancellation and discards a late model result without touching the published code or data', async () => {
    const h = casRepository(), id = h.snapshot().id;
    const start = await beginGeneration(h.repo, id, { prompt: '改进应用', requestId: randomUUID(), baseVersionId: 'baseline-version' });
    const modelStarted = deferred<void>(), modelFinished = deferred<typeof modelResult>();
    let signal: AbortSignal | undefined;
    generate.mockImplementationOnce(async input => { signal = input.signal; modelStarted.resolve(); return modelFinished.promise; });
    const events: RunEvent[] = [];
    const worker = runGeneration(h.repo, id, start.runId, event => events.push(event));
    await modelStarted.promise;
    h.remainingConflicts = 2;
    h.matchesConflict = draft => draft.runs[0].status === 'cancelled';
    const cancelled = await cancelRun(h.repo, id, start.runId);
    expect(h.conflicts).toBe(2);
    expect(signal?.aborted).toBe(true);
    modelFinished.resolve(structuredClone(modelResult));
    await worker;
    expect(h.snapshot()).toEqual(cancelled);
    expect(cancelled).toMatchObject({ currentVersionId: 'baseline-version', appState: { notes: ['保留内容'] } });
    expect(cancelled.versions).toHaveLength(1);
    expect(cancelled.runs[0].status).toBe('cancelled');
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'CANCELLED' });
  });

  it('bounds cancellation retries and does not persist any cancelled draft on exhausted CAS', async () => {
    const h = casRepository(), id = h.snapshot().id;
    const start = await beginGeneration(h.repo, id, { prompt: '改进应用', requestId: randomUUID(), baseVersionId: 'baseline-version' });
    h.remainingConflicts = 99;
    const before = h.mutations;
    await expect(cancelRun(h.repo, id, start.runId)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(h.mutations - before).toBe(4);
    expect(h.snapshot().runs[0].status).toBe('generating');
  });

  it('acknowledges an already-ready preview without a write or a data revision change', async () => {
    const h = casRepository(), id = h.snapshot().id;
    const start = await beginGeneration(h.repo, id, { prompt: '改进应用', requestId: randomUUID(), baseVersionId: 'baseline-version' });
    await runGeneration(h.repo, id, start.runId, () => {});
    const input = { versionId: h.snapshot().runs[0].candidateVersionId!, ok: true, stagedState: h.snapshot().appState, expectedDataRevision: 2 };
    const ready = await reportPreview(h.repo, id, start.runId, input);
    const before = h.mutations;
    const duplicate = await reportPreview(h.repo, id, start.runId, { ...input, stagedState: {} });
    expect(duplicate).toEqual({ project: ready.project, repair: undefined });
    expect(h.mutations).toBe(before);
    expect(h.snapshot().dataRevision).toBe(3);
    expect(h.snapshot().appState).toEqual({ notes: ['保留内容'] });
  });

  it('derives repair dispatch only from the committed preview failure after CAS retries', async () => {
    const h = casRepository(), id = h.snapshot().id;
    const start = await beginGeneration(h.repo, id, { prompt: '改进应用', requestId: randomUUID(), baseVersionId: 'baseline-version' });
    await runGeneration(h.repo, id, start.runId, () => {});
    h.remainingConflicts = 2;
    h.matchesConflict = draft => draft.runs[0].status === 'repairing';
    const result = await reportPreview(h.repo, id, start.runId, { versionId: h.snapshot().runs[0].candidateVersionId!, ok: false, error: '按钮初始化失败', stagedState: {}, expectedDataRevision: 2 });
    expect(h.conflicts).toBe(2);
    expect(result.project.runs[0]).toMatchObject({ status: 'repairing', attempt: 1 });
    expect(result.repair).toEqual({ html: TODO_FIXTURE, errors: ['按钮初始化失败'] });
    expect(result.project.currentVersionId).toBe('baseline-version');
  });

  it('does not retry semantic 409 errors such as a stale data revision', async () => {
    const h = casRepository(), id = h.snapshot().id;
    const start = await beginGeneration(h.repo, id, { prompt: '改进应用', requestId: randomUUID(), baseVersionId: 'baseline-version' });
    await runGeneration(h.repo, id, start.runId, () => {});
    const before = h.mutations;
    await expect(reportPreview(h.repo, id, start.runId, { versionId: h.snapshot().runs[0].candidateVersionId!, ok: true, stagedState: {}, expectedDataRevision: 1 }))
      .rejects.toMatchObject({ code: 'STALE_DATA', status: 409 });
    expect(h.mutations - before).toBe(1);
    expect(h.snapshot().runs[0].status).toBe('previewing');
  });

  it('keeps duplicate restore requests read-only and does not create additional versions', async () => {
    const h = casRepository(), id = h.snapshot().id;
    const input = { versionId: 'baseline-version', requestId: randomUUID() };
    const restored = await restoreVersion(h.repo, id, input);
    const before = h.mutations;
    expect(await restoreVersion(h.repo, id, input)).toEqual(restored);
    expect(h.mutations).toBe(before);
    expect(h.snapshot().versions).toHaveLength(2);
    expect(h.snapshot().appState).toEqual({ notes: ['保留内容'] });
  });
});
