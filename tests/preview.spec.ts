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
});
