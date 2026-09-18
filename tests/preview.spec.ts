import { expect, test, type Page } from '@playwright/test';
import type { AppState, Project } from '../src/lib/types';

// These tests exercise a clearly labelled development fixture. They do not
// verify an AI provider, generated output quality, Supabase, or deployment.
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname);
test.skip(process.env.RUN_PLATFORM_TESTS !== 'true' || !local, 'Development fixture tests require RUN_PLATFORM_TESTS=true and a localhost server.');
test.use({ baseURL });

async function loadFixture(page: Page): Promise<Project> {
  const button = page.getByRole('button', { name: /载入开发样例/ });
  await expect(button, 'Start the local server with ENABLE_DEV_FIXTURES=true.').toBeEnabled({ timeout: 60_000 });
  const creation = page.waitForResponse(result => new URL(result.url()).pathname === '/api/projects' && result.request().method() === 'POST');
  await page.getByRole('button', { name: /新建应用/ }).click();
  const created = await creation;
  expect(created.ok(), `Create project failed: ${await created.text()}`).toBeTruthy();
  await expect(button).toBeEnabled();
  const response = page.waitForResponse(result => new URL(result.url()).pathname.endsWith('/fixture') && result.request().method() === 'POST');
  await button.click();
  const result = await response;
  expect(result.ok()).toBeTruthy();
  return (await result.json()).project;
}

async function getProject(page: Page, id: string): Promise<Project> {
  const response = await page.request.get(`/api/projects/${id}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).project;
}

async function waitForPublished(page: Page) {
  const iframe = page.getByTestId('app-preview');
  await expect(iframe).toHaveAttribute('data-preview-mode', 'published', { timeout: 60_000 });
  await expect(iframe).toHaveAttribute('data-preview-status', 'ready');
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  return page.frameLocator('[data-testid="app-preview"]');
}

test.describe('opaque sandbox and transactional fixture lifecycle', () => {
  test('publishes a fixture and preserves user data across reload, with project isolation', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/');
    const candidate = await loadFixture(page);
    const app = await waitForPublished(page);
    const before = await getProject(page, candidate.id);
    expect(before.currentVersionId).toBe(candidate.versions.at(-1)?.id);
    expect(before.versions.at(-1)?.source).toBe('fixture');
    expect(before.runs.at(-1)?.status).toBe('ready');

    await app.getByPlaceholder('添加待办事项').fill('真实浏览器持久化验收');
    await app.getByRole('button', { name: '添加', exact: true }).click();
    await expect(app.getByText('真实浏览器持久化验收', { exact: true })).toBeVisible();
    await expect.poll(async () => JSON.stringify((await getProject(page, candidate.id)).appState)).toContain('真实浏览器持久化验收');
    await page.reload();
    const restored = await waitForPublished(page);
    await expect(restored.getByText('真实浏览器持久化验收', { exact: true })).toBeVisible();

    const other = await loadFixture(page);
    expect(other.id).not.toBe(candidate.id);
    const isolated = await waitForPublished(page);
    await expect(isolated.getByText('真实浏览器持久化验收', { exact: true })).toHaveCount(0);
    expect(JSON.stringify((await getProject(page, other.id)).appState)).not.toContain('真实浏览器持久化验收');
    expect(JSON.stringify((await getProject(page, candidate.id)).appState)).toContain('真实浏览器持久化验收');
  });

  test('candidate writes stay staged until the real validation request is committed', async ({ page }) => {
    await page.addInitScript(() => {
      if (window === window.top) return;
      window.addEventListener('load', () => {
        const storage = (window as unknown as { appStorage: { ready(): Promise<void>; set(key: string, value: string): Promise<void> } }).appStorage;
        if (storage) void storage.ready().then(() => storage.set('candidate_probe', 'staged-in-browser'));
      });
    });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let submitted: { ok: boolean; stagedState: AppState } | undefined;
    await page.route('**/runs/*/validate', async route => {
      submitted = route.request().postDataJSON();
      await held;
      await route.continue();
    });
    await page.goto('/');
    const candidate = await loadFixture(page);
    try {
      await expect.poll(() => submitted?.stagedState.candidate_probe).toBe('staged-in-browser');
      expect(submitted?.ok).toBe(true);
      const unchanged = await getProject(page, candidate.id);
      expect(unchanged.currentVersionId).toBeNull();
      expect(unchanged.appState.candidate_probe).toBeUndefined();
      expect(unchanged.runs.at(-1)?.status).toBe('previewing');
    } finally { release(); }
    await waitForPublished(page);
    await expect.poll(async () => (await getProject(page, candidate.id)).appState.candidate_probe).toBe('staged-in-browser');
  });

  test('an actual candidate runtime rejection fails without leaking its staged write', async ({ page }) => {
    await page.addInitScript(() => {
      if (window === window.top) return;
      window.addEventListener('load', () => {
        const storage = (window as unknown as { appStorage: { ready(): Promise<void>; set(key: string, value: string): Promise<void> } }).appStorage;
        if (storage) void storage.ready().then(() => storage.set('failed_candidate_probe', 'must-not-persist')).then(() => {
          throw new Error('Intentional browser fixture startup rejection');
        });
      });
    });
    await page.goto('/');
    const candidate = await loadFixture(page);
    await expect.poll(async () => (await getProject(page, candidate.id)).runs.at(-1)?.status).toBe('failed');
    const failed = await getProject(page, candidate.id);
    expect(failed.currentVersionId).toBeNull();
    expect(failed.appState.failed_candidate_probe).toBeUndefined();
    expect(failed.versions.at(-1)?.status).toBe('failed');
    expect(failed.runs.at(-1)?.error).toContain('Intentional browser fixture startup rejection');
  });

  test('serializes saves and recovers a stale second page without replaying its old data', async ({ page, context }) => {
    test.setTimeout(180_000);
    await page.goto('/');
    const candidate = await loadFixture(page);
    const first = await waitForPublished(page);
    const initial = await getProject(page, candidate.id);
    const writes: number[] = [];
    page.on('response', response => {
      if (new URL(response.url()).pathname === `/api/projects/${candidate.id}/state` && response.request().method() === 'POST') writes.push(response.status());
    });
    await page.getByTestId('app-preview').contentFrame().locator('body').evaluate(async () => {
      const storage = (window as unknown as { appStorage: { set(key: string, value: number): Promise<void> } }).appStorage;
      await Promise.all(Array.from({ length: 6 }, (_, value) => storage.set('queue_probe', value)));
    });
    expect(writes).toEqual([200, 200, 200, 200, 200, 200]);
    const saved = await getProject(page, candidate.id);
    expect(saved.appState.queue_probe).toBe(5);
    expect(saved.dataRevision).toBe(initial.dataRevision + 6);

    const stale = await context.newPage();
    try {
      await stale.goto('/');
      const second = await waitForPublished(stale);
      await first.getByPlaceholder('添加待办事项').fill('第一页面已保存');
      await first.getByRole('button', { name: '添加', exact: true }).click();
      await expect(first.getByText('第一页面已保存', { exact: true })).toBeVisible();
      const stateURL = `/api/projects/${candidate.id}/state`;
      let staleWriteCount = 0;
      stale.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === stateURL) staleWriteCount++; });
      const conflict = stale.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === stateURL);
      await second.getByPlaceholder('添加待办事项').fill('第二页面需要重新提交');
      await second.getByRole('button', { name: '添加', exact: true }).click();
      expect((await conflict).status()).toBe(409);
      const banner = stale.locator('.output-panel').getByRole('alert');
      await expect(banner).toContainText('数据已在其他页面更新');
      const cloudBeforeRecovery = (await getProject(stale, candidate.id)).appState;
      expect(JSON.stringify(cloudBeforeRecovery)).toContain('第一页面已保存');
      expect(JSON.stringify(cloudBeforeRecovery)).not.toContain('第二页面需要重新提交');

      // A stale iframe cannot continue saving while recovery is pending.
      const blocked = await stale.getByTestId('app-preview').contentFrame().locator('body').evaluate(async () => {
        const storage = (window as unknown as { appStorage: { set(key: string, value: string): Promise<void> } }).appStorage;
        try { await storage.set('blocked_probe', 'must-not-persist'); return false; } catch { return true; }
      });
      expect(blocked).toBe(true);
      expect(staleWriteCount).toBe(1);
      expect((await getProject(stale, candidate.id)).appState.blocked_probe).toBeUndefined();

      await stale.setViewportSize({ width: 390, height: 844 });
      await stale.locator('.mobile-nav').getByRole('button', { name: '预览', exact: true }).click();
      await expect(banner).toBeVisible();
      await stale.getByRole('button', { name: '展开预览', exact: true }).click();
      await expect(banner).toBeVisible();

      // A failed refresh must keep the recovery action and the saved cloud data.
      let reloads = 0;
      await stale.route(`**/api/projects/${candidate.id}`, async route => {
        if (route.request().method() === 'GET' && ++reloads === 1) {
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '测试读取暂时不可用' }) });
        } else await route.continue();
      });
      const recover = stale.getByRole('button', { name: '载入最新数据', exact: true });
      await recover.click();
      await expect(recover).toBeEnabled();
      await expect(banner).toBeVisible();
      await recover.click();
      await expect(banner).toHaveCount(0);
      const refreshed = await waitForPublished(stale);
      await expect(refreshed.getByText('第一页面已保存', { exact: true })).toBeVisible();
      await expect(refreshed.getByText('第二页面需要重新提交', { exact: true })).toHaveCount(0);
      expect(staleWriteCount).toBe(1);
      await refreshed.getByPlaceholder('添加待办事项').fill('第二页面需要重新提交');
      await refreshed.getByRole('button', { name: '添加', exact: true }).click();
      await expect(refreshed.getByText('第二页面需要重新提交', { exact: true })).toBeVisible();
      const recovered = await getProject(stale, candidate.id);
      expect(JSON.stringify(recovered.appState)).toContain('第一页面已保存');
      expect(JSON.stringify(recovered.appState)).toContain('第二页面需要重新提交');
      expect(recovered.appState.queue_probe).toBe(5);

      const reload = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/projects/${candidate.id}`);
      await page.getByRole('button', { name: '重新加载预览', exact: true }).click();
      expect((await reload).ok()).toBe(true);
      const current = await waitForPublished(page);
      await expect(current.getByText('第二页面需要重新提交', { exact: true })).toBeVisible();
      await current.getByPlaceholder('添加待办事项').fill('刷新后继续保存');
      await current.getByRole('button', { name: '添加', exact: true }).click();
      await expect(current.getByText('刷新后继续保存', { exact: true })).toBeVisible();
      expect(JSON.stringify((await getProject(page, candidate.id)).appState)).toContain('第二页面需要重新提交');
    } finally { await stale.close(); }
  });
});
