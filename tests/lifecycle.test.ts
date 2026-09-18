import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Run, Version } from '../src/lib/types';
import { activeRun } from '../src/lib/types';
import { assertState, expireRuns, failActiveRun, makeVersion, newRun, promoteCandidate, requireActive } from '../src/lib/server/lifecycle';
import { createLocalRepository } from '../src/lib/server/repository';

const now = new Date('2026-09-18T12:00:00.000Z');
const directories: string[] = [];
function fixtureProject(): Project {
  const version: Version = {
    id: 'ready-v1', number: 1, parentVersionId: null, html: '<p>Working version</p>',
    title: '原项目', summary: 'Working baseline', createdAt: now.toISOString(),
    status: 'ready', source: 'generate', validationErrors: [],
  };
  return {
    id: randomUUID(), title: version.title, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    revision: 3, dataRevision: 4, currentVersionId: version.id,
    messages: [], versions: [version], runs: [], appState: { notes: [{ text: '不可丢失', done: false }] },
  };
}
function candidate(project: Project): { run: Run; version: Version } {
  const run = newRun(project, '添加搜索', randomUUID(), 'generate', project.currentVersionId);
  const version = makeVersion(project, run, { html: '<p>New version with search</p>', title: '有搜索的笔记', summary: '已增加搜索，保留笔记' });
  project.versions.push(version);
  run.status = 'previewing';
  run.candidateVersionId = version.id;
  return { run, version };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('candidate lifecycle', () => {
  it('stages a new version without changing the published code or application data', () => {
    const project = fixtureProject();
    const originalState = structuredClone(project.appState);
    const { run, version } = candidate(project);
    expect(project.currentVersionId).toBe('ready-v1');
    expect(project.appState).toEqual(originalState);
    expect(project.dataRevision).toBe(4);
    expect(version).toMatchObject({ number: 2, parentVersionId: 'ready-v1', status: 'candidate' });
    expect(run).toMatchObject({ baseVersionId: 'ready-v1', baseDataRevision: 4, attempt: 0 });
    run.stagedState.notes = [];
    expect(project.appState).toEqual(originalState);
  });

  it('promotes code, data, run status and assistant message together', () => {
    const project = fixtureProject();
    const { run, version } = candidate(project);
    const proposed = { notes: [{ text: '不可丢失', done: false }], search: '' };
    promoteCandidate(project, { runId: run.id, versionId: version.id, state: proposed, expectedDataRevision: 4 });
    expect(project).toMatchObject({ currentVersionId: version.id, title: version.title, appState: proposed, dataRevision: 5 });
    expect(version.status).toBe('ready');
    expect(run).toMatchObject({ status: 'ready', finishedAt: now.toISOString(), stagedState: {} });
    expect(project.messages.at(-1)).toMatchObject({ role: 'assistant', content: version.summary, runId: run.id });
    expect(project.versions[0]).toMatchObject({ id: 'ready-v1', status: 'ready', html: '<p>Working version</p>' });
    proposed.notes[0].text = 'caller mutated input';
    expect(project.appState.notes).toEqual([{ text: '不可丢失', done: false }]);
  });

  it('records candidate failure while preserving published code and data', () => {
    const project = fixtureProject();
    const originalState = structuredClone(project.appState);
    const { run, version } = candidate(project);
    failActiveRun(project, run.id, '预览运行报错');
    expect(project.currentVersionId).toBe('ready-v1');
    expect(project.versions[0].html).toBe('<p>Working version</p>');
    expect(project.appState).toEqual(originalState);
    expect(project.dataRevision).toBe(4);
    expect(version).toMatchObject({ status: 'failed', validationErrors: ['预览运行报错'] });
    expect(run).toMatchObject({ status: 'failed', error: '预览运行报错', finishedAt: now.toISOString(), stagedState: {} });
    expect(activeRun(project)).toBeUndefined();
  });

  it('rejects a late result after the published version changed', () => {
    const project = fixtureProject();
    const { run, version } = candidate(project);
    project.currentVersionId = 'newer-published-version';
    const before = structuredClone(project);
    expect(() => promoteCandidate(project, { runId: run.id, versionId: version.id, state: {}, expectedDataRevision: 4 }))
      .toThrow(expect.objectContaining({ status: 409, code: 'STALE_VERSION' }));
    expect(project).toEqual(before);
  });

  it('rejects an older candidate preview after a repair replaced it', () => {
    const project = fixtureProject();
    const { run, version } = candidate(project);
    run.candidateVersionId = 'repaired-candidate';
    const before = structuredClone(project);
    expect(() => promoteCandidate(project, { runId: run.id, versionId: version.id, state: {}, expectedDataRevision: 4 }))
      .toThrow(expect.objectContaining({ status: 409, code: 'STALE_CANDIDATE' }));
    expect(project).toEqual(before);
  });

  it.each(['published data changed', 'preview submitted stale revision'])('rejects promotion when %s', reason => {
    const project = fixtureProject();
    const { run, version } = candidate(project);
    if (reason === 'published data changed') { project.dataRevision = 5; project.appState.notes = [{ text: '生成期间新增', done: false }]; }
    const before = structuredClone(project);
    const expectedDataRevision = reason === 'preview submitted stale revision' ? 3 : 4;
    expect(() => promoteCandidate(project, { runId: run.id, versionId: version.id, state: { notes: [] }, expectedDataRevision }))
      .toThrow(expect.objectContaining({ status: 409, code: 'STALE_DATA' }));
    expect(project).toEqual(before);
  });

  it.each(['cancelled', 'failed', 'ready'] as const)('rejects delayed promotion for a %s run', status => {
    const project = fixtureProject();
    const { run, version } = candidate(project);
    run.status = status;
    const before = structuredClone(project);
    expect(() => promoteCandidate(project, { runId: run.id, versionId: version.id, state: {}, expectedDataRevision: 4 }))
      .toThrow(expect.objectContaining({ status: 409, code: 'RUN_INACTIVE' }));
    expect(project).toEqual(before);
  });

  it('expires abandoned preview runs and keeps the published state', () => {
    const project = fixtureProject();
    const originalState = structuredClone(project.appState);
    const { run, version } = candidate(project);
    vi.setSystemTime(new Date(run.deadlineAt));
    expect(() => requireActive(project, run.id)).toThrow(expect.objectContaining({ code: 'RUN_INACTIVE' }));
    expireRuns(project);
    expect(run).toMatchObject({ status: 'failed', finishedAt: run.deadlineAt });
    expect(run.error).toContain('超时');
    expect(version.status).toBe('failed');
    expect(project.currentVersionId).toBe('ready-v1');
    expect(project.appState).toEqual(originalState);
    expect(activeRun(project)).toBeUndefined();
    const next = newRun(project, '重新尝试', randomUUID(), 'generate', 'ready-v1');
    expect(next.status).toBe('generating');
  });

  it('rejects duplicate active generation and ignores failures for finished runs', () => {
    const project = fixtureProject();
    const { run, version } = candidate(project);
    expect(() => newRun(project, '重复请求', randomUUID(), 'generate', 'ready-v1')).toThrow(expect.objectContaining({ status: 409, code: 'PROJECT_BUSY' }));
    promoteCandidate(project, { runId: run.id, versionId: version.id, state: project.appState, expectedDataRevision: 4 });
    const before = structuredClone(project);
    failActiveRun(project, run.id, 'late network error');
    expect(project).toEqual(before);
  });

  it('rejects invalid application data before touching the published version', () => {
    const project = fixtureProject();
    const { run, version } = candidate(project);
    const before = structuredClone(project);
    expect(() => promoteCandidate(project, { runId: run.id, versionId: version.id, state: { total: Number.POSITIVE_INFINITY }, expectedDataRevision: 4 })).toThrow();
    expect(project).toEqual(before);
    expect(() => assertState(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow();
  });

  it('persists promotion atomically and leaves it intact when a later stale callback fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'atoms-lifecycle-'));
    directories.push(dir);
    const repository = createLocalRepository('integration-session-owner-0001', dir);
    const created = await repository.createProject('真实存储集成测试');
    const staged = await repository.mutateProject(created.id, draft => {
      const baseline = fixtureProject();
      draft.appState = baseline.appState;
      draft.dataRevision = 4;
      draft.versions = baseline.versions;
      draft.currentVersionId = 'ready-v1';
      candidate(draft);
    });
    const run = staged.runs[0];
    const promoted = await repository.mutateProject(created.id, draft => {
      promoteCandidate(draft, { runId: run.id, versionId: run.candidateVersionId!, state: { notes: ['persisted'], search: '' }, expectedDataRevision: 4 });
    });
    const reopened = createLocalRepository('integration-session-owner-0001', dir);
    expect(await reopened.getProject(created.id)).toEqual(promoted);
    expect(promoted).toMatchObject({ revision: 2, dataRevision: 5, currentVersionId: run.candidateVersionId, appState: { notes: ['persisted'], search: '' } });
    await expect(reopened.mutateProject(created.id, draft => {
      promoteCandidate(draft, { runId: run.id, versionId: run.candidateVersionId!, state: { notes: [] }, expectedDataRevision: 4 });
    })).rejects.toMatchObject({ code: 'RUN_INACTIVE' });
    expect(await reopened.getProject(created.id)).toEqual(promoted);
  });
});
