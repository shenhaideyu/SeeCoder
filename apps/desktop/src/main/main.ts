import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentCore } from '@seecoder/agent-core';
import { OpenAICompatibleProvider, type ModelConfig } from '@seecoder/model';
import { SessionStore } from '@seecoder/storage';
import { ToolRegistry, WorkspacePolicy, commandRunner, type ToolContext } from '@seecoder/tools';
import type { AgentEvent, AttachmentRef, ExecutionMode, ScheduleDefinition, Thread } from '@seecoder/protocol';

let mainWindow: BrowserWindow | null = null;
let core: AgentCore;
let coreUnsubscribe: (() => void) | undefined;
let workspace = process.cwd();
let mode: ExecutionMode = 'guided';
let scheduleTimer: NodeJS.Timeout | undefined;
const runningSchedules = new Set<string>();
const modelConfig: ModelConfig = {
  baseUrl: process.env.SEECODER_BASE_URL ?? 'https://api.openai.com/v1',
  model: process.env.SEECODER_MODEL ?? 'gpt-4o-mini', apiKeyEnv: 'SEECODER_API_KEY',
  contextWindow: 128000, temperature: 0.2, maxOutputTokens: 8192,
};
const storeRoot = () => join(app.getPath('userData'), 'sessions-data');
const toolRegistry = new ToolRegistry();
const send = (event: AgentEvent): void => { mainWindow?.webContents.send('seecoder:event', event); };

function createCore(): void {
  coreUnsubscribe?.();
  const store = new SessionStore(storeRoot());
  core = new AgentCore({ workspace, mode, model: modelConfig, store, provider: new OpenAICompatibleProvider(modelConfig), registry: toolRegistry });
  coreUnsubscribe = core.onEvent((event) => {
    send(event);
    if (event.type === 'turn.completed' && mainWindow && !mainWindow.isFocused() && Notification.isSupported()) new Notification({ title: 'SeeCoder 任务完成', body: '任务已完成，请查看验证结果。' }).show();
  });
}

async function selectWorkspace(): Promise<string | null> {
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'], title: '选择 SeeCoder 工作区' });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

const textArg = (value: unknown, name: string, max = 100_000): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${name} 参数无效`);
  return value;
};
const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
function commandContext(onOutput?: ToolContext['onOutput']): ToolContext { return onOutput ? { workspace, onOutput } : { workspace }; }
async function runWorkspaceCommand(command: string, cwd = workspace, timeoutMs = 30_000, onOutput?: ToolContext['onOutput']) {
  const resolved = await new WorkspacePolicy(workspace).path(cwd);
  return commandRunner(command, resolved, commandContext(onOutput), timeoutMs);
}

async function readSchedules(): Promise<ScheduleDefinition[]> {
  try { return JSON.parse(await readFile(join(app.getPath('userData'), 'schedules.json'), 'utf8')) as ScheduleDefinition[]; } catch { return []; }
}
async function saveSchedules(value: ScheduleDefinition[]): Promise<void> {
  const file = join(app.getPath('userData'), 'schedules.json');
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

function nextScheduleAt(cadence: ScheduleDefinition['cadence']): string | undefined {
  if (cadence === 'manual') return undefined;
  const next = new Date();
  if (cadence === 'hourly') next.setHours(next.getHours() + 1);
  if (cadence === 'daily') next.setDate(next.getDate() + 1);
  if (cadence === 'weekly') next.setDate(next.getDate() + 7);
  return next.toISOString();
}

function startScheduleLoop(): void {
  scheduleTimer = setInterval(() => {
    void (async () => {
      const nowMs = Date.now();
      const list = await readSchedules();
      let changed = false;
      for (const item of list) {
        if (!item.enabled || item.cadence === 'manual' || runningSchedules.has(item.id)) continue;
        if (item.nextRunAt && Date.parse(item.nextRunAt) > nowMs) continue;
        runningSchedules.add(item.id);
        const nextAt = nextScheduleAt(item.cadence);
        if (nextAt) item.nextRunAt = nextAt;
        else delete item.nextRunAt;
        changed = true;
        const thread = (await core.listThreads()).find((value) => value.workspacePath === item.projectPath) ?? await core.createThread(`计划：${item.prompt.slice(0, 40)}`);
        void core.startTurn(thread.id, item.prompt, 'plan').finally(() => runningSchedules.delete(item.id));
      }
      if (changed) await saveSchedules(list);
    })();
  }, 60_000);
  scheduleTimer.unref?.();
}

async function listExtensions(): Promise<Array<{ name: string; description: string; path: string; kind: 'skill' | 'hook' }>> {
  const output: Array<{ name: string; description: string; path: string; kind: 'skill' | 'hook' }> = [];
  for (const base of [join(workspace, '.seecoder', 'skills'), join(workspace, '.agents', 'skills')]) {
    if (!existsSync(base)) continue;
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(base, entry.name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;
      const content = await readFile(skillPath, 'utf8');
      const description = content.match(/description:\s*(.+)/i)?.[1]?.trim() ?? '本地可复用工作流';
      output.push({ name: entry.name, description, path: skillPath, kind: 'skill' });
    }
  }
  const hookPath = join(workspace, '.seecoder', 'hooks.json');
  if (existsSync(hookPath)) output.push({ name: '项目 Hooks', description: '受信任的生命周期钩子', path: hookPath, kind: 'hook' });
  return output;
}

function registerMenu(): void {
  const menu = Menu.buildFromTemplate([
    { label: '文件', submenu: [{ label: '新建任务', accelerator: 'Ctrl+N', click: () => mainWindow?.webContents.send('seecoder:menu', 'new-thread') }, { label: '选择工作区', click: () => void selectWorkspace() }, { type: 'separator' }, { role: 'quit', label: '退出' }] },
    { label: '编辑', submenu: [{ role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '视图', submenu: [{ label: '命令面板', accelerator: 'Ctrl+K', click: () => mainWindow?.webContents.send('seecoder:menu', 'command-palette') }, { label: '切换右侧面板', click: () => mainWindow?.webContents.send('seecoder:menu', 'toggle-inspector') }, { role: 'toggleDevTools', label: '开发者工具' }] },
    { label: '帮助', submenu: [{ label: 'SeeCoder 使用说明', click: () => mainWindow?.webContents.send('seecoder:menu', 'help') }, { label: '关于 SeeCoder', click: () => mainWindow?.webContents.send('seecoder:menu', 'about') }] },
  ]);
  Menu.setApplicationMenu(menu);
}

function registerIpc(): void {
  ipcMain.handle('workspace:select', async () => { const selected = await selectWorkspace(); if (!selected) return { cancelled: true }; workspace = selected; createCore(); return { cancelled: false, workspace }; });
  ipcMain.handle('workspace:open', async () => { await shell.openPath(workspace); return workspace; });
  ipcMain.handle('thread:create', async (_event, title?: string) => core.createThread(typeof title === 'string' && title.length <= 120 ? title : undefined));
  ipcMain.handle('thread:list', async () => (await core.listThreads()).map((thread) => ({ ...thread, pinned: thread.pinned ?? false, archived: thread.archived ?? false, unread: thread.unread ?? false })));
  ipcMain.handle('thread:hydrate', async (_event, threadId: string) => core.hydrateThread(textArg(threadId, 'threadId', 100)));
  ipcMain.handle('thread:history', async (_event, threadId: string) => core.readThreadEvents(textArg(threadId, 'threadId', 100)));
  ipcMain.handle('thread:rename', async (_event, threadId: string, title: string) => { const thread = await core.hydrateThread(textArg(threadId, 'threadId', 100)); if (!thread) throw new Error('thread 不存在'); thread.title = textArg(title, 'title', 120); thread.updatedAt = new Date().toISOString(); await new SessionStore(storeRoot()).saveThread(thread); return thread; });
  ipcMain.handle('thread:flag', async (_event, threadId: string, flag: 'pinned' | 'archived') => { const thread = await core.hydrateThread(textArg(threadId, 'threadId', 100)); if (!thread) throw new Error('thread 不存在'); thread[flag] = !thread[flag]; thread.updatedAt = new Date().toISOString(); await new SessionStore(storeRoot()).saveThread(thread); return thread; });
  ipcMain.handle('thread:fork', async (_event, threadId: string) => { const source = await core.hydrateThread(textArg(threadId, 'threadId', 100)); if (!source) return null; const forked = await core.createThread(`${source.title}（Fork）`); const history = await new SessionStore(storeRoot()).readEvents(source.id); const forkStore = new SessionStore(storeRoot()); for (const record of history) await forkStore.append(forked.id, { event: { ...record.event, threadId: forked.id }, ...(record.item ? { item: record.item } : {}) }); await core.hydrateThread(forked.id); return forked; });
  ipcMain.handle('thread:search', async (_event, query: string) => { const q = textArg(query, 'query', 200).toLowerCase(); const all = await core.listThreads(); const store = new SessionStore(storeRoot()); const result: Thread[] = []; for (const thread of all) { if (thread.title.toLowerCase().includes(q)) { result.push(thread); continue; } const events = await store.readEvents(thread.id); if (events.some((record) => JSON.stringify(record.event).toLowerCase().includes(q))) result.push(thread); } return result; });
  ipcMain.handle('thread:export', async (_event, threadId: string, format: 'markdown' | 'json') => { const id = textArg(threadId, 'threadId', 100); const events = await core.readThreadEvents(id); const body = format === 'json' ? JSON.stringify(events, null, 2) : events.map((event) => `${event.type}\n${JSON.stringify(event, null, 2)}`).join('\n\n'); const target = await dialog.showSaveDialog(mainWindow!, { defaultPath: `seecoder-${id.slice(0, 8)}.${format === 'json' ? 'json' : 'md'}` }); if (target.canceled || !target.filePath) return { cancelled: true }; await writeFile(target.filePath, body, 'utf8'); return { cancelled: false, path: target.filePath }; });
  ipcMain.handle('turn:start', async (_event, threadId: string, text: string, attachments?: AttachmentRef[]) => core.startTurn(textArg(threadId, 'threadId', 100), textArg(text, 'text'), undefined, Array.isArray(attachments) ? attachments.slice(0, 4) : []));
  ipcMain.handle('turn:followUp', async (_event, turnId: string, text: string) => { core.queueFollowUp(textArg(turnId, 'turnId', 100), textArg(text, 'text')); });
  ipcMain.handle('turn:cancel', async (_event, turnId: string) => core.cancelTurn(textArg(turnId, 'turnId', 100)));
  ipcMain.handle('approval:resolve', async (_event, approvalId: string, decision: 'allow' | 'deny', reason?: string) => core.resolveApproval(textArg(approvalId, 'approvalId', 100), decision === 'allow' ? 'allow' : 'deny', typeof reason === 'string' ? reason.slice(0, 500) : undefined));
  ipcMain.handle('input:resolve', async (_event, requestId: string, answer: string) => core.resolveUserInput(textArg(requestId, 'requestId', 100), textArg(answer, 'answer', 10_000)));
  ipcMain.handle('plan:approve', async () => { mode = 'guided'; core.setMode(mode); return mode; });
  ipcMain.handle('changes:revert', async (_event, changeSetId: string) => core.revertChangeSet(textArg(changeSetId, 'changeSetId', 100)));
  ipcMain.handle('checkpoint:list', async (_event, threadId?: string) => core.listCheckpoints(typeof threadId === 'string' ? threadId : undefined));
  ipcMain.handle('checkpoint:restore', async (_event, checkpointId: string) => core.restoreCheckpoint(textArg(checkpointId, 'checkpointId', 100)));
  ipcMain.handle('files:list', async (_event, path?: string, depth?: number) => toolRegistry.get('list_files')?.execute({ path, depth }, { workspace }));
  ipcMain.handle('files:read', async (_event, path: string, startLine?: number, endLine?: number) => toolRegistry.get('read_file')?.execute({ path: textArg(path, 'path', 1000), startLine, endLine }, { workspace }));
  ipcMain.handle('files:search', async (_event, query: string, path?: string) => toolRegistry.get('search_text')?.execute({ query: textArg(query, 'query', 500), path }, { workspace }));
  ipcMain.handle('attachment:select', async () => { const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile', 'multiSelections'], filters: [{ name: '文本与图片', extensions: ['txt', 'md', 'json', 'ts', 'tsx', 'js', 'jsx', 'css', 'html', 'png', 'jpg', 'jpeg'] }] }); if (result.canceled) return []; const policy = new WorkspacePolicy(workspace); const values: AttachmentRef[] = []; for (const path of result.filePaths.slice(0, 4)) { const stat = await (await import('node:fs/promises')).stat(path); if (stat.size > 5 * 1024 * 1024 || !policy.isInside(path)) continue; const mimeType = /\.(png|jpe?g)$/i.test(path) ? 'image/' + (path.toLowerCase().endsWith('.png') ? 'png' : 'jpeg') : 'text/plain'; values.push({ id: randomUUID(), kind: mimeType.startsWith('image/') ? 'image' : 'text', name: path.split(/[\\/]/).pop() ?? path, path, mimeType, size: stat.size }); } return values; });
  ipcMain.handle('git:status', async () => runWorkspaceCommand('git status --short --branch'));
  ipcMain.handle('git:diff', async (_event, scope: 'unstaged' | 'staged' | 'branch' | 'last-turn' = 'unstaged') => runWorkspaceCommand(scope === 'staged' ? 'git diff --cached' : 'git diff'));
  ipcMain.handle('git:branches', async () => runWorkspaceCommand('git branch --format="%(refname:short)"'));
  ipcMain.handle('git:checkout', async (_event, branch: string) => { const name = textArg(branch, 'branch', 200); if (!/^[\w./-]+$/.test(name)) throw new Error('分支名称包含不允许的字符'); return runWorkspaceCommand(`git switch ${psQuote(name)}`, workspace, 60_000); });
  ipcMain.handle('git:stage', async (_event, path?: string) => runWorkspaceCommand(path ? `git add -- ${psQuote(relative(workspace, await new WorkspacePolicy(workspace).path(path)))}` : 'git add -A'));
  ipcMain.handle('git:unstage', async (_event, path?: string) => runWorkspaceCommand(path ? `git restore --staged -- ${psQuote(relative(workspace, await new WorkspacePolicy(workspace).path(path)))}` : 'git restore --staged .'));
  ipcMain.handle('git:revert', async (_event, path: string) => runWorkspaceCommand(`git restore -- ${psQuote(relative(workspace, await new WorkspacePolicy(workspace).path(textArg(path, 'path', 1000))))}`));
  ipcMain.handle('git:commit', async (_event, message: string) => runWorkspaceCommand(`git commit -m ${psQuote(textArg(message, 'message', 2000))}`, workspace, 60_000));
  ipcMain.handle('git:push', async () => runWorkspaceCommand('git push', workspace, 120_000));
  ipcMain.handle('git:prStatus', async () => runWorkspaceCommand('gh pr status --json number,title,state,url', workspace, 30_000));
  ipcMain.handle('terminal:run', async (_event, command: string, cwd?: string) => runWorkspaceCommand(textArg(command, 'command', 20_000), cwd, 120_000));
  ipcMain.handle('preview:open', async (_event, url: string) => { const target = textArg(url, 'url', 1000); if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(`${target}/`)) throw new Error('Preview 只允许 localhost 地址'); await shell.openExternal(target); return target; });
  ipcMain.handle('extension:list', async () => listExtensions());
  ipcMain.handle('schedule:list', async () => readSchedules());
  ipcMain.handle('schedule:save', async (_event, input: ScheduleDefinition) => { const list = await readSchedules(); const nextAt = input.enabled ? (input.nextRunAt ?? nextScheduleAt(input.cadence)) : undefined; const value: ScheduleDefinition = { ...input, ...(nextAt ? { nextRunAt: nextAt } : {}) }; const next = [...list.filter((item) => item.id !== input.id), value]; await saveSchedules(next); return next; });
  ipcMain.handle('schedule:toggle', async (_event, id: string, enabled: boolean) => { const list = await readSchedules(); const next = list.map((item) => item.id === id ? { ...item, enabled } : item); await saveSchedules(next); return next; });
  ipcMain.handle('schedule:run', async (_event, id: string) => { const item = (await readSchedules()).find((value) => value.id === id); if (!item) throw new Error('计划不存在'); const thread = (await core.listThreads()).find((value) => value.workspacePath === item.projectPath) ?? await core.createThread(`计划：${item.prompt.slice(0, 40)}`); return core.startTurn(thread.id, item.prompt, 'plan'); });
  ipcMain.handle('settings:read', async () => ({ workspace, mode: core.getMode(), model: modelConfig.model, baseUrl: modelConfig.baseUrl, contextWindow: modelConfig.contextWindow, maxOutputTokens: modelConfig.maxOutputTokens, hasApiKey: Boolean(process.env[modelConfig.apiKeyEnv]) }));
  ipcMain.handle('settings:update', async (_event, next: { mode?: ExecutionMode; model?: string; baseUrl?: string; contextWindow?: number; maxOutputTokens?: number; temporaryApiKey?: string }) => { if (next.mode) { mode = next.mode; core.setMode(mode); } if (typeof next.model === 'string' && next.model.length <= 200) modelConfig.model = next.model; if (typeof next.baseUrl === 'string' && next.baseUrl.length <= 1000) modelConfig.baseUrl = next.baseUrl; if (typeof next.contextWindow === 'number') modelConfig.contextWindow = Math.max(8_000, Math.min(1_000_000, next.contextWindow)); if (typeof next.maxOutputTokens === 'number') modelConfig.maxOutputTokens = Math.max(256, Math.min(64_000, next.maxOutputTokens)); if (typeof next.temporaryApiKey === 'string' && next.temporaryApiKey.length <= 1000) process.env[modelConfig.apiKeyEnv] = next.temporaryApiKey; return { workspace, mode: core.getMode(), model: modelConfig.model, baseUrl: modelConfig.baseUrl, contextWindow: modelConfig.contextWindow, maxOutputTokens: modelConfig.maxOutputTokens, hasApiKey: Boolean(process.env[modelConfig.apiKeyEnv]) }; });
}

async function createWindow(): Promise<void> {
  createCore();
  mainWindow = new BrowserWindow({ width: 1480, height: 940, minWidth: 1050, minHeight: 680, backgroundColor: '#f6f6f7', title: 'SeeCoder', webPreferences: { preload: join(__dirname, '../preload/preload.mjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) await mainWindow.loadURL(rendererUrl); else await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => { registerIpc(); registerMenu(); await createWindow(); startScheduleLoop(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); }); });
app.on('window-all-closed', () => { if (scheduleTimer) clearInterval(scheduleTimer); if (process.platform !== 'darwin') app.quit(); });
