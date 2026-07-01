import { defineConfig, devices } from '@playwright/test';

const localExecutablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
const launchOptions = localExecutablePath ? { executablePath: localExecutablePath } : undefined;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'iPhone 12',
      use: { ...devices['iPhone 12'], defaultBrowserType: 'chromium', launchOptions },
    },
    {
      name: 'iPhone SE',
      use: { ...devices['iPhone SE'], defaultBrowserType: 'chromium', launchOptions },
    },
  ],
  webServer: {
    command: 'npx serve dist -p 3001 --no-clipboard',
    port: 3001,
    timeout: 30_000,
    reuseExistingServer: !process.env.CI,
  },
});
