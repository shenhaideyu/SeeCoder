import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('Electron UI exposes interactive Codex-style workbench actions', async () => {
  test.setTimeout(30_000);
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
    await expect(page.locator('[data-action="inspector-changes"]')).toHaveText('变更');
    await expect(page.locator('[data-action="inspector-terminal"]')).toHaveText('终端');
    await expect(page.locator('[aria-label="工作区 Git 变更"]')).toBeVisible();
    await expect(page.locator('[aria-label="当前任务改动"]')).toContainText('本任务没有修改文件');
    expect(await page.locator('.inspector-tabs').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.locator('[data-action="new-task"]').click();
    const tasksAfterClick = await page.locator('[data-action="open-thread"]').count();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('seecoder:menu', 'new-thread'));
    await expect(page.locator('[data-action="open-thread"]')).toHaveCount(tasksAfterClick + 1);
    await expect(page.locator('[data-action="composer"]')).toBeVisible();
    await expect(page.locator('.run-status')).toContainText('就绪');
    await expect(page.locator('[data-action="stage-all"]')).toBeDisabled();
    await page.locator('[data-action="permission-mode"]').click();
    await expect(page.locator('[data-action="mode-plan"]')).toBeVisible();
    await page.locator('[data-action="mode-plan"]').click();
    await expect(page.locator('[data-action="permission-mode"]')).toContainText('Plan');
    await expect(page.locator('.composer-note')).toContainText('不会修改工作区');
    await expect(page.locator('.workspace-context')).toBeVisible();

    const activeThread = (await page.evaluate(() => window.seecoder.thread.list()))[0]!;
    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('seecoder:event', payload), {
      type: 'changes.created',
      threadId: activeThread.id,
      timestamp: new Date().toISOString(),
      changeSet: {
        id: 'e2e-diff-lifecycle', threadId: activeThread.id, turnId: 'e2e-turn', createdAt: new Date().toISOString(),
        files: [{ path: 'package.json', before: '{"name":"before"}', after: '{"name":"after"}' }],
      },
    });
    await page.locator('[data-action="inspector-changes"]').click();
    await expect(page.locator('.diff-file')).toBeVisible();
    await page.locator('[data-action="new-task"]').click();
    await expect(page.getByText(/TextModel got disposed/)).toHaveCount(0);

    await page.setViewportSize({ width: 1000, height: 720 });
    await expect(page.locator('[data-action="composer"]')).toBeVisible();
    await expect(page.locator('[data-action="toggle-inspector"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1480, height: 900 });

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
