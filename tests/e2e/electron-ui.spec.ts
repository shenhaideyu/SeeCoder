import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('Electron UI exposes interactive Codex-style workbench actions', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'seecoder-e2e-'));
  const app = await electron.launch({ args: [resolve('out/main/main.js'), `--user-data-dir=${userData}`], timeout: 30_000 });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle('SeeCoder');
    await expect(page.locator('[data-action="new-task"]')).toBeVisible();
    await expect(page.locator('[data-action="permission-mode"]')).toBeVisible();
    await expect(page.locator('[data-action="inspector-changes"]')).toBeVisible();
    await page.locator('[data-action="new-task"]').click();
    await expect(page.locator('[data-action="composer"]')).toBeVisible();
    await page.locator('[data-action="permission-mode"]').click();
    await expect(page.locator('[data-action="permission-mode"]')).toContainText(/Plan|Guided|Auto/);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
