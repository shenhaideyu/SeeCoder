import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  passWithNoTests: true,
  timeout: 15_000,
  reporter: [['list']],
});

