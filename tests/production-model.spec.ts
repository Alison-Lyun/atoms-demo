import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { Project } from '../src/lib/types';

// Four opt-in real generations: calculator + two edits + timer.
// One test/context deliberately stops all subsequent paid calls on any failure.
test.skip(process.env.RUN_LIVE_MODEL !== 'true' || process.env.RUN_PRODUCTION_ACCEPTANCE !== 'true', 'Requires explicit live production acceptance opt-in.');

type Evidence = { baseURL: string; model?: string; checks: string[]; projects: Array<{ id: string; kind: string }>; runs: unknown[]; error?: string };

async function readProject(page: Page, id: string): Promise<Project> {
  const response = await page.request.get(`/api/projects/${id}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).project;
}

async function createProject(page: Page): Promise<Project> {
  const creation = page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects' && response.request().method() === 'POST');
  await page.getByRole('button', { name: /新建应用/ }).click();
  const response = await creation;
  expect(response.ok(), `Project creation HTTP ${response.status()}`).toBeTruthy();
  return (await response.json()).project;
}

async function previewReady(page: Page) {
  await expect(page.getByTestId('app-preview')).toHaveAttribute('data-preview-mode', 'published', { timeout: 60_000 });
  await expect(page.getByTestId('app-preview')).toHaveAttribute('data-preview-status', 'ready');
}

async function generate(page: Page, project: Project, prompt: string, label: string, evidence: Evidence): Promise<Project> {
  console.log(`[production] ${label}: submitting real generation for ${project.id}`);
  const previous = project.runs.at(-1)?.id;
  await page.getByRole('textbox', { name: '描述你的应用' }).fill(prompt);
  await page.getByRole('button', { name: '生成应用', exact: true }).click();
  await expect.poll(async () => {
    const run = (await readProject(page, project.id)).runs.at(-1);
    return run && run.id !== previous ? run.status : 'waiting';
  }, { timeout: 210_000, intervals: [1000, 2000, 3000] }).toMatch(/^(ready|failed|cancelled)$/);
  const result = await readProject(page, project.id);
  const run = result.runs.at(-1);
  evidence.runs.push(run && { projectId: result.id, label, id: run.id, source: run.source, status: run.status, attempt: run.attempt, error: run.error, model: run.model, inputTokens: run.inputTokens, outputTokens: run.outputTokens });
  console.log(`[production] ${label}: status=${run?.status}, attempt=${run?.attempt}${run?.error ? `, error=${run.error}` : ''}`);
  expect(run?.status, run?.error || `${label} did not publish`).toBe('ready');
  expect(run?.source).toBe('generate');
  await previewReady(page);
  return result;
}

async function savePrivateSession(page: Page, testInfo: TestInfo) {
  const path = process.env.PLAYWRIGHT_STORAGE_STATE_PATH || testInfo.outputPath('private-anonymous-session.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(await page.context().storageState()), { mode: 0o600 });
  // Never log, attach, commit, or publish this bearer session.
}

test('production model: calculator, two continuous edits, and persistent 10-second timer', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(900_000);
  const evidence: Evidence = { baseURL: baseURL || '', checks: [], projects: [], runs: [] };
  const app = page.frameLocator('[data-testid="app-preview"]');
  try {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /新建应用/ })).toBeEnabled({ timeout: 60_000 });
    const config = await (await page.request.get('/api/config')).json();
    expect(config.modelConfigured).toBe(true);
    expect(config.fixturesEnabled, 'Production must not expose development fixture routes.').toBe(false);
    evidence.model = config.model;

    let calculator = await createProject(page);
    evidence.projects.push({ id: calculator.id, kind: 'calculator' });
    await savePrivateSession(page, testInfo);
    calculator = await generate(page, calculator,
      '创建一个简洁美观的四则运算计算器，用原生自包含 HTML/CSS/JavaScript。两个数字输入框的 placeholder 必须分别为“数字A”和“数字B”；一个 aria-label="运算符" 的 select，option value 分别为 +、-、*、/；按钮文字“计算”。结果显示在 id="result" 的元素中，内容只有数值；错误显示在 id="error" 页面内区域。有效计算历史写入 appStorage 的 calc_history 键（JSON数组），历史列表容器 id="history"。先读取旧历史并保留，刷新后历史仍在。正确处理空输入、无效数字和除以零，非法运算必须显示中文错误、不能显示Infinity/NaN、不能新增或更改历史。计算有效时先await保存成功再显示已保存状态。不调用alert/confirm/prompt，不使用eval、Function或任何外部资源。第一版不需要历史清空和再次使用。',
      'calculator initial', evidence);
    const a = app.getByPlaceholder('数字A', { exact: true });
    const b = app.getByPlaceholder('数字B', { exact: true });
    const operator = app.getByRole('combobox', { name: '运算符', exact: true });
    const calculate = async (left: string, op: string, right: string) => {
      await a.fill(left); await b.fill(right); await operator.selectOption(op);
      await app.getByRole('button', { name: '计算', exact: true }).click();
    };
    await calculate('2', '+', '3');
    await expect(app.locator('#result')).toHaveText('5');
    await expect.poll(async () => (await readProject(page, calculator.id)).appState.calc_history).toHaveLength(1);
    const initialHistory = (await readProject(page, calculator.id)).appState.calc_history;
    const stateRequests: string[] = [];
    const captureWrites = (request: import('@playwright/test').Request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/projects/${calculator.id}/state`) {
        const body = request.postDataJSON();
        if (body?.key === 'calc_history') stateRequests.push(request.url());
      }
    };
    page.on('request', captureWrites);
    await calculate('1', '/', '0');
    await expect(app.locator('#error')).toBeVisible();
    await expect(app.locator('#error')).toContainText(/零|无效|不能|zero|invalid/i);
    await expect(app.locator('#result')).not.toContainText(/Infinity|NaN/);
    await page.waitForTimeout(1000);
    await calculate('', '+', '2');
    await expect(app.locator('#error')).toBeVisible();
    await expect(app.locator('#error')).toContainText(/[\u4e00-\u9fff]/);
    await page.waitForTimeout(500);
    page.off('request', captureWrites);
    expect(stateRequests).toHaveLength(0);
    expect((await readProject(page, calculator.id)).appState.calc_history).toEqual(initialHistory);
    await page.reload(); await previewReady(page);
    await expect(app.locator('#history')).toContainText('5');
    expect((await readProject(page, calculator.id)).appState.calc_history).toEqual(initialHistory);
    evidence.checks.push('calculator-2-plus-3-equals-5', 'division-by-zero-shows-error-without-history-write', 'calculator-history-survives-reload', 'empty-input-inline-error-without-history-write');
    await page.screenshot({ path: testInfo.outputPath('production-calculator-initial.png'), fullPage: true });

    calculator = await generate(page, await readProject(page, calculator.id),
      '对当前计算器做第1次增量修改：新增文字为“清空历史”的按钮，点击后通过await appStorage.set清空calc_history并更新历史列表。只在用户点击时清空，加载/初始化/修改版本时绝不能清空旧历史。保留当前计算、除零等非法输入保护、现有数据结构、全部输入placeholder/aria-label和result/error/history元素id。不要使用alert/confirm/prompt；本次不要增加再次使用功能。',
      'calculator edit 1: clear history', evidence);
    expect((await readProject(page, calculator.id)).appState.calc_history).toEqual(initialHistory);
    await expect(app.locator('#history')).toContainText('5');
    await app.getByRole('button', { name: '清空历史', exact: true }).click();
    await expect.poll(async () => (await readProject(page, calculator.id)).appState.calc_history).toEqual([]);
    await calculate('7', '*', '6');
    await expect(app.locator('#result')).toHaveText('42');
    await expect.poll(async () => (await readProject(page, calculator.id)).appState.calc_history).toHaveLength(1);
    const historyForEdit2 = (await readProject(page, calculator.id)).appState.calc_history;
    evidence.checks.push('first-edit-preserves-history-before-user-clears', 'clear-history-persists', 'calculator-still-computes-after-first-edit');

    calculator = await generate(page, await readProject(page, calculator.id),
      '对同一个计算器做第2次连续增量修改：给每条历史增加文字为“再次使用”的按钮，点击把该记录的数值结果填入“数字A”输入框；不要删除或覆盖任何历史记录。并支持在数字A/数字B输入框按Enter执行计算。保留当前清空历史、四则运算、非法输入/除零保护、数据结构及所有输入placeholder/aria-label和result/error/history元素id。使用页面内提示，不调用alert/confirm/prompt。现有calc_history记录必须完整保留。',
      'calculator edit 2: reuse result and Enter', evidence);
    expect((await readProject(page, calculator.id)).appState.calc_history).toEqual(historyForEdit2);
    await a.fill('999');
    await app.locator('button').filter({ hasText: /^再次使用$/ }).last().click();
    await expect(a).toHaveValue('42');
    await b.fill('1'); await operator.selectOption('+'); await b.press('Enter');
    await expect(app.locator('#result')).toHaveText('43');
    await expect.poll(async () => (await readProject(page, calculator.id)).appState.calc_history).toHaveLength(2);
    evidence.checks.push('second-continuous-edit-preserves-history', 'reuse-history-result', 'keyboard-Enter-calculation');
    await page.screenshot({ path: testInfo.outputPath('production-calculator-two-edits.png'), fullPage: true });
    await savePrivateSession(page, testInfo);

    calculator = await readProject(page, calculator.id);
    const retainedHistory = calculator.appState.calc_history;
    const published = calculator.versions.find(version => version.id === calculator.currentVersionId)!;
    await page.getByRole('tab', { name: '源码', exact: true }).click();
    const displayed = await page.locator('.source-code .code-line > span:last-child').allTextContents();
    const normalizeBlank = (line: string) => line.trim() === '' ? '' : line;
    expect(displayed.map(normalizeBlank)).toEqual(published.html.split('\n').map(normalizeBlank));
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载当前版本源码', exact: true }).click();
    const download = await downloadEvent;
    const exported = testInfo.outputPath('production-calculator-v3-export.html');
    await download.saveAs(exported);
    expect(await readFile(exported, 'utf8')).toBe(published.html);
    evidence.checks.push('visible-source-matches-current-version', 'HTML-export-byte-matches-current-version');

    await page.getByRole('tab', { name: /版本/ }).click();
    const first = calculator.versions.find(version => version.source === 'generate' && version.status === 'ready')!;
    const card = page.locator('.version-card').filter({ has: page.locator('.version-card-header strong').filter({ hasText: new RegExp(`^版本 ${first.number}$`) }) });
    const beforeRestore = calculator.runs.at(-1)?.id;
    await card.getByRole('button', { name: '恢复', exact: true }).click();
    await expect.poll(async () => {
      const run = (await readProject(page, calculator.id)).runs.at(-1);
      return run && run.id !== beforeRestore ? run.status : 'waiting';
    }, { timeout: 60_000 }).toMatch(/^(ready|failed|cancelled)$/);
    calculator = await readProject(page, calculator.id);
    const restoration = calculator.runs.at(-1)!;
    expect(restoration.status, restoration.error || undefined).toBe('ready');
    expect(restoration.source).toBe('restore');
    await previewReady(page);
    expect(calculator.versions.find(version => version.id === calculator.currentVersionId)?.html).toBe(first.html);
    expect(calculator.appState.calc_history).toEqual(retainedHistory);
    await expect(app.locator('#history')).toContainText('43');
    await expect(app.locator('button').filter({ hasText: /^再次使用$/ })).toHaveCount(0);
    evidence.runs.push({ projectId: calculator.id, label: 'calculator version restoration', id: restoration.id, source: restoration.source, status: restoration.status, attempt: restoration.attempt });
    evidence.checks.push('production-restore-restores-original-code', 'production-restore-retains-current-history');
    await page.screenshot({ path: testInfo.outputPath('production-calculator-restored.png'), fullPage: true });

    let timer = await createProject(page);
    evidence.projects.push({ id: timer.id, kind: 'timer' });
    timer = await generate(page, timer,
      '创建一个美观、简单、真实可用的10秒倒计时工具，原生自包含HTML/CSS/JavaScript。倒计时元素id="countdown"，内容仅显示整数秒（初始10），三个按钮文字固定为“开始”“暂停”“重置”。开始后真实按秒减少，暂停后时间保持，重置回10且停止。倒计时自然到0时完成次数仅增加1。完成次数元素id="completed"，内容仅显示整数；通过await appStorage.get/set的timer_completed键保存这个数字，加载先读取旧次数而不能清零，刷新后保留完成次数。空白项目初始次数0。不需要声音、通知、外部资源或浏览器模态框，不调用alert/confirm/prompt。',
      'timer initial', evidence);
    await expect(app.locator('#countdown')).toHaveText('10');
    const initialCount = Number(await app.locator('#completed').innerText());
    expect(Number.isFinite(initialCount)).toBe(true);
    await app.getByRole('button', { name: '开始', exact: true }).click();
    await expect.poll(async () => Number(await app.locator('#countdown').innerText()), { timeout: 7000 }).toBeLessThan(10);
    await app.getByRole('button', { name: '暂停', exact: true }).click();
    const paused = await app.locator('#countdown').innerText();
    await page.waitForTimeout(1200);
    await expect(app.locator('#countdown')).toHaveText(paused);
    await app.getByRole('button', { name: '重置', exact: true }).click();
    await expect(app.locator('#countdown')).toHaveText('10');
    await app.getByRole('button', { name: '开始', exact: true }).click();
    await expect(app.locator('#completed')).toHaveText(String(initialCount + 1), { timeout: 25_000 });
    await expect.poll(async () => (await readProject(page, timer.id)).appState.timer_completed).toBe(initialCount + 1);
    await page.reload(); await previewReady(page);
    await expect(app.locator('#completed')).toHaveText(String(initialCount + 1));
    expect((await readProject(page, timer.id)).appState.timer_completed).toBe(initialCount + 1);
    evidence.checks.push('timer-starts-and-counts-down', 'timer-pauses', 'timer-resets-to-10', 'timer-completes-once', 'timer-completion-count-survives-reload');
    await page.screenshot({ path: testInfo.outputPath('production-timer.png'), fullPage: true });
    console.log('[production] all calculator / two-edit / timer functional checks passed');
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await savePrivateSession(page, testInfo).catch(() => {});
    const evidencePath = testInfo.outputPath('acceptance-evidence.json');
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    await testInfo.attach('production-functional-evidence', { path: evidencePath, contentType: 'application/json' });
  }
});
