import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('Electron workbench renders navigable pages and stable actions', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'seecoder-contract-'));
  const workspace = await mkdtemp(join(tmpdir(), 'seecoder-contract-workspace-'));
  const app = await electron.launch({ args: [resolve('out/main/main.js'), `--user-data-dir=${userData}`], cwd: workspace, timeout: 30_000 });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle('SeeCoder');
    for (const action of ['brand-menu', 'search', 'notifications', 'new-task', 'nav-pulls', 'nav-sites', 'nav-scheduled', 'nav-plugins', 'history', 'settings', 'theme']) {
      await expect(page.locator(`[data-action="${action}"]`)).toHaveCount(1);
    }
    await page.locator('[data-action="workspace-menu"]').click();
    await expect(page.locator('[data-action="switch-workspace"]')).toHaveCount(1);
    await expect(page.locator('[data-action="choose-workspace"]')).toBeVisible();
    await page.locator('[data-action="workspace-menu"]').click();
    for (const [action, heading] of [['nav-pulls', '拉取请求'], ['nav-sites', '站点 / Preview'], ['nav-scheduled', '已安排'], ['nav-plugins', '插件与 Skills']] as const) {
      await page.locator(`[data-action="${action}"]`).click();
      await expect(page.locator('h1')).toContainText(heading);
    }
    await page.locator('[data-action="new-task"]').click();
    await expect(page.locator('[data-action="composer"]')).toBeVisible();
    for (const action of ['attach', 'permission-mode', 'model-settings', 'voice', 'send-turn', 'inspector-changes', 'inspector-files', 'inspector-terminal', 'inspector-preview', 'inspector-trace']) {
      await expect(page.locator(`[data-action="${action}"]`)).toHaveCount(1);
    }
    await expect(page.locator('[data-action="plan-toggle"]')).toHaveCount(0);
    await page.locator('[data-action="permission-mode"]').click();
    await expect(page.locator('[data-action="mode-plan"]')).toBeVisible();

    const session = (await page.evaluate(() => window.seecoder.session.list()))[0]!;
    const turn = { id: 'fork-contract-turn', sessionId: session.id, status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), iteration: 1 };
    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('seecoder:event', payload), {
      type: 'message.completed', sessionId: session.id, timestamp: new Date().toISOString(), turnId: turn.id, text: '已完成检查。',
    });
    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('seecoder:event', payload), {
      type: 'turn.completed', sessionId: session.id, timestamp: new Date().toISOString(), turn,
    });
    await expect(page.locator('[data-action="fork-message"]')).toBeVisible();
    await page.locator('[data-action="fork-message"]').click();
    await expect(page.locator('[data-action="rename-session"]')).toContainText('Fork');
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test('approval layout aligns with activity and old turn failure does not leak into a new turn', async () => {
  test.setTimeout(30_000);
  const userData = await mkdtemp(join(tmpdir(), 'seecoder-turn-state-'));
  const workspace = await mkdtemp(join(tmpdir(), 'seecoder-turn-state-workspace-'));
  const app = await electron.launch({ args: [resolve('out/main/main.js'), `--user-data-dir=${userData}`], cwd: workspace, timeout: 30_000 });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('[data-action="composer"]')).toBeVisible();
    await expect(page.locator('[data-action="open-session"]')).toHaveCount(1);
    const session = (await page.evaluate(() => window.seecoder.session.list()))[0]!;
    const startedAt = new Date().toISOString();
    const oldTurn = { id: 'old-failed-turn', sessionId: session.id, status: 'running', startedAt, iteration: 1 };
    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('seecoder:event', payload), {
      type: 'turn.started', sessionId: session.id, timestamp: startedAt, turn: oldTurn,
    });
    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('seecoder:event', payload), {
      type: 'turn.failed', sessionId: session.id, timestamp: new Date().toISOString(),
      turn: { ...oldTurn, status: 'failed', completedAt: new Date().toISOString() },
      error: { code: 'system_error', message: '应用在任务结束前退出', retryable: true },
    });
    await expect(page.locator('.failure-banner')).toBeVisible();

    const currentTurn = { id: 'current-approval-turn', sessionId: session.id, status: 'running', startedAt: new Date().toISOString(), iteration: 1 };
    const call = {
      id: 'approval-layout-call',
      name: 'apply_patch',
      args: { patch: '*** Begin Patch\n*** Update File: backend/agent/core.py\n@@\n-old\n+new\n*** End Patch' },
    };
    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('seecoder:event', payload), {
      type: 'turn.started', sessionId: session.id, timestamp: currentTurn.startedAt, turn: currentTurn,
    });
    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('seecoder:event', payload), {
      type: 'tool.requested', sessionId: session.id, timestamp: new Date().toISOString(), turnId: currentTurn.id, call,
    });
    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('seecoder:event', payload), {
      type: 'approval.requested', sessionId: session.id, timestamp: new Date().toISOString(),
      approval: { id: 'approval-layout', turnId: currentTurn.id, call, reason: 'Guided 模式要求在执行前确认', risk: 'medium', status: 'pending' },
    });

    await expect(page.locator('.failure-banner')).toHaveCount(0);
    const activity = page.locator('.activity').filter({ hasText: '应用代码修改' });
    const approval = page.locator('.approval-card');
    await expect(approval).toContainText('批准修改文件');
    await expect(approval).toContainText('backend/agent/core.py');
    await expect(approval.locator('.approval-diff-body')).toHaveCount(0);
    const activityBox = await activity.boundingBox();
    const approvalBox = await approval.boundingBox();
    expect(Math.abs((activityBox?.x ?? 0) - (approvalBox?.x ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((activityBox?.width ?? 0) - (approvalBox?.width ?? 0))).toBeLessThanOrEqual(1);
    await approval.locator('[data-action="toggle-patch-diff"]').click();
    await expect(approval.locator('.patch-diff-scroll')).toBeVisible();
    await expect(approval).toContainText('new');
    await expect(approval).not.toContainText('*** Begin Patch');
    await approval.locator('[data-action="expand-patch-diff"]').click();
    await expect(page.locator('.diff-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.diff-dialog')).toHaveCount(0);
    await expect(approval.locator('[data-action="deny-approval"]')).toBeVisible();
    await expect(approval.locator('[data-action="allow-approval"]')).toBeVisible();
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
