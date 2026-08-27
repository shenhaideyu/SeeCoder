import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, safeStorage, shell } from 'electron';
import { existsSync } from 'node:fs';
import { appendFile, readdir, readFile, writeFile, mkdir, realpath, rename } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentCore } from '@seecoder/agent-core';
import { OpenAICompatibleProvider, type ModelConfig } from '@seecoder/model';
import { SessionStore } from '@seecoder/storage';
import { ToolRegistry, WorkspacePolicy, commandRunner, isHighRiskCommand, type ToolContext } from '@seecoder/tools';
import type { AgentEvent, AttachmentRef, ExecutionMode, ScheduleDefinition, Thread } from '@seecoder/protocol';

// 未打包运行时 Electron 默认使用应用名“Electron”，会把会话和日志写入
// %APPDATA%\\Electron。显式固定产品名，确保 SeeCoder 的数据隔离和可审计路径稳定。
app.setName('SeeCoder');

let mainWindow: BrowserWindow | null = null;
let core: AgentCore;
let coreUnsubscribe: (() => void) | undefined;
let workspace = process.cwd();
let mode: ExecutionMode = 'guided';
let scheduleTimer: NodeJS.Timeout | undefined;
const runningSchedules = new Set<string>();
const scheduledTurns = new Map<string, string>();
let recentWorkspaces: string[] = [];
class MainLogger {
  private filePath: string | undefined;
  private queue = Promise.resolve();

  init(root: string): void {
    this.filePath = join(root, 'logs', 'main.log');
    this.queue = this.queue.then(async () => { await mkdir(join(root, 'logs'), { recursive: true }); });
  }

  write(level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, unknown>): void {
    if (!this.filePath) return;
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    const line = `${new Date().toISOString()} [${level}] ${message}${suffix}\n`;
    this.queue = this.queue.then(async () => { await appendFile(this.filePath!, line, 'utf8'); }).catch(() => undefined);
  }

  event(event: AgentEvent): void {
    const turnId = 'turnId' in event ? event.turnId
      : 'turn' in event ? event.turn.id
        : 'approval' in event ? event.approval.turnId
          : 'changeSet' in event ? event.changeSet.turnId
            : 'child' in event ? event.child.parentTurnId
              : undefined;
    const base = { type: event.type, threadId: event.threadId, turnId };
    if (event.type === 'tool.requested') this.write('INFO', 'agent.tool.requested', { ...base, callId: event.call.id, tool: event.call.name });
    else if (event.type === 'tool.completed') this.write(event.result.ok ? 'INFO' : 'WARN', 'agent.tool.completed', { ...base, callId: event.callId, ok: event.result.ok, durationMs: event.result.durationMs, error: event.result.error?.code });
    else if (event.type === 'tool.output') this.write('INFO', 'agent.tool.output', { ...base, callId: event.callId, stream: event.stream, bytes: event.text.length });
    else if (event.type === 'model.completed') this.write('INFO', 'agent.model.completed', { ...base, iteration: event.iteration, durationMs: event.durationMs, inputTokens: event.inputTokens, outputTokens: event.outputTokens, retries: event.retries, finishReason: event.finishReason });
    else if (event.type === 'subagent.updated') this.write(event.child.status === 'failed' ? 'WARN' : 'INFO', 'agent.subagent.updated', { ...base, childId: event.child.id, role: event.child.role, status: event.child.status, iteration: event.child.iteration, durationMs: event.child.durationMs, inputTokens: event.child.inputTokens, outputTokens: event.child.outputTokens, currentAction: event.child.currentAction, error: event.child.errorCode });
    else if (event.type === 'turn.started' || event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled') this.write(event.type === 'turn.failed' ? 'ERROR' : 'INFO', `agent.${event.type}`, { ...base, status: event.turn.status, iteration: event.turn.iteration, ...(event.type === 'turn.failed' ? { error: event.error.code } : {}) });
    else if (event.type === 'approval.requested' || event.type === 'approval.resolved' || event.type === 'checkpoint.created' || event.type === 'checkpoint.restored') this.write('INFO', `agent.${event.type}`, base);
  }
}
const logger = new MainLogger();
const modelConfig: ModelConfig = {
  baseUrl: process.env.SEECODER_BASE_URL ?? 'https://api.openai.com/v1',
  model: process.env.SEECODER_MODEL ?? 'gpt-4o-mini', apiKeyEnv: 'SEECODER_API_KEY',
  contextWindow: 128000, temperature: 0.2, maxOutputTokens: 8192,
};
const storeRoot = () => join(app.getPath('userData'), 'sessions-data');
const settingsPath = () => join(app.getPath('userData'), 'config', 'settings.json');
const sameWorkspace = (left: string, right: string): boolean => {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};
const toolRegistry = new ToolRegistry();
const send = (event: AgentEvent): void => { mainWindow?.webContents.send('seecoder:event', event); };

function createCore(): void {
  coreUnsubscribe?.();
  const store = new SessionStore(storeRoot());
  core = new AgentCore({ workspace, mode, model: modelConfig, store, provider: new OpenAICompatibleProvider(modelConfig), registry: toolRegistry });
  coreUnsubscribe = core.onEvent((event) => {
    logger.event(event);
    send(event);
    if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled') {
      const scheduleId = scheduledTurns.get(event.turn.id);
      if (scheduleId) {
        scheduledTurns.delete(event.turn.id);
        runningSchedules.delete(scheduleId);
      }
    }
    if (event.type === 'turn.completed' && mainWindow && !mainWindow.isFocused() && Notification.isSupported()) new Notification({ title: 'SeeCoder 任务完成', body: '任务已完成，请查看验证结果。' }).show();
  });
}

async function selectWorkspace(): Promise<string | null> {
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'], title: '选择 SeeCoder 工作区' });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

async function switchWorkspace(nextWorkspace: string): Promise<string> {
  const next = resolve(textArg(nextWorkspace, 'workspace', 2000));
  if (!existsSync(next)) throw new Error('工作区目录不存在');
  core.cancelAll();
  workspace = next;
  recentWorkspaces = [next, ...recentWorkspaces.filter((item) => !sameWorkspace(item, next) && existsSync(item))].slice(0, 8);
  await savePersistedSettings();
  createCore();
  logger.write('INFO', 'workspace.changed', { workspace });
  return workspace;
}

const textArg = (value: unknown, name: string, max = 100_000): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${name} 参数无效`);
  return value;
};
const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
function commandContext(onOutput?: ToolContext['onOutput']): ToolContext { return onOutput ? { workspace, onOutput } : { workspace }; }
async function runWorkspaceCommand(command: string, cwd = workspace, timeoutMs = 30_000, onOutput?: ToolContext['onOutput']) {
  const commandName = command.trim().split(/\s+/)[0]?.slice(0, 40) || 'unknown';
  const started = Date.now();
  logger.write('INFO', 'workspace.command.started', { command: commandName, cwd });
  try {
    const resolved = await new WorkspacePolicy(workspace).path(cwd);
    const result = await commandRunner(command, resolved, commandContext(onOutput), timeoutMs);
    logger.write(result.ok ? 'INFO' : 'WARN', 'workspace.command.completed', { command: commandName, ok: result.ok, durationMs: Date.now() - started, error: result.error?.code });
    return result;
  } catch (error) {
    logger.write('WARN', 'workspace.command.rejected', { command: commandName, durationMs: Date.now() - started, message: error instanceof Error ? error.message : '命令被拒绝' });
    throw error;
  }
}

async function scopedGitRoot(): Promise<string> {
  const probe = await runWorkspaceCommand('git rev-parse --show-toplevel');
  const output = probe.output as { stdout?: unknown } | undefined;
  const root = typeof output?.stdout === 'string' ? output.stdout.trim() : '';
  if (!probe.ok || !root) throw new Error('当前工作区不是 Git 仓库');
  const [canonicalWorkspace, canonicalRoot] = await Promise.all([
    realpath(workspace).catch(() => resolve(workspace)),
    realpath(root).catch(() => resolve(root)),
  ]);
  if (!sameWorkspace(canonicalWorkspace, canonicalRoot)) {
    throw new Error('Git 操作已禁用：当前目录属于上级仓库。请切换到仓库根目录，避免操作工作区外文件。');
  }
  return canonicalRoot;
}

async function runScopedGitCommand(command: string, timeoutMs = 30_000) {
  return runWorkspaceCommand(command, await scopedGitRoot(), timeoutMs);
}

interface PersistedSettings {
  workspace?: string;
  recentWorkspaces?: string[];
  mode?: ExecutionMode;
  model?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** 使用 Electron safeStorage（Windows DPAPI）加密后的 API Key。 */
  apiKeyEncrypted?: string;
}

let persistedApiKeyEncrypted: string | undefined;
let apiKeySource: 'environment' | 'os' | 'none' = 'none';

function encryptApiKey(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储暂不可用，请稍后重试或设置 SEECODER_API_KEY 环境变量');
  return safeStorage.encryptString(value).toString('base64');
}

function decryptApiKey(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取已保存的 API Key');
  return safeStorage.decryptString(Buffer.from(value, 'base64'));
}

async function loadPersistedSettings(): Promise<void> {
  try {
    const value = JSON.parse(await readFile(settingsPath(), 'utf8')) as PersistedSettings;
    if (typeof value.workspace === 'string' && existsSync(value.workspace)) workspace = value.workspace;
    if (value.mode === 'plan' || value.mode === 'guided' || value.mode === 'auto') mode = value.mode;
    recentWorkspaces = [workspace, ...(Array.isArray(value.recentWorkspaces) ? value.recentWorkspaces : [])]
      .filter((item, index, list) => typeof item === 'string' && existsSync(item) && list.findIndex((value) => sameWorkspace(value, item)) === index)
      .slice(0, 8);
    if (typeof value.model === 'string' && value.model.length <= 200) modelConfig.model = value.model;
    if (typeof value.baseUrl === 'string' && value.baseUrl.length <= 1000) modelConfig.baseUrl = value.baseUrl;
    if (typeof value.contextWindow === 'number') modelConfig.contextWindow = Math.max(8_000, Math.min(1_000_000, value.contextWindow));
    if (typeof value.maxOutputTokens === 'number') modelConfig.maxOutputTokens = Math.max(256, Math.min(64_000, value.maxOutputTokens));
    persistedApiKeyEncrypted = typeof value.apiKeyEncrypted === 'string' ? value.apiKeyEncrypted : undefined;
    if (process.env[modelConfig.apiKeyEnv]) {
      apiKeySource = 'environment';
    } else if (persistedApiKeyEncrypted) {
      try {
        const decrypted = decryptApiKey(persistedApiKeyEncrypted);
        if (decrypted) {
          process.env[modelConfig.apiKeyEnv] = decrypted;
          apiKeySource = 'os';
        }
      } catch {
        logger.write('WARN', 'settings.key.decrypt.failed', { storage: 'os' });
      }
    }
    logger.write('INFO', 'settings.loaded', { model: modelConfig.model, baseUrl: modelConfig.baseUrl });
  } catch {
    // 首次启动没有配置文件是正常情况。
    if (process.env[modelConfig.apiKeyEnv]) apiKeySource = 'environment';
  }
}

async function savePersistedSettings(options: { apiKey?: string; clearApiKey?: boolean } = {}): Promise<void> {
  const target = settingsPath();
  const temporary = `${target}.tmp`;
  await mkdir(join(app.getPath('userData'), 'config'), { recursive: true });
  if (options.apiKey !== undefined) {
    if (!options.apiKey.trim()) throw new Error('API Key 不能为空');
    persistedApiKeyEncrypted = encryptApiKey(options.apiKey.trim());
    process.env[modelConfig.apiKeyEnv] = options.apiKey.trim();
    apiKeySource = 'os';
  } else if (options.clearApiKey) {
    persistedApiKeyEncrypted = undefined;
    if (apiKeySource === 'os') delete process.env[modelConfig.apiKeyEnv];
    apiKeySource = process.env[modelConfig.apiKeyEnv] ? 'environment' : 'none';
  }
  const payload: PersistedSettings = { workspace, recentWorkspaces, mode, model: modelConfig.model, baseUrl: modelConfig.baseUrl, contextWindow: modelConfig.contextWindow, maxOutputTokens: modelConfig.maxOutputTokens, ...(persistedApiKeyEncrypted ? { apiKeyEncrypted: persistedApiKeyEncrypted } : {}) };
  await writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8');
  await rename(temporary, target);
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
        if (!sameWorkspace(item.projectPath, workspace)) continue;
        if (!item.enabled || item.cadence === 'manual' || runningSchedules.has(item.id)) continue;
        if (item.nextRunAt && Date.parse(item.nextRunAt) > nowMs) continue;
        runningSchedules.add(item.id);
        const nextAt = nextScheduleAt(item.cadence);
        if (nextAt) item.nextRunAt = nextAt;
        else delete item.nextRunAt;
        changed = true;
        const thread = (await core.listThreads()).find((value) => value.workspacePath === item.projectPath) ?? await core.createThread(`计划：${item.prompt.slice(0, 40)}`);
        void core.startTurn(thread.id, item.prompt, 'plan')
          .then((turnId) => scheduledTurns.set(turnId, item.id))
          .catch((error) => {
            runningSchedules.delete(item.id);
            logger.write('ERROR', 'schedule.start.failed', { scheduleId: item.id, message: error instanceof Error ? error.message : String(error) });
          });
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
  ipcMain.handle('workspace:select', async () => {
    const selected = await selectWorkspace();
    if (!selected) return { cancelled: true };
    return { cancelled: false, workspace: await switchWorkspace(selected) };
  });
  ipcMain.handle('workspace:list', async () => ({
    current: workspace,
    recent: [workspace, ...recentWorkspaces].filter((item, index, list) => existsSync(item) && list.findIndex((value) => sameWorkspace(value, item)) === index),
  }));
  ipcMain.handle('workspace:switch', async (_event, nextWorkspace: string) => ({ workspace: await switchWorkspace(nextWorkspace) }));
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
  ipcMain.handle('git:status', async () => runScopedGitCommand('git status --short --branch'));
  ipcMain.handle('git:diff', async (_event, scope: 'unstaged' | 'staged' | 'branch' | 'last-turn' = 'unstaged') => runScopedGitCommand(scope === 'staged' ? 'git diff --cached' : 'git diff'));
  ipcMain.handle('git:branches', async () => runScopedGitCommand('git branch --format="%(refname:short)"'));
  ipcMain.handle('git:checkout', async (_event, branch: string) => { const name = textArg(branch, 'branch', 200); if (!/^[\w./-]+$/.test(name)) throw new Error('分支名称包含不允许的字符'); return runScopedGitCommand(`git switch ${psQuote(name)}`, 60_000); });
  ipcMain.handle('git:stage', async (_event, path?: string) => runScopedGitCommand(path ? `git add -- ${psQuote(relative(workspace, await new WorkspacePolicy(workspace).path(path)))}` : 'git add -A'));
  ipcMain.handle('git:unstage', async (_event, path?: string) => runScopedGitCommand(path ? `git restore --staged -- ${psQuote(relative(workspace, await new WorkspacePolicy(workspace).path(path)))}` : 'git restore --staged .'));
  ipcMain.handle('git:revert', async (_event, path: string) => runScopedGitCommand(`git restore -- ${psQuote(relative(workspace, await new WorkspacePolicy(workspace).path(textArg(path, 'path', 1000))))}`));
  ipcMain.handle('git:commit', async (_event, message: string) => runScopedGitCommand(`git commit -m ${psQuote(textArg(message, 'message', 2000))}`, 60_000));
  ipcMain.handle('git:push', async () => runScopedGitCommand('git push', 120_000));
  ipcMain.handle('git:prStatus', async () => { await scopedGitRoot(); return runWorkspaceCommand('gh pr status --json number,title,state,url', workspace, 30_000); });
  ipcMain.handle('terminal:run', async (_event, command: string, cwd?: string) => {
    const value = textArg(command, 'command', 20_000);
    if (isHighRiskCommand(value)) throw new Error('终端命令被 SeeCoder 安全策略拒绝：请使用受控 Git/依赖操作入口并确认风险。');
    return runWorkspaceCommand(value, cwd, 120_000);
  });
  ipcMain.handle('preview:open', async (_event, url: string) => { const target = textArg(url, 'url', 1000); if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(`${target}/`)) throw new Error('Preview 只允许 localhost 地址'); await shell.openExternal(target); return target; });
  ipcMain.handle('extension:list', async () => listExtensions());
  ipcMain.handle('schedule:list', async () => (await readSchedules()).filter((item) => sameWorkspace(item.projectPath, workspace)));
  ipcMain.handle('schedule:save', async (_event, input: ScheduleDefinition) => { if (!input || !sameWorkspace(input.projectPath, workspace)) throw new Error('计划任务必须属于当前工作区'); const list = await readSchedules(); const nextAt = input.enabled ? (input.nextRunAt ?? nextScheduleAt(input.cadence)) : undefined; const value: ScheduleDefinition = { ...input, ...(nextAt ? { nextRunAt: nextAt } : {}) }; const next = [...list.filter((item) => item.id !== input.id), value]; await saveSchedules(next); return next; });
  ipcMain.handle('schedule:toggle', async (_event, id: string, enabled: boolean) => { const list = await readSchedules(); const next = list.map((item) => item.id === id ? { ...item, enabled } : item); await saveSchedules(next); return next; });
  ipcMain.handle('schedule:run', async (_event, id: string) => { const item = (await readSchedules()).find((value) => value.id === id); if (!item) throw new Error('计划不存在'); if (!sameWorkspace(item.projectPath, workspace)) throw new Error('该计划属于其他工作区，请先切换工作区'); const thread = (await core.listThreads()).find((value) => sameWorkspace(value.workspacePath, item.projectPath)) ?? await core.createThread(`计划：${item.prompt.slice(0, 40)}`); return core.startTurn(thread.id, item.prompt, 'plan'); });
  ipcMain.handle('settings:read', async () => ({ workspace, mode: core.getMode(), model: modelConfig.model, baseUrl: modelConfig.baseUrl, contextWindow: modelConfig.contextWindow, maxOutputTokens: modelConfig.maxOutputTokens, hasApiKey: Boolean(process.env[modelConfig.apiKeyEnv]), keyStorage: apiKeySource, logPath: join(app.getPath('userData'), 'logs', 'main.log') }));
  ipcMain.handle('settings:update', async (_event, next: { mode?: ExecutionMode; model?: string; baseUrl?: string; contextWindow?: number; maxOutputTokens?: number; apiKey?: string; clearApiKey?: boolean }) => {
    const input = next && typeof next === 'object' ? next : {};
    let providerChanged = false;
    if (input.mode) { mode = input.mode; core.setMode(mode); }
    if (typeof input.model === 'string' && input.model.length <= 200 && input.model !== modelConfig.model) { modelConfig.model = input.model; providerChanged = true; }
    if (typeof input.baseUrl === 'string' && input.baseUrl.length <= 1000 && input.baseUrl !== modelConfig.baseUrl) { modelConfig.baseUrl = input.baseUrl; providerChanged = true; }
    if (typeof input.contextWindow === 'number') modelConfig.contextWindow = Math.max(8_000, Math.min(1_000_000, input.contextWindow));
    if (typeof input.maxOutputTokens === 'number') modelConfig.maxOutputTokens = Math.max(256, Math.min(64_000, input.maxOutputTokens));
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey : undefined;
    if (apiKey !== undefined) providerChanged = true;
    if (apiKey !== undefined || input.clearApiKey) await savePersistedSettings({ ...(apiKey !== undefined ? { apiKey } : {}), ...(input.clearApiKey ? { clearApiKey: true } : {}) });
    else await savePersistedSettings();
    if (providerChanged) core.reconfigureModel(new OpenAICompatibleProvider(modelConfig), modelConfig);
    logger.write('INFO', 'settings.updated', { model: modelConfig.model, baseUrl: modelConfig.baseUrl, mode, providerChanged, keyStorage: apiKeySource, hasApiKey: Boolean(process.env[modelConfig.apiKeyEnv]) });
    return { workspace, mode: core.getMode(), model: modelConfig.model, baseUrl: modelConfig.baseUrl, contextWindow: modelConfig.contextWindow, maxOutputTokens: modelConfig.maxOutputTokens, hasApiKey: Boolean(process.env[modelConfig.apiKeyEnv]), keyStorage: apiKeySource, logPath: join(app.getPath('userData'), 'logs', 'main.log') };
  });
}

async function createWindow(): Promise<void> {
  createCore();
  // preload 使用 ESM + 类型安全 IPC 桥；保持 Renderer 无 Node 权限和上下文隔离，
  // 但不对 preload 强制 Chromium sandbox，否则 Electron 38 会拒绝加载该 ESM 桥，
  // Renderer 会误退回 previewApi，造成“按钮可见但后端不执行”的假成功。
  mainWindow = new BrowserWindow({ width: 1480, height: 940, minWidth: 1050, minHeight: 680, backgroundColor: '#f6f6f7', title: 'SeeCoder', webPreferences: { preload: join(__dirname, '../preload/preload.mjs'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) await mainWindow.loadURL(rendererUrl); else await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  logger.init(app.getPath('userData'));
  await loadPersistedSettings();
  // 记录恢复后的真实工作区，避免启动日志误导排障或让人以为 Core 曾绑定源码目录。
  logger.write('INFO', 'app.ready', { version: app.getVersion(), platform: process.platform, workspace });
  registerIpc();
  registerMenu();
  await createWindow();
  startScheduleLoop();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
}).catch((error) => {
  logger.write('ERROR', 'app.start.failed', { message: error instanceof Error ? error.message : String(error) });
});
app.on('render-process-gone', (_event, _webContents, details) => logger.write('ERROR', 'renderer.gone', { reason: details.reason, exitCode: details.exitCode }));
app.on('window-all-closed', () => { logger.write('INFO', 'app.window-all-closed'); if (scheduleTimer) clearInterval(scheduleTimer); if (process.platform !== 'darwin') app.quit(); });
