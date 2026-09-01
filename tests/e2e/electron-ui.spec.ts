import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('Electron UI exposes interactive Codex-style workbench actions', async () => {
  test.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'seecoder-e2e-'));
  const workspace = await mkdtemp(join(tmpdir(), 'seecoder-e2e-workspace-'));
  const importedSkillSource = await mkdtemp(join(tmpdir(), 'seecoder-import-skill-'));
  await writeFile(join(workspace, '.env.example'), 'API_KEY=example\n', 'utf8');
  await writeFile(join(workspace, 'package.json'), '{"name":"e2e-fixture"}\n', 'utf8');
  await mkdir(join(workspace, '.seecoder', 'skills', 'project-summary'), { recursive: true });
  await writeFile(join(workspace, '.seecoder', 'hooks.json'), JSON.stringify({ version: 1, hooks: { preToolUse: [{ id: 'guard', command: 'node --version', timeoutMs: 5000 }], postFileEdit: [], turnEnd: [] } }), 'utf8');
  await writeFile(join(workspace, '.seecoder', 'skills', 'project-summary', 'SKILL.md'), '---\ndescription: 用中文总结项目结构\n---\n先读取 package.json，再用中文总结。\n', 'utf8');
  const importedSkillPath = join(importedSkillSource, 'SKILL.md');
  await writeFile(importedSkillPath, '---\ndescription: 检查本地导入是否工作\n---\n只读检查项目。\n', 'utf8');
  let app = await electron.launch({ args: [resolve('out/main/main.js'), `--user-data-dir=${userData}`], cwd: workspace, timeout: 30_000 });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle('SeeCoder');
    await expect(page.locator('[data-action="new-task"]')).toBeVisible();
    await expect(page.locator('[data-action="permission-mode"]')).toBeVisible();
    await expect(page.locator('[data-action="toggle-inspector"]')).toBeVisible();
    await page.locator('[data-action="toggle-inspector"]').click();
    await expect(page.locator('[data-action="inspector-changes"]')).toBeVisible();
    await expect(page.locator('[data-action="inspector-changes"]')).toHaveText('变更');
    await expect(page.locator('[data-action="inspector-terminal"]')).toHaveCount(0);
    await expect(page.locator('[data-action="inspector-preview"]')).toHaveCount(0);
    await expect(page.locator('[data-action="inspector-files"]')).toHaveCount(0);
    await expect(page.locator('[data-action="inspector-trace"]')).toHaveCount(0);
    await expect(page.locator('.inspector-tabs')).toHaveCount(0);
    await expect(page.locator('[aria-label="工作区 Git 变更"]')).toBeVisible();
    await expect(page.locator('[aria-label="当前任务改动"]')).toContainText('本任务没有修改文件');
    for (const action of ['nav-pulls', 'nav-sites', 'nav-scheduled']) {
      await expect(page.locator(`[data-action="${action}"]`)).toHaveCount(0);
    }
    const initialModel = await page.evaluate(() => window.seecoder.settings.read().then((value) => value.model as string));
    const testApiKey = 'e2e-api-key-1234';
    await page.locator('[data-action="settings"]').click();
    await expect(page.getByRole('table', { name: '模型配置' })).toBeVisible();
    const modelManagementBox = await page.locator('.model-management').boundingBox();
    expect(modelManagementBox?.width).toBeGreaterThan(800);
    await page.locator('[data-action="add-model"]').click();
    await page.locator('[data-action="model-name"]').fill('E2E DeepSeek');
    await page.locator('[data-action="settings-model"]').fill('deepseek-chat');
    await page.locator('[data-action="api-key-input"]').fill(testApiKey);
    await page.locator('[data-action="save-model"]').click();
    let e2eModelRow = page.locator('[data-action="model-row"]').filter({ hasText: 'E2E DeepSeek' });
    await expect(e2eModelRow).toContainText('1234');
    await e2eModelRow.locator('[data-action="set-active-model"]').click();
    const rendererSettings = await page.evaluate(() => window.seecoder.settings.read());
    expect(JSON.stringify(rendererSettings)).not.toContain(testApiKey);
    expect(await page.evaluate(() => `${document.documentElement.textContent}\n${[...document.querySelectorAll('input')].map((input) => input.value).join('\n')}`)).not.toContain(testApiKey);
    await page.locator('[data-action="open-session"]').first().click();
    await expect(page.locator('[data-action="model-settings"]')).toContainText('E2E DeepSeek');
    await page.locator('[data-action="model-settings"]').click();
    await expect(page.locator('[data-action="model-option"]', { hasText: initialModel })).toBeVisible();
    await page.locator('[data-action="model-option"]', { hasText: initialModel }).click();
    await expect(page.locator('[data-action="model-settings"]')).toContainText(initialModel);
    await page.locator('[data-action="settings"]').click();
    e2eModelRow = page.locator('[data-action="model-row"]').filter({ hasText: 'E2E DeepSeek' });
    await e2eModelRow.locator('[data-action="edit-model"]').click();
    await page.locator('[data-action="model-name"]').fill('E2E DeepSeek Updated');
    await page.locator('[data-action="save-model"]').click();
    e2eModelRow = page.locator('[data-action="model-row"]').filter({ hasText: 'E2E DeepSeek Updated' });
    await e2eModelRow.locator('[data-action="toggle-model"]').click();
    await expect(e2eModelRow.locator('[data-action="toggle-model"]')).toHaveAttribute('aria-checked', 'false');
    await e2eModelRow.locator('[data-action="toggle-model"]').click();
    await expect(e2eModelRow.locator('[data-action="toggle-model"]')).toHaveAttribute('aria-checked', 'true');
    await page.locator('[data-action="add-model"]').click();
    await page.locator('[data-action="model-name"]').fill('待删除模型');
    await page.locator('[data-action="settings-model"]').fill('temporary-model');
    await page.locator('[data-action="save-model"]').click();
    const temporaryModelRow = page.locator('[data-action="model-row"]').filter({ hasText: '待删除模型' });
    await temporaryModelRow.locator('[data-action="delete-model"]').click();
    await page.locator('[data-action="dialog-submit"]').click();
    await expect(temporaryModelRow).toHaveCount(0);
    await page.locator('[data-action="new-task"]').click();
    const tasksAfterClick = await page.locator('[data-action="open-session"]').count();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('seecoder:menu', 'new-session'));
    await expect(page.locator('[data-action="open-session"]')).toHaveCount(tasksAfterClick + 1);
    await expect(page.locator('[data-action="composer"]')).toBeVisible();
    await expect(page.locator('.run-status')).toContainText('就绪');
    await expect(page.locator('[data-action="stage-all"]')).toBeDisabled();
    await page.locator('[data-action="permission-mode"]').click();
    await expect(page.locator('[data-action="mode-plan"]')).toBeVisible();
    await page.locator('[data-action="mode-plan"]').click();
    await expect(page.locator('[data-action="permission-mode"]')).toContainText('Plan');
    await expect(page.locator('.composer-note')).toContainText('不会修改工作区');
    await expect(page.locator('.workspace-context')).toBeVisible();

    const activeSession = (await page.evaluate(() => window.seecoder.session.list()))[0]!;
    const semanticToolTurn = 'e2e-semantic-tool-turn';
    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('seecoder:event', payload), {
      type: 'tool.requested', sessionId: activeSession.id, timestamp: new Date().toISOString(), turnId: semanticToolTurn,
      call: { id: 'private-read-call-id', name: 'read_file', args: { path: 'src/support.py', startLine: 12, endLine: 36 } },
    });
    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('seecoder:event', payload), {
      type: 'tool.completed', sessionId: activeSession.id, timestamp: new Date().toISOString(), turnId: semanticToolTurn, callId: 'private-read-call-id',
      result: { ok: true, durationMs: 8, output: { path: 'src/support.py', startLine: 12, endLine: 36, text: 'private file body' } },
    });
    const readActivity = page.locator('.activity').filter({ hasText: '已读取 src/support.py' });
    await expect(readActivity).toContainText('第 12–36 行');
    await readActivity.locator('[data-action="toggle-activity"]').click();
    await expect(readActivity).toContainText('文件');
    await expect(readActivity).not.toContainText('private-read-call-id');
    await expect(readActivity).not.toContainText('private file body');
    await expect(readActivity).not.toContainText('"requested"');

    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('seecoder:event', payload), {
      type: 'tool.requested', sessionId: activeSession.id, timestamp: new Date().toISOString(), turnId: semanticToolTurn,
      call: { id: 'private-plan-call-id', name: 'set_plan', args: { steps: [{ id: 'private-step-id', label: '定位交互问题', status: 'completed' }] } },
    });
    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('seecoder:event', payload), {
      type: 'tool.completed', sessionId: activeSession.id, timestamp: new Date().toISOString(), turnId: semanticToolTurn, callId: 'private-plan-call-id',
      result: { ok: true, durationMs: 1, output: { steps: [{ id: 'private-step-id', label: '定位交互问题', status: 'completed' }] } },
    });
    const planActivity = page.locator('.activity').filter({ hasText: '更新执行计划' });
    await planActivity.locator('[data-action="toggle-activity"]').click();
    await expect(planActivity).toContainText('定位交互问题');
    await expect(planActivity).not.toContainText('private-step-id');
    await expect(planActivity).not.toContainText('private-plan-call-id');

    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('seecoder:event', payload), {
      type: 'tool.requested', sessionId: activeSession.id, timestamp: new Date().toISOString(), turnId: semanticToolTurn,
      call: { id: 'finish-warning-call', name: 'finish', args: { summary: '修改已完成', verification: [] } },
    });
    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('seecoder:event', payload), {
      type: 'tool.completed', sessionId: activeSession.id, timestamp: new Date().toISOString(), turnId: semanticToolTurn, callId: 'finish-warning-call',
      result: { ok: true, durationMs: 1, output: { summary: '修改已完成', verificationStatus: 'warning', warning: '当前代码 revision 没有成功验证' } },
    });
    await expect(page.getByText('完成，但缺少最新验证')).toHaveCount(0);
    await expect(page.getByText(/当前代码 revision 没有成功验证/)).toHaveCount(0);

    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('seecoder:event', payload), {
      type: 'changes.created',
      sessionId: activeSession.id,
      timestamp: new Date().toISOString(),
      changeSet: {
        id: 'e2e-diff-lifecycle', sessionId: activeSession.id, turnId: 'e2e-turn', createdAt: new Date().toISOString(),
        files: [{ path: 'package.json', before: '{"name":"before"}', after: '{"name":"after"}' }],
      },
    });
    await expect(page.locator('.diff-file')).toBeVisible();
    await page.locator('[data-action="expand-change-diff"]').click();
    const changeDialog = page.locator('.diff-dialog');
    await expect(changeDialog).toBeVisible();
    expect((await changeDialog.boundingBox())?.width).toBeGreaterThan(900);
    await page.keyboard.press('Escape');
    await expect(changeDialog).toHaveCount(0);

    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('seecoder:event', payload), {
      type: 'approval.requested', sessionId: activeSession.id, timestamp: new Date().toISOString(),
      approval: {
        id: 'e2e-patch-approval', turnId: 'e2e-patch-turn', reason: '修改测试文件', risk: 'medium', status: 'pending',
        call: { id: 'e2e-patch-call', name: 'apply_patch', args: { patch: '*** Begin Patch\n*** Update File: src/app.ts\n@@ -1,2 +1,2 @@\n-const label = "old";\n+const label = "new with a deliberately long line that needs horizontal scrolling";\n*** End Patch' } },
      },
    });
    const approvalCard = page.locator('.approval-card').filter({ hasText: '批准修改文件' });
    await expect(approvalCard).toBeVisible();
    await approvalCard.locator('[data-action="toggle-patch-diff"]').click();
    await expect(approvalCard).toContainText('src/app.ts');
    await expect(approvalCard).not.toContainText('*** Begin Patch');
    await approvalCard.locator('[data-action="expand-patch-diff"]').click();
    const patchDialog = page.locator('.diff-dialog');
    await expect(patchDialog).toContainText('new with a deliberately long line');
    expect(await patchDialog.locator('.patch-diff-scroll').evaluate((element) => element.scrollWidth >= element.clientWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(patchDialog).toHaveCount(0);
    await page.locator('[data-action="new-task"]').click();
    await expect(page.getByText(/TextModel got disposed/)).toHaveCount(0);

    await page.setViewportSize({ width: 1000, height: 720 });
    await expect(page.locator('[data-action="composer"]')).toBeVisible();
    await expect(page.locator('[data-action="toggle-inspector"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1480, height: 900 });

    await page.locator('[data-action="nav-plugins"]').click();
    await expect(page.getByText('远程插件市场和 MCP 未启用')).toHaveCount(0);
    await expect(page.getByText('project-summary', { exact: true })).toBeVisible();
    const hookRow = page.locator('.extension-row').filter({ hasText: '项目 Hooks' });
    await expect(hookRow).toContainText('等待信任');
    await hookRow.locator('[data-action="toggle-hooks"]').click();
    await expect(page.locator('.prompt-dialog')).toContainText('Hooks 会在工具');
    await page.locator('[data-action="dialog-submit"]').click();
    await expect(hookRow).toContainText('已信任并启用');
    await writeFile(join(workspace, '.seecoder', 'hooks.json'), JSON.stringify({ version: 1, hooks: { preToolUse: [{ id: 'guard-v2', command: 'node --version', timeoutMs: 5000 }], postFileEdit: [], turnEnd: [] } }), 'utf8');
    await page.locator('[data-action="rescan-extensions"]').click();
    await expect(hookRow).toContainText('等待信任');
    await hookRow.locator('[data-action="toggle-hooks"]').click();
    await page.locator('[data-action="dialog-submit"]').click();
    await expect(hookRow).toContainText('已信任并启用');
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, importedSkillPath);
    await page.locator('[data-action="import-skill"]').click();
    const importedRow = page.locator('.extension-row').filter({ hasText: 'seecoder-import-skill-' });
    await expect(importedRow).toContainText('本机导入');
    await importedRow.locator('[data-action="rename-skill"]').click();
    await page.locator('.prompt-dialog input').fill('本机健康检查');
    await page.locator('[data-action="dialog-submit"]').click();
    await expect(page.locator('.extension-row').filter({ hasText: '本机健康检查' })).toBeVisible();
    await writeFile(importedSkillPath, '---\ndescription: 已从原始目录更新\n---\n只读检查项目。\n', 'utf8');
    await page.locator('.extension-row').filter({ hasText: '本机健康检查' }).locator('[data-action="refresh-skill"]').click();
    await expect(page.locator('.extension-row').filter({ hasText: '本机健康检查' })).toContainText('已从原始目录更新');
    await page.locator('.extension-row').filter({ hasText: '本机健康检查' }).locator('[data-action="use-skill"]').click();
    await expect(page.locator('.skill-chip')).toContainText('本机健康检查');
    await expect(page.locator('[data-action="composer"]')).toBeFocused();

    const selectedRow = page.locator('.session.selected').locator('..');
    await selectedRow.locator('[data-action="session-row-menu"]').click();
    await selectedRow.locator('[data-action="session-rename"]').click();
    await page.locator('.prompt-dialog input').fill('Skill 回归任务');
    await page.locator('[data-action="dialog-submit"]').click();
    await expect(page.locator('.session.selected')).toContainText('Skill 回归任务');

    await selectedRow.locator('[data-action="session-row-menu"]').click();
    await selectedRow.locator('[data-action="session-pin"]').click();
    await expect(page.locator('.session.selected svg')).toHaveCount(2);
    await selectedRow.locator('[data-action="session-row-menu"]').click();
    await selectedRow.locator('[data-action="session-archive"]').click();
    await expect(page.locator('[data-action="open-session"]', { hasText: 'Skill 回归任务' })).toHaveCount(0);
    await page.locator('[data-action="history"]').click();
    await expect(page.locator('[data-action="open-history-session"]', { hasText: 'Skill 回归任务' })).toBeVisible();

    await page.locator('[data-action="new-task"]').click();
    const disposableRow = page.locator('.session.selected').locator('..');
    await disposableRow.locator('[data-action="session-row-menu"]').click();
    await disposableRow.locator('[data-action="session-rename"]').click();
    await page.locator('.prompt-dialog input').fill('待删除临时任务');
    await page.locator('[data-action="dialog-submit"]').click();
    await disposableRow.locator('[data-action="session-row-menu"]').click();
    await disposableRow.locator('[data-action="session-delete"]').click();
    await expect(page.locator('.prompt-dialog')).toContainText('项目文件不会被删除');
    await page.locator('[data-action="dialog-submit"]').click();
    await expect(page.locator('[data-action="open-session"]', { hasText: '待删除临时任务' })).toHaveCount(0);
    expect((await page.evaluate(() => window.seecoder.session.list())).some((session) => session.title === '待删除临时任务')).toBe(false);

    await app.close();
    app = await electron.launch({ args: [resolve('out/main/main.js'), `--user-data-dir=${userData}`], cwd: workspace, timeout: 30_000 });
    const reopened = await app.firstWindow();
    await expect(reopened.locator('[data-action="permission-mode"]')).toContainText('Plan');
    await expect(reopened.locator('[data-action="model-settings"]')).toContainText(initialModel);
    await reopened.locator('[data-action="model-settings"]').click();
    await expect(reopened.locator('[data-action="model-option"]', { hasText: 'E2E DeepSeek Updated' })).toBeVisible();
    await reopened.locator('[data-action="model-settings"]').click();
    await reopened.locator('[data-action="settings"]').click();
    await expect(reopened.locator('[data-action="model-row"]').filter({ hasText: 'E2E DeepSeek Updated' }).locator('[data-action="api-key-status"]')).toContainText('1234');
    await expect(reopened.locator('.diagnostics')).toHaveCount(0);
    const persistedSettings = await reopened.evaluate(() => window.seecoder.settings.read());
    expect(JSON.stringify(persistedSettings)).not.toContain(testApiKey);
    if (persistedSettings.logPath) expect(await readFile(persistedSettings.logPath, 'utf8')).not.toContain(testApiKey);
    await reopened.locator('[data-action="nav-plugins"]').click();
    await expect(reopened.locator('.extension-row').filter({ hasText: '项目 Hooks' })).toContainText('已信任并启用');
    const persistedSkill = reopened.locator('.extension-row').filter({ hasText: '本机健康检查' });
    await expect(persistedSkill).toContainText('已从原始目录更新');
    await persistedSkill.locator('[data-action="delete-skill"]').click();
    await reopened.locator('[data-action="dialog-submit"]').click();
    await expect(reopened.locator('.extension-row').filter({ hasText: '本机健康检查' })).toHaveCount(0);
    await expect(reopened.locator('.extension-row').filter({ hasText: 'project-summary' })).toBeVisible();
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(importedSkillSource, { recursive: true, force: true });
  }
});
