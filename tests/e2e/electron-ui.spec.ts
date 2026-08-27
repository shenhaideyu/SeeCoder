import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('Electron UI exposes interactive Codex-style workbench actions', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'seecoder-e2e-'));
  const workspace = await mkdtemp(join(tmpdir(), 'seecoder-e2e-workspace-'));
  await writeFile(join(workspace, '.env.example'), 'API_KEY=example\n', 'utf8');
  await writeFile(join(workspace, 'package.json'), '{"name":"e2e-fixture"}\n', 'utf8');
  let app = await electron.launch({ args: [resolve('out/main/main.js'), `--user-data-dir=${userData}`], cwd: workspace, timeout: 30_000 });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle('SeeCoder');
    await expect(page.locator('[data-action="new-task"]')).toBeVisible();
    await expect(page.locator('[data-action="permission-mode"]')).toBeVisible();
    await expect(page.locator('[data-action="inspector-changes"]')).toBeVisible();
    await page.locator('[data-action="new-task"]').click();
    await expect(page.locator('[data-action="composer"]')).toBeVisible();
    await expect(page.locator('.run-status')).toContainText('就绪');
    await expect(page.locator('[data-action="stage-all"]')).toBeDisabled();
    await page.locator('[data-action="permission-mode"]').click();
    await expect(page.locator('[data-action="mode-plan"]')).toBeVisible();
    await page.locator('[data-action="mode-plan"]').click();
    await expect(page.locator('[data-action="permission-mode"]')).toContainText('Plan');
    await expect(page.locator('.composer-note')).toContainText('不会修改工作区');
    await expect(page.locator('.workspace-context')).toBeVisible();

    await page.locator('[data-action="inspector-files"]').click();
    await expect(page.locator('[data-action="open-file"]').filter({ hasText: '.env.example' })).toHaveCount(1);
    await expect(page.locator('[data-action="open-file"]').filter({ hasText: /^\.env$/ })).toHaveCount(0);

    await page.locator('[data-action="inspector-terminal"]').click();
    const terminal = page.locator('[data-action="terminal-input"]');
    await terminal.fill('Get-ChildItem -Name');
    await terminal.press('Enter');
    await expect(page.locator('.terminal-output')).toContainText('Get-ChildItem -Name');
    await expect(page.locator('.terminal-output')).toContainText('package.json');
    await app.close();
    app = await electron.launch({ args: [resolve('out/main/main.js'), `--user-data-dir=${userData}`], cwd: workspace, timeout: 30_000 });
    const reopened = await app.firstWindow();
    await expect(reopened.locator('[data-action="permission-mode"]')).toContainText('Plan');
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
