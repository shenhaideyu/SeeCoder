import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import { AgentCore } from '@seecoder/agent-core';
import { OpenAICompatibleProvider, type ModelConfig } from '@seecoder/model';
import { SessionStore } from '@seecoder/storage';
import type { PermissionMode } from '@seecoder/protocol';

let mainWindow: BrowserWindow | null = null;
let core: AgentCore;
let workspace = process.cwd();
let mode: PermissionMode = 'guided';
const modelConfig: ModelConfig = {
  baseUrl: process.env.SEECODER_BASE_URL ?? 'https://api.openai.com/v1',
  model: process.env.SEECODER_MODEL ?? 'gpt-4o-mini',
  apiKeyEnv: 'SEECODER_API_KEY',
  contextWindow: 128000,
  temperature: 0.2,
  maxOutputTokens: 8192,
};

function createCore(): void {
  const store = new SessionStore(join(app.getPath('userData'), 'sessions-data'));
  core = new AgentCore({ workspace, mode, model: modelConfig, store, provider: new OpenAICompatibleProvider(modelConfig) });
  core.onEvent((event) => mainWindow?.webContents.send('seecoder:event', event));
}

async function selectWorkspace(): Promise<string | null> {
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'], title: '选择 SeeCoder 工作区' });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

function registerIpc(): void {
  const textArg = (value: unknown, name: string, max = 100_000): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${name} 参数无效`);
    return value;
  };
  ipcMain.handle('workspace:select', async () => {
    const selected = await selectWorkspace();
    if (!selected) return { cancelled: true };
    workspace = selected;
    createCore();
    return { cancelled: false, workspace };
  });
  ipcMain.handle('thread:create', async (_event, title?: string) => core.createThread(typeof title === 'string' && title.length <= 120 ? title : undefined));
  ipcMain.handle('thread:list', async () => core.listThreads());
  ipcMain.handle('thread:hydrate', async (_event, threadId: string) => core.hydrateThread(textArg(threadId, 'threadId', 100)));
  ipcMain.handle('thread:history', async (_event, threadId: string) => core.readThreadEvents(textArg(threadId, 'threadId', 100)));
  ipcMain.handle('turn:start', async (_event, threadId: string, text: string) => core.startTurn(textArg(threadId, 'threadId', 100), textArg(text, 'text')));
  ipcMain.handle('turn:cancel', async (_event, turnId: string) => core.cancelTurn(textArg(turnId, 'turnId', 100)));
  ipcMain.handle('approval:resolve', async (_event, approvalId: string, decision: 'allow' | 'deny', reason?: string) => core.resolveApproval(textArg(approvalId, 'approvalId', 100), decision === 'allow' ? 'allow' : 'deny', typeof reason === 'string' ? reason.slice(0, 500) : undefined));
  ipcMain.handle('changes:revert', async (_event, changeSetId: string) => core.revertChangeSet(textArg(changeSetId, 'changeSetId', 100)));
  ipcMain.handle('settings:read', async () => ({ workspace, mode: core.getMode(), model: modelConfig.model, baseUrl: modelConfig.baseUrl, hasApiKey: Boolean(process.env[modelConfig.apiKeyEnv]) }));
  ipcMain.handle('settings:update', async (_event, next: { mode?: PermissionMode; model?: string; baseUrl?: string }) => { if (next.mode) { mode = next.mode; core.setMode(mode); } return { workspace, mode: core.getMode(), model: modelConfig.model, baseUrl: modelConfig.baseUrl, hasApiKey: Boolean(process.env[modelConfig.apiKeyEnv]) }; });
}

async function createWindow(): Promise<void> {
  createCore();
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1050,
    minHeight: 680,
    backgroundColor: '#0d0912',
    title: 'SeeCoder',
    webPreferences: { preload: join(__dirname, '../preload/preload.mjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) await mainWindow.loadURL(rendererUrl);
  else await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  registerIpc();
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
