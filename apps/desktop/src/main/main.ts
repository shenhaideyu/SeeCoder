import { app, BrowserWindow, dialog, ipcMain, Menu, Notification } from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AgentCore } from '@seecoder/agent-core';
import { OpenAICompatibleProvider, type ModelConfig } from '@seecoder/model';
import { SessionStore } from '@seecoder/storage';
import { ToolRegistry } from '@seecoder/tools';
import type { AgentEvent, ExecutionMode, ScheduleDefinition } from '@seecoder/protocol';
import { MainLogger } from './services/main-logger';
import { ScheduleService } from './services/schedule-service';
import { WorkspaceService, textArg } from './services/workspace-service';
import { SettingsService, type SettingsUpdate } from './services/settings-service';
import { ExtensionService } from './services/extension-service';
import { registerWorkspaceIpc } from './ipc/register-workspace-ipc';
import { registerExtensionIpc } from './ipc/register-extension-ipc';

// 未打包运行时 Electron 默认使用应用名“Electron”，会把会话和日志写入
// %APPDATA%\\Electron。显式固定产品名，确保 SeeCoder 的数据隔离和可审计路径稳定。
app.setName('SeeCoder');

let mainWindow: BrowserWindow | null = null;
let core: AgentCore;
let coreUnsubscribe: (() => void) | undefined;
let workspace = process.cwd();
let mode: ExecutionMode = 'guided';
const logger = new MainLogger();
const modelConfig: ModelConfig = {
  baseUrl: process.env.SEECODER_BASE_URL ?? 'https://api.openai.com/v1',
  model: process.env.SEECODER_MODEL ?? 'gpt-4o-mini',
  apiKeyEnv: 'SEECODER_API_KEY',
  contextWindow: 128000,
  temperature: 0.2,
  maxOutputTokens: 8192,
};
const storeRoot = () => join(app.getPath('userData'), 'sessions-data');
const sameWorkspace = (left: string, right: string): boolean => {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};
const toolRegistry = new ToolRegistry();
const workspaceService = new WorkspaceService({
  getWorkspace: () => workspace,
  logger,
  sameWorkspace,
});
const scheduleService = new ScheduleService({
  getCore: () => core,
  getWorkspace: () => workspace,
  sameWorkspace,
});
const settingsService = new SettingsService({
  modelConfig,
  logger,
  getCore: () => core,
  getWorkspace: () => workspace,
  setWorkspace: (value) => { workspace = value; },
  getMode: () => mode,
  setMode: (value) => { mode = value; },
  sameWorkspace,
});
const extensionService = new ExtensionService({
  getWorkspace: () => workspace,
  getWindow: () => mainWindow,
  settings: settingsService,
  logger,
});
const send = (event: AgentEvent): void => {
  mainWindow?.webContents.send('seecoder:event', event);
};

function createCore(): void {
  coreUnsubscribe?.();
  const store = new SessionStore(storeRoot());
  core = new AgentCore({
    workspace,
    mode,
    model: modelConfig,
    store,
    provider: new OpenAICompatibleProvider(modelConfig),
    registry: toolRegistry,
    hooks: extensionService.createHookRuntime(),
    onReplayDiagnostic: (sessionId, diagnostic) =>
      logger.write('WARN', 'session.replay.diagnostic', {
        sessionId,
        code: diagnostic.code,
        seq: diagnostic.seq,
        eventId: diagnostic.eventId,
      }),
  });
  coreUnsubscribe = core.onEvent((event) => {
    logger.event(event);
    send(event);
    if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled') {
      scheduleService.completeTurn(event.turn.id);
    }
    if (event.type === 'turn.completed' && mainWindow && !mainWindow.isFocused() && Notification.isSupported()) new Notification({ title: 'SeeCoder 任务完成', body: '任务已完成，请查看验证结果。' }).show();
  });
}

async function selectWorkspace(): Promise<string | null> {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    title: '选择 SeeCoder 工作区',
  });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

async function switchWorkspace(nextWorkspace: string): Promise<string> {
  const next = resolve(textArg(nextWorkspace, 'workspace', 2000));
  if (!existsSync(next)) throw new Error('工作区目录不存在');
  core.cancelAll();
  workspace = next;
  settingsService.rememberWorkspace(next);
  await settingsService.save();
  createCore();
  logger.write('INFO', 'workspace.changed', { workspace });
  return workspace;
}

function registerIpc(): void {
  registerWorkspaceIpc({ getWindow: () => mainWindow, getCore: () => core, getWorkspace: () => workspace, getMode: () => mode, setMode: (value) => { mode = value; }, getRecentWorkspaces: () => settingsService.recentWorkspaces(), selectWorkspace, switchWorkspace, sameWorkspace, storeRoot, logger, toolRegistry, workspaceService, loadSkill: (skillId) => extensionService.loadSkill(skillId) });
  registerExtensionIpc(extensionService);
  ipcMain.handle('schedule:list', async () => scheduleService.list());
  ipcMain.handle('schedule:save', async (_event, input: ScheduleDefinition) => scheduleService.save(input));
  ipcMain.handle('schedule:toggle', async (_event, id: string, enabled: boolean) => scheduleService.toggle(id, enabled));
  ipcMain.handle('schedule:run', async (_event, id: string) => scheduleService.run(id));
  ipcMain.handle('settings:read', async () => settingsService.snapshot());
  ipcMain.handle('settings:update', async (_event, next: SettingsUpdate) => settingsService.update(next));
}

async function createWindow(): Promise<void> {
  createCore();
  // preload 使用 ESM + 类型安全 IPC 桥；保持 Renderer 无 Node 权限和上下文隔离，
  // 但不对 preload 强制 Chromium sandbox，否则 Electron 38 会拒绝加载该 ESM 桥，
  // Renderer 会误退回 previewApi，造成“按钮可见但后端不执行”的假成功。
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1050,
    minHeight: 680,
    backgroundColor: '#f6f6f7',
    title: 'SeeCoder',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && input.key.toLowerCase() === 'n') {
      event.preventDefault();
      mainWindow?.webContents.send('seecoder:menu', 'new-session');
    }
  });
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) await mainWindow.loadURL(rendererUrl);
  else await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

app
  .whenReady()
  .then(async () => {
    logger.init(app.getPath('userData'));
    await settingsService.load();
    // 记录恢复后的真实工作区，避免启动日志误导排障或让人以为 Core 曾绑定源码目录。
    logger.write('INFO', 'app.ready', {
      version: app.getVersion(),
      platform: process.platform,
      workspace,
    });
    registerIpc();
    Menu.setApplicationMenu(null);
    await createWindow();
    scheduleService.start();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  })
  .catch((error) => {
    logger.write('ERROR', 'app.start.failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  });
app.on('render-process-gone', (_event, _webContents, details) => logger.write('ERROR', 'renderer.gone', { reason: details.reason, exitCode: details.exitCode }));
app.on('window-all-closed', () => {
  logger.write('INFO', 'app.window-all-closed');
  scheduleService.stop();
  if (process.platform !== 'darwin') app.quit();
});
