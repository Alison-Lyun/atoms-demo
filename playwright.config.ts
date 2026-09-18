import { defineConfig } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname);
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR || (process.env.RUN_LIVE_MODEL === 'true' ? 'test-results/live' : 'test-results/platform');

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  outputDir,
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: [['list'], ['json', { outputFile: `${outputDir}/results.json` }]],
  use: {
    baseURL,
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: local ? {
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { ENABLE_DEV_FIXTURES: 'true', STORAGE_MODE: 'local' },
  } : undefined,
});
