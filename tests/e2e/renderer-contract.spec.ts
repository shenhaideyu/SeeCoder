import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('Electron workbench renders navigable pages and stable actions', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'seecoder-contract-'));
  const app = await electron.launch({ args: [resolve('out/main/main.js'), `--user-data-dir=${userData}`], timeout: 30_000 });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle('SeeCoder');
    for (const action of ['brand-menu', 'search', 'notifications', 'new-task', 'nav-pulls', 'nav-sites', 'nav-scheduled', 'nav-plugins', 'history', 'settings', 'theme']) {
      await expect(page.locator(`[data-action="${action}"]`)).toHaveCount(1);
    }
    for (const [action, heading] of [['nav-pulls', '拉取请求'], ['nav-sites', '站点 / Preview'], ['nav-scheduled', '已安排'], ['nav-plugins', '插件与 Skills']] as const) {
      await page.locator(`[data-action="${action}"]`).click();
      await expect(page.locator('h1')).toContainText(heading);
    }
    await page.locator('[data-action="new-task"]').click();
    await expect(page.locator('[data-action="composer"]')).toBeVisible();
    for (const action of ['attach', 'permission-mode', 'plan-toggle', 'model-settings', 'voice', 'send-turn', 'inspector-changes', 'inspector-files', 'inspector-terminal', 'inspector-preview', 'inspector-trace']) {
      await expect(page.locator(`[data-action="${action}"]`)).toHaveCount(1);
    }
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
