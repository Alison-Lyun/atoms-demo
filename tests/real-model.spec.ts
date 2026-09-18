import { expect, test, type Page } from '@playwright/test';
import type { Project } from '../src/lib/types';

// Explicit opt-in: this test makes two paid model generation requests. The server
// may perform its configured bounded repairs. No fixture or mocked output is used.
test.skip(process.env.RUN_LIVE_MODEL !== 'true', 'Set RUN_LIVE_MODEL=true after configuring and authorizing paid model calls.');
test.use({ baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000' });

async function readProject(page: Page, id: string): Promise<Project> {
  const response = await page.request.get(`/api/projects/${id}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).project;
}

async function waitForRun(page: Page, id: string, previousRunId?: string): Promise<Project> {
  await expect.poll(async () => {
    const latest = (await readProject(page, id)).runs.at(-1);
    if (!latest || latest.id === previousRunId) return 'waiting';
    return latest.status;
  }, { timeout: 210_000, intervals: [1000, 2000, 3000] }).toMatch(/^(ready|failed|cancelled)$/);
  const project = await readProject(page, id);
  const run = project.runs.at(-1);
  console.log(`[live] project=${id} run=${run?.id} source=${run?.source} status=${run?.status} attempt=${run?.attempt}${run?.error ? ` error=${run.error}` : ''}`);
  await test.info().attach(`run-${run?.id || 'unknown'}`, { contentType: 'application/json', body: JSON.stringify({
    projectId: id, currentVersionId: project.currentVersionId,
    run: run && { id: run.id, source: run.source, status: run.status, attempt: run.attempt, error: run.error, model: run.model, inputTokens: run.inputTokens, outputTokens: run.outputTokens },
    versions: project.versions.map(({ id, number, source, status, validationErrors }) => ({ id, number, source, status, validationErrors })),
  }, null, 2) });
  expect(project.runs.at(-1)?.status, project.runs.at(-1)?.error || 'The live generation did not publish.').toBe('ready');
  await expect(page.getByTestId('app-preview')).toHaveAttribute('data-preview-mode', 'published');
  await expect(page.getByTestId('app-preview')).toHaveAttribute('data-preview-status', 'ready');
  return project;
}

test('real model: first Todo generation, persisted data, same-project search change and version recovery', async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  await page.goto('/');
  const newProject = page.getByRole('button', { name: /新建应用/ });
  await expect(newProject).toBeEnabled({ timeout: 60_000 });
  const configResponse = await page.request.get('/api/config');
  const config = await configResponse.json();
  expect(config.modelConfigured, 'The live model must be configured; this test never substitutes a fixture.').toBe(true);
  const creation = page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects' && response.request().method() === 'POST');
  await newProject.click();
  const creationResponse = await creation;
  expect(creationResponse.ok()).toBeTruthy();
  const initial: Project = (await creationResponse.json()).project;
  console.log(`[live] starting first real generation: project=${initial.id} model=${config.model}`);
  await page.getByRole('textbox', { name: '描述你的应用' }).fill('创建一个简洁、美观、可用的待办清单。用原生自包含 HTML/CSS/JavaScript。必须有输入框 placeholder="添加待办事项"，提交按钮文字为“添加”；每项可以勾选完成和删除。任务数据用 await appStorage.get/set 的 todos 键保存，刷新后保留。妥善处理空输入。不需要任何外部资源、网络、账号或额外功能。先不要加搜索。');
  await page.getByRole('button', { name: '生成应用', exact: true }).click();
  const first = await waitForRun(page, initial.id);
  const firstVersion = first.currentVersionId;
  expect(first.versions.find(version => version.id === firstVersion)?.source).toBe('generate');
  const app = page.frameLocator('[data-testid="app-preview"]');
  await app.getByPlaceholder('添加待办事项', { exact: true }).fill('真实模型持久化验收');
  await app.getByRole('button', { name: '添加', exact: true }).click();
  await expect(app.getByText('真实模型持久化验收', { exact: true })).toBeVisible();
  await expect.poll(async () => JSON.stringify((await readProject(page, initial.id)).appState)).toContain('真实模型持久化验收');
  await page.reload();
  await expect(page.getByTestId('app-preview')).toHaveAttribute('data-preview-mode', 'published', { timeout: 60_000 });
  await expect(app.getByText('真实模型持久化验收', { exact: true })).toBeVisible();

  console.log('[live] first generation and reload persistence passed; requesting search change');
  await page.getByRole('textbox', { name: '描述你的应用' }).fill('在当前待办清单上增加实时任务搜索：新增一个 placeholder="搜索任务" 的搜索输入框，按任务文本过滤列表。保留现有添加、完成、删除功能、界面风格和 todos 数据结构，已有任务必须完整保留，不要清空或覆盖历史数据。');
  await page.getByRole('button', { name: '生成应用', exact: true }).click();
  const changed = await waitForRun(page, initial.id, first.runs.at(-1)?.id);
  expect(changed.currentVersionId).not.toBe(firstVersion);
  expect(changed.versions.find(version => version.id === changed.currentVersionId)?.source).toBe('generate');
  await expect(app.getByText('真实模型持久化验收', { exact: true })).toBeVisible();
  await app.getByPlaceholder('搜索任务', { exact: true }).fill('不存在的任务');
  await expect(app.getByText('真实模型持久化验收', { exact: true })).toHaveCount(0);
  await app.getByPlaceholder('搜索任务', { exact: true }).fill('真实模型');
  await expect(app.getByText('真实模型持久化验收', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('live-generated-todo-with-search.png'), fullPage: true });

  console.log('[live] incremental search and preserved data passed; restoring the first successful version');
  await page.getByRole('tab', { name: /版本/ }).click();
  const firstNumber = first.versions.find(version => version.id === firstVersion)?.number;
  const restoreCard = page.locator('.version-card').filter({ has: page.locator('.version-card-header strong').filter({ hasText: new RegExp(`^版本 ${firstNumber}$`) }) });
  await restoreCard.getByRole('button', { name: '恢复', exact: true }).click();
  const restored = await waitForRun(page, initial.id, changed.runs.at(-1)?.id);
  expect(restored.versions.find(version => version.id === restored.currentVersionId)?.source).toBe('restore');
  expect(restored.versions.find(version => version.id === restored.currentVersionId)?.html).toBe(first.versions.find(version => version.id === firstVersion)?.html);
  await expect(app.getByText('真实模型持久化验收', { exact: true })).toBeVisible();
  await expect(app.getByPlaceholder('搜索任务', { exact: true })).toHaveCount(0);
  expect(JSON.stringify(restored.appState)).toContain('真实模型持久化验收');
  await testInfo.attach('live-model-evidence', { contentType: 'application/json', body: JSON.stringify({
    projectId: initial.id, model: config.model,
    versions: restored.versions.map(({ id, number, source, status }) => ({ id, number, source, status })),
    runs: restored.runs.map(({ id, source, status, attempt, model, inputTokens, outputTokens }) => ({ id, source, status, attempt, model, inputTokens, outputTokens })),
    checks: ['first-generation', 'data-write', 'reload-persistence', 'incremental-search', 'data-preserved', 'version-restore'],
  }, null, 2) });
});
