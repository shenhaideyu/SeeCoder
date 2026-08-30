import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, safeStorage, shell } from 'electron';
import { existsSync } from 'node:fs';
import { appendFile, cp, lstat, readdir, readFile, writeFile, mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AgentCore } from '@seecoder/agent-core';
import { OpenAICompatibleProvider, type ModelConfig } from '@seecoder/model';
import { SessionStore } from '@seecoder/storage';
import { ToolRegistry, WorkspacePolicy, commandRunner, isHighRiskCommand, parseHookConfig, type HookConfig, type ToolContext } from '@seecoder/tools';
import type { AgentEvent, AttachmentRef, ExecutionMode, HookCommand, HookExecutionContext, HookStage, LocalSkill, ModelProfile, ModelProfileInput, ScheduleDefinition, Session, ToolResult } from '@seecoder/protocol';

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
    const base = { type: event.type, sessionId: event.sessionId, turnId };
    if (event.type === 'tool.requested') this.write('INFO', 'agent.tool.requested', { ...base, callId: event.call.id, tool: event.call.name });
    else if (event.type === 'tool.completed') {
      const controlled = event.result.error?.code === 'exploration_budget_exhausted';
      this.write(event.result.ok || controlled ? 'INFO' : 'WARN', 'agent.tool.completed', { ...base, callId: event.callId, ok: event.result.ok, controlled, durationMs: event.result.durationMs, error: event.result.error?.code });
    }
    else if (event.type === 'tool.output') this.write('INFO', 'agent.tool.output', { ...base, callId: event.callId, stream: event.stream, bytes: event.text.length });
    else if (event.type === 'model.completed') this.write('INFO', 'agent.model.completed', { ...base, iteration: event.iteration, durationMs: event.durationMs, inputTokens: event.inputTokens, outputTokens: event.outputTokens, retries: event.retries, finishReason: event.finishReason });
    else if (event.type === 'context.summary.requested') this.write('INFO', 'agent.context.summary.requested', base);
    else if (event.type === 'context.summary.completed') this.write('INFO', 'agent.context.summary.completed', { ...base, durationMs: event.durationMs, inputTokens: event.inputTokens, outputTokens: event.outputTokens });
    else if (event.type === 'context.summary.failed') this.write(event.code === 'cancelled' ? 'INFO' : 'WARN', 'agent.context.summary.failed', { ...base, code: event.code });
    else if (event.type === 'context.retrieved') this.write('INFO', 'agent.context.retrieved', { ...base, count: event.count, kinds: event.kinds });
    else if (event.type === 'context.compacted') this.write('INFO', 'agent.context.compacted', { ...base, ...event.metrics });
    else if (event.type === 'subagent.updated') this.write(event.child.status === 'failed' ? 'WARN' : 'INFO', 'agent.subagent.updated', { ...base, childId: event.child.id, role: event.child.role, status: event.child.status, iteration: event.child.iteration, durationMs: event.child.durationMs, inputTokens: event.child.inputTokens, outputTokens: event.child.outputTokens, currentAction: event.child.currentAction, error: event.child.errorCode });
    else if (event.type === 'skill.activated') this.write('INFO', 'agent.skill.activated', { ...base, skillId: event.skill.id, skillName: event.skill.name });
    else if (event.type === 'hook.started') this.write('INFO', 'agent.hook.started', { ...base, stage: event.stage, hookId: event.hookId });
    else if (event.type === 'hook.completed') this.write(event.ok ? 'INFO' : 'WARN', 'agent.hook.completed', { ...base, stage: event.stage, hookId: event.hookId, ok: event.ok, durationMs: event.durationMs, error: event.errorCode });
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
  core = new AgentCore({
    workspace, mode, model: modelConfig, store, provider: new OpenAICompatibleProvider(modelConfig), registry: toolRegistry,
    hooks: createHookRuntime(),
    onReplayDiagnostic: (sessionId, diagnostic) => logger.write('WARN', 'session.replay.diagnostic', { sessionId, code: diagnostic.code, seq: diagnostic.seq, eventId: diagnostic.eventId }),
  });
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

interface StoredModelProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  enabled: boolean;
  apiKeyEncrypted?: string;
}

interface PersistedSettings {
  workspace?: string;
  recentWorkspaces?: string[];
  mode?: ExecutionMode;
  model?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** 旧版单模型密文，仅用于迁移。 */
  apiKeyEncrypted?: string;
  /** workspace 规范路径 -> 已确认 hooks.json 的 SHA-256。 */
  trustedHookHashes?: Record<string, string>;
  activeModelProfileId?: string;
  modelProfiles?: StoredModelProfile[];
}

const environmentApiKey = process.env.SEECODER_API_KEY;
let apiKeySource: 'environment' | 'os' | 'none' = 'none';
let trustedHookHashes: Record<string, string> = {};
let modelProfiles: StoredModelProfile[] = [];
let activeModelProfileId = '';
const hookTrustKey = (): string => process.platform === 'win32' ? resolve(workspace).toLowerCase() : resolve(workspace);
const inferProvider = (baseUrl: string): string => baseUrl.includes('deepseek') ? 'DeepSeek' : baseUrl.includes('openai.com') ? 'OpenAI' : 'OpenAI 兼容';

function apiKeyHint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length > 4 ? `••••••••${value.slice(-4)}` : '••••••••';
}

function encryptApiKey(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储暂不可用，请稍后重试或设置 SEECODER_API_KEY 环境变量');
  return safeStorage.encryptString(value).toString('base64');
}

function decryptApiKey(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取已保存的 API Key');
  return safeStorage.decryptString(Buffer.from(value, 'base64'));
}

function profileKey(profile: StoredModelProfile): string | undefined {
  if (profile.apiKeyEncrypted) {
    try { return decryptApiKey(profile.apiKeyEncrypted); } catch { return undefined; }
  }
  return environmentApiKey;
}

function activeProfile(): StoredModelProfile {
  const selected = modelProfiles.find((profile) => profile.id === activeModelProfileId && profile.enabled)
    ?? modelProfiles.find((profile) => profile.enabled)
    ?? modelProfiles[0];
  if (!selected) throw new Error('至少需要一个模型配置');
  activeModelProfileId = selected.id;
  return selected;
}

function applyActiveProfile(): void {
  const profile = activeProfile();
  modelConfig.model = profile.model;
  modelConfig.baseUrl = profile.baseUrl;
  const key = profileKey(profile);
  if (key) process.env[modelConfig.apiKeyEnv] = key;
  else delete process.env[modelConfig.apiKeyEnv];
  apiKeySource = profile.apiKeyEncrypted ? 'os' : key ? 'environment' : 'none';
}

function profileView(profile: StoredModelProfile): ModelProfile {
  const key = profileKey(profile);
  const hint = apiKeyHint(key);
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.baseUrl,
    enabled: profile.enabled,
    hasApiKey: Boolean(key),
    keyStorage: profile.apiKeyEncrypted ? 'os' : key ? 'environment' : 'none',
    ...(hint ? { apiKeyHint: hint } : {}),
  };
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
    trustedHookHashes = value.trustedHookHashes && typeof value.trustedHookHashes === 'object' ? value.trustedHookHashes : {};
    modelProfiles = Array.isArray(value.modelProfiles)
      ? value.modelProfiles.filter((profile): profile is StoredModelProfile => Boolean(profile && typeof profile.id === 'string' && typeof profile.name === 'string' && typeof profile.provider === 'string' && typeof profile.model === 'string' && typeof profile.baseUrl === 'string'))
        .map((profile) => ({ ...profile, enabled: profile.enabled !== false }))
      : [];
    if (!modelProfiles.length) modelProfiles = [{ id: randomUUID(), name: modelConfig.model, provider: inferProvider(modelConfig.baseUrl), model: modelConfig.model, baseUrl: modelConfig.baseUrl, enabled: true, ...(typeof value.apiKeyEncrypted === 'string' ? { apiKeyEncrypted: value.apiKeyEncrypted } : {}) }];
    activeModelProfileId = typeof value.activeModelProfileId === 'string' ? value.activeModelProfileId : modelProfiles[0]!.id;
    applyActiveProfile();
    logger.write('INFO', 'settings.loaded', { model: modelConfig.model, baseUrl: modelConfig.baseUrl });
  } catch {
    // 首次启动没有配置文件是正常情况。
    modelProfiles = [{ id: randomUUID(), name: modelConfig.model, provider: inferProvider(modelConfig.baseUrl), model: modelConfig.model, baseUrl: modelConfig.baseUrl, enabled: true }];
    activeModelProfileId = modelProfiles[0]!.id;
    applyActiveProfile();
  }
}

async function savePersistedSettings(): Promise<void> {
  const target = settingsPath();
  const temporary = `${target}.tmp`;
  await mkdir(join(app.getPath('userData'), 'config'), { recursive: true });
  const selected = activeProfile();
  const payload: PersistedSettings = { workspace, recentWorkspaces, mode, model: selected.model, baseUrl: selected.baseUrl, contextWindow: modelConfig.contextWindow, maxOutputTokens: modelConfig.maxOutputTokens, trustedHookHashes, activeModelProfileId, modelProfiles, ...(selected.apiKeyEncrypted ? { apiKeyEncrypted: selected.apiKeyEncrypted } : {}) };
  await writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8');
  await rename(temporary, target);
}

function settingsSnapshot() {
  const selected = activeProfile();
  const profiles = modelProfiles.map(profileView);
  const selectedView = profiles.find((profile) => profile.id === selected.id)!;
  return { workspace, mode: core.getMode(), model: selected.model, recentModels: profiles.filter((profile) => profile.enabled).map((profile) => profile.model), baseUrl: selected.baseUrl, contextWindow: modelConfig.contextWindow, maxOutputTokens: modelConfig.maxOutputTokens, hasApiKey: selectedView.hasApiKey, keyStorage: selectedView.keyStorage, ...(selectedView.apiKeyHint ? { apiKeyHint: selectedView.apiKeyHint } : {}), activeModelProfileId, modelProfiles: profiles, logPath: join(app.getPath('userData'), 'logs', 'main.log') };
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
        const session = (await core.listSessions()).find((value) => value.workspacePath === item.projectPath) ?? await core.createSession(`计划：${item.prompt.slice(0, 40)}`);
        void core.startTurn(session.id, item.prompt, 'plan')
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

type ExtensionRecord = LocalSkill & { path: string; kind: 'skill' | 'hook'; content?: string; hookStatus?: 'trusted' | 'untrusted' | 'invalid'; hookError?: string };
type ManagedSkillManifest = { version: 1; displayName: string; sourcePath: string; importedAt: string };
const managedSkillsRoot = (): string => join(app.getPath('userData'), 'skills');
const managedManifestName = '.seecoder-skill.json';

type HookState = { path: string; hash: string; config?: HookConfig; status: 'trusted' | 'untrusted' | 'invalid'; error?: string };

async function readHookState(): Promise<HookState | null> {
  const path = join(workspace, '.seecoder', 'hooks.json');
  if (!existsSync(path)) return null;
  const content = await readFile(path, 'utf8');
  const hash = createHash('sha256').update(content).digest('hex');
  try {
    const config = parseHookConfig(JSON.parse(content));
    return { path, hash, config, status: trustedHookHashes[hookTrustKey()] === hash ? 'trusted' : 'untrusted' };
  } catch (error) {
    return { path, hash, status: 'invalid', error: error instanceof Error ? error.message : 'Hook 配置无效' };
  }
}

function createHookRuntime() {
  return {
    async resolve(stage: HookStage): Promise<HookCommand[]> {
      const state = await readHookState();
      return state?.status === 'trusted' ? state.config?.hooks[stage] ?? [] : [];
    },
    async execute(command: HookCommand, context: HookExecutionContext, signal: AbortSignal): Promise<ToolResult> {
      if (isHighRiskCommand(command.command)) return { ok: false, durationMs: 0, error: { code: 'hook_command_denied', message: 'Hook 包含高风险命令，SeeCoder 已拒绝执行' } };
      const cwd = await new WorkspacePolicy(workspace).path('.');
      return commandRunner(command.command, cwd, {
        workspace,
        signal,
        env: {
          SEECODER_HOOK_STAGE: context.stage,
          SEECODER_SESSION_ID: context.sessionId,
          SEECODER_TURN_ID: context.turnId,
          SEECODER_TOOL_NAME: context.toolName ?? '',
          SEECODER_TOOL_CALL_ID: context.callId ?? '',
          SEECODER_CHANGED_PATHS: (context.changedPaths ?? []).join(';'),
          SEECODER_TURN_STATUS: context.turnStatus ?? '',
        },
      }, command.timeoutMs);
    },
  };
}

async function readManagedManifest(directory: string): Promise<ManagedSkillManifest | undefined> {
  try {
    const value = JSON.parse(await readFile(join(directory, managedManifestName), 'utf8')) as ManagedSkillManifest;
    return value.version === 1 && typeof value.displayName === 'string' && typeof value.sourcePath === 'string' ? value : undefined;
  } catch { return undefined; }
}

async function validateSkillSource(inputPath: string): Promise<{ directory: string; skillPath: string; displayName: string }> {
  const skillPath = await realpath(inputPath);
  if (basename(skillPath).toLowerCase() !== 'skill.md' || !(await stat(skillPath)).isFile()) throw new Error('请选择名为 SKILL.md 的文件');
  const directory = dirname(skillPath);
  let files = 0;
  let bytes = 0;
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = join(current, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error('Skill 目录包含符号链接，无法安全导入');
      if (info.isDirectory()) { await visit(target); continue; }
      files += 1;
      bytes += info.size;
      if (files > 200 || bytes > 5 * 1024 * 1024) throw new Error('Skill 目录超过 200 个文件或 5 MiB 限制');
      if (/^(\.env|credentials?|secrets?)$/i.test(entry.name) || /\.(pem|key|p12)$/i.test(entry.name)) throw new Error(`Skill 目录包含敏感文件：${entry.name}`);
    }
  };
  await visit(directory);
  const content = await readFile(skillPath, 'utf8');
  if (!content.trim() || content.length > 100_000) throw new Error('SKILL.md 为空或超过 100,000 字符');
  return { directory, skillPath, displayName: basename(directory) };
}

async function copyManagedSkill(source: { directory: string; displayName: string }, manifest?: ManagedSkillManifest): Promise<string> {
  const root = managedSkillsRoot();
  await mkdir(root, { recursive: true });
  const slug = source.displayName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'skill';
  const target = join(root, `${slug}-${randomUUID().slice(0, 8)}`);
  const temporary = `${target}.importing`;
  await cp(source.directory, temporary, { recursive: true, errorOnExist: true });
  await writeFile(join(temporary, managedManifestName), JSON.stringify(manifest ?? { version: 1, displayName: source.displayName, sourcePath: source.directory, importedAt: new Date().toISOString() }, null, 2), 'utf8');
  await rename(temporary, target);
  return target;
}

async function listExtensions(includeContent = false): Promise<ExtensionRecord[]> {
  const output: ExtensionRecord[] = [];
  const sources = [
    { source: 'managed', base: managedSkillsRoot(), scope: 'managed' as const },
    { source: 'seecoder', base: join(workspace, '.seecoder', 'skills'), scope: 'workspace' as const },
    { source: 'agents', base: join(workspace, '.agents', 'skills'), scope: 'workspace' as const },
  ];
  for (const { source, base, scope } of sources) {
    if (!existsSync(base)) continue;
    const trustedRoot = await realpath(base);
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(base, entry.name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;
      const canonical = await realpath(skillPath);
      const scoped = relative(trustedRoot, canonical);
      if (!scoped || scoped.startsWith('..') || isAbsolute(scoped)) continue;
      const content = (await readFile(canonical, 'utf8')).slice(0, 20_000);
      const description = content.match(/description:\s*(.+)/i)?.[1]?.trim() ?? '本地可复用工作流';
      const manifest = scope === 'managed' ? await readManagedManifest(join(base, entry.name)) : undefined;
      output.push({ id: `${source}:${entry.name}`, name: manifest?.displayName ?? entry.name, description, relativePath: scope === 'managed' ? `本机 Skill/${entry.name}/SKILL.md` : relative(workspace, canonical), path: canonical, kind: 'skill', scope, ...(manifest?.sourcePath ? { sourcePath: manifest.sourcePath } : {}), ...(includeContent ? { content } : {}) });
    }
  }
  const hook = await readHookState();
  if (hook) output.push({ id: 'seecoder:hooks', name: '项目 Hooks', description: hook.status === 'trusted' ? '已信任并启用生命周期钩子' : hook.status === 'invalid' ? '配置无效，未执行' : '等待信任，当前不会执行', relativePath: relative(workspace, hook.path), path: hook.path, kind: 'hook', hookStatus: hook.status, ...(hook.error ? { hookError: hook.error.slice(0, 500) } : {}) });
  return output;
}

async function loadSkill(skillId: string): Promise<{ skill: LocalSkill; content: string }> {
  const id = textArg(skillId, 'skillId', 200);
  const record = (await listExtensions(true)).find((item) => item.kind === 'skill' && item.id === id);
  if (!record?.content) throw new Error('Skill 不存在或已移出当前工作区');
  return { skill: { id: record.id, name: record.name, description: record.description, relativePath: record.relativePath, ...(record.scope ? { scope: record.scope } : {}), ...(record.sourcePath ? { sourcePath: record.sourcePath } : {}) }, content: record.content };
}

async function managedSkill(skillId: string): Promise<ExtensionRecord> {
  const id = textArg(skillId, 'skillId', 200);
  if (!id.startsWith('managed:')) throw new Error('项目 Skill 由工作区管理，不能从全局库修改');
  const record = (await listExtensions()).find((item) => item.kind === 'skill' && item.id === id);
  if (!record || record.scope !== 'managed') throw new Error('本机 Skill 不存在');
  const root = await realpath(managedSkillsRoot());
  const directory = await realpath(dirname(record.path));
  const scoped = relative(root, directory);
  if (!scoped || scoped.startsWith('..') || isAbsolute(scoped)) throw new Error('Skill 路径超出应用管理目录');
  return record;
}

async function importLocalSkill(): Promise<{ cancelled: boolean; skill?: ExtensionRecord }> {
  const selected = await dialog.showOpenDialog(mainWindow!, { title: '选择要导入的 SKILL.md', properties: ['openFile'], filters: [{ name: 'SeeCoder Skill', extensions: ['md'] }] });
  if (selected.canceled || !selected.filePaths[0]) return { cancelled: true };
  const source = await validateSkillSource(selected.filePaths[0]);
  const managedRoot = resolve(managedSkillsRoot());
  const sourceDirectory = resolve(source.directory);
  const scoped = relative(managedRoot, sourceDirectory);
  if (!scoped.startsWith('..') && !isAbsolute(scoped)) throw new Error('该 Skill 已位于 SeeCoder 管理目录中');
  const target = await copyManagedSkill(source);
  const imported = (await listExtensions()).find((item) => item.id === `managed:${basename(target)}`);
  logger.write('INFO', 'skill.imported', { skillId: imported?.id, sourcePath: source.directory });
  return { cancelled: false, ...(imported ? { skill: imported } : {}) };
}

async function refreshManagedSkill(skillId: string): Promise<void> {
  const record = await managedSkill(skillId);
  if (!record.sourcePath || !existsSync(record.sourcePath)) throw new Error('原始 Skill 路径不可用，请重新导入');
  const source = await validateSkillSource(join(record.sourcePath, 'SKILL.md'));
  const target = dirname(record.path);
  const manifest = await readManagedManifest(target);
  if (!manifest) throw new Error('Skill 导入信息损坏，请重新导入');
  const temporary = join(managedSkillsRoot(), `.refresh-${randomUUID()}`);
  const backup = `${target}.backup-${randomUUID()}`;
  await cp(source.directory, temporary, { recursive: true, errorOnExist: true });
  await writeFile(join(temporary, managedManifestName), JSON.stringify({ ...manifest, sourcePath: source.directory, importedAt: new Date().toISOString() }, null, 2), 'utf8');
  await rename(target, backup);
  try { await rename(temporary, target); } catch (error) { await rename(backup, target); throw error; }
  await rm(backup, { recursive: true, force: true });
  logger.write('INFO', 'skill.refreshed', { skillId: record.id });
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
  ipcMain.handle('session:create', async (_event, title?: string) => core.createSession(typeof title === 'string' && title.length <= 120 ? title : undefined));
  ipcMain.handle('session:list', async () => (await core.listSessions()).map((session) => ({ ...session, pinned: session.pinned ?? false, archived: session.archived ?? false, unread: session.unread ?? false })));
  ipcMain.handle('session:hydrate', async (_event, sessionId: string) => core.hydrateSession(textArg(sessionId, 'sessionId', 100)));
  ipcMain.handle('session:history', async (_event, sessionId: string) => core.readSessionEvents(textArg(sessionId, 'sessionId', 100)));
  ipcMain.handle('session:rename', async (_event, sessionId: string, title: string) => { const session = await core.hydrateSession(textArg(sessionId, 'sessionId', 100)); if (!session) throw new Error('session 不存在'); session.title = textArg(title, 'title', 120); session.updatedAt = new Date().toISOString(); await new SessionStore(storeRoot()).saveSession(session); return session; });
  ipcMain.handle('session:flag', async (_event, sessionId: string, flag: 'pinned' | 'archived') => { const session = await core.hydrateSession(textArg(sessionId, 'sessionId', 100)); if (!session) throw new Error('session 不存在'); session[flag] = !session[flag]; session.updatedAt = new Date().toISOString(); await new SessionStore(storeRoot()).saveSession(session); return session; });
  ipcMain.handle('session:delete', async (_event, sessionId: string) => { const id = textArg(sessionId, 'sessionId', 100); await core.deleteSession(id); logger.write('INFO', 'session.deleted', { sessionId: id }); return { deleted: true, sessionId: id }; });
  ipcMain.handle('session:fork', async (_event, sessionId: string) => { const source = await core.hydrateSession(textArg(sessionId, 'sessionId', 100)); if (!source) return null; const forked = await core.createSession(`${source.title}（Fork）`); const history = await new SessionStore(storeRoot()).readEvents(source.id); const forkStore = new SessionStore(storeRoot()); for (const record of history) await forkStore.append(forked.id, { event: { ...record.event, sessionId: forked.id }, ...(record.item ? { item: record.item } : {}) }); await core.hydrateSession(forked.id); return forked; });
  ipcMain.handle('session:search', async (_event, query: string) => { const q = textArg(query, 'query', 200).toLowerCase(); const all = await core.listSessions(); const store = new SessionStore(storeRoot()); const result: Session[] = []; for (const session of all) { if (session.title.toLowerCase().includes(q)) { result.push(session); continue; } const events = await store.readEvents(session.id); if (events.some((record) => JSON.stringify(record.event).toLowerCase().includes(q))) result.push(session); } return result; });
  ipcMain.handle('session:export', async (_event, sessionId: string, format: 'markdown' | 'json') => { const id = textArg(sessionId, 'sessionId', 100); const events = await core.readSessionEvents(id); const body = format === 'json' ? JSON.stringify(events, null, 2) : events.map((event) => `${event.type}\n${JSON.stringify(event, null, 2)}`).join('\n\n'); const target = await dialog.showSaveDialog(mainWindow!, { defaultPath: `seecoder-${id.slice(0, 8)}.${format === 'json' ? 'json' : 'md'}` }); if (target.canceled || !target.filePath) return { cancelled: true }; await writeFile(target.filePath, body, 'utf8'); return { cancelled: false, path: target.filePath }; });
  ipcMain.handle('turn:start', async (_event, sessionId: string, text: string, attachments?: AttachmentRef[], skillId?: string) => core.startTurn(textArg(sessionId, 'sessionId', 100), textArg(text, 'text'), undefined, Array.isArray(attachments) ? attachments.slice(0, 4) : [], typeof skillId === 'string' ? await loadSkill(skillId) : undefined));
  ipcMain.handle('turn:followUp', async (_event, turnId: string, text: string) => { core.queueFollowUp(textArg(turnId, 'turnId', 100), textArg(text, 'text')); });
  ipcMain.handle('turn:cancel', async (_event, turnId: string) => core.cancelTurn(textArg(turnId, 'turnId', 100)));
  ipcMain.handle('approval:resolve', async (_event, approvalId: string, decision: 'allow' | 'deny', reason?: string) => core.resolveApproval(textArg(approvalId, 'approvalId', 100), decision === 'allow' ? 'allow' : 'deny', typeof reason === 'string' ? reason.slice(0, 500) : undefined));
  ipcMain.handle('input:resolve', async (_event, requestId: string, answer: string) => core.resolveUserInput(textArg(requestId, 'requestId', 100), textArg(answer, 'answer', 10_000)));
  ipcMain.handle('plan:approve', async () => { mode = 'guided'; core.setMode(mode); return mode; });
  ipcMain.handle('changes:revert', async (_event, changeSetId: string) => core.revertChangeSet(textArg(changeSetId, 'changeSetId', 100)));
  ipcMain.handle('checkpoint:list', async (_event, sessionId?: string) => core.listCheckpoints(typeof sessionId === 'string' ? sessionId : undefined));
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
  ipcMain.handle('extension:list', async () => (await listExtensions()).map((item) => ({ id: item.id, name: item.name, description: item.description, relativePath: item.relativePath, path: item.path, kind: item.kind, scope: item.scope, sourcePath: item.sourcePath, hookStatus: item.hookStatus, hookError: item.hookError })));
  ipcMain.handle('extension:import', async () => importLocalSkill());
  ipcMain.handle('extension:refresh', async (_event, skillId: string) => { await refreshManagedSkill(skillId); return listExtensions(); });
  ipcMain.handle('extension:rename', async (_event, skillId: string, name: string) => {
    const record = await managedSkill(skillId);
    const manifest = await readManagedManifest(dirname(record.path));
    if (!manifest) throw new Error('Skill 导入信息损坏，请重新导入');
    await writeFile(join(dirname(record.path), managedManifestName), JSON.stringify({ ...manifest, displayName: textArg(name, 'name', 80) }, null, 2), 'utf8');
    return listExtensions();
  });
  ipcMain.handle('extension:delete', async (_event, skillId: string) => {
    const record = await managedSkill(skillId);
    await rm(dirname(record.path), { recursive: true, force: true });
    logger.write('INFO', 'skill.deleted', { skillId: record.id });
    return listExtensions();
  });
  ipcMain.handle('extension:openSource', async (_event, skillId: string) => {
    const record = await managedSkill(skillId);
    const target = record.sourcePath && existsSync(record.sourcePath) ? record.sourcePath : record.path;
    shell.showItemInFolder(target);
    return target;
  });
  ipcMain.handle('extension:trustHooks', async (_event, enabled: boolean) => {
    const state = await readHookState();
    if (!state) throw new Error('当前工作区没有 .seecoder/hooks.json');
    if (enabled) {
      if (state.status === 'invalid' || !state.config) throw new Error(state.error ?? 'Hook 配置无效');
      trustedHookHashes[hookTrustKey()] = state.hash;
      logger.write('INFO', 'hooks.trusted', { workspace, hash: state.hash.slice(0, 12) });
    } else {
      delete trustedHookHashes[hookTrustKey()];
      logger.write('INFO', 'hooks.disabled', { workspace });
    }
    await savePersistedSettings();
    return listExtensions();
  });
  const visibleSchedules = (list: ScheduleDefinition[]): ScheduleDefinition[] => list.filter((item) => sameWorkspace(item.projectPath, workspace));
  ipcMain.handle('schedule:list', async () => visibleSchedules(await readSchedules()));
  ipcMain.handle('schedule:save', async (_event, input: ScheduleDefinition) => {
    if (!input || !sameWorkspace(input.projectPath, workspace)) throw new Error('计划任务必须属于当前工作区');
    const list = await readSchedules();
    const nextAt = input.enabled ? (input.nextRunAt ?? nextScheduleAt(input.cadence)) : undefined;
    const value: ScheduleDefinition = { ...input, ...(nextAt ? { nextRunAt: nextAt } : {}) };
    const next = [...list.filter((item) => item.id !== input.id), value];
    await saveSchedules(next);
    return visibleSchedules(next);
  });
  ipcMain.handle('schedule:toggle', async (_event, id: string, enabled: boolean) => {
    const list = await readSchedules();
    const target = list.find((item) => item.id === id);
    if (!target) throw new Error('计划不存在');
    if (!sameWorkspace(target.projectPath, workspace)) throw new Error('该计划属于其他工作区，请先切换工作区');
    const next = list.map((item) => item.id === id ? { ...item, enabled } : item);
    await saveSchedules(next);
    return visibleSchedules(next);
  });
  ipcMain.handle('schedule:run', async (_event, id: string) => { const item = (await readSchedules()).find((value) => value.id === id); if (!item) throw new Error('计划不存在'); if (!sameWorkspace(item.projectPath, workspace)) throw new Error('该计划属于其他工作区，请先切换工作区'); const session = (await core.listSessions()).find((value) => sameWorkspace(value.workspacePath, item.projectPath)) ?? await core.createSession(`计划：${item.prompt.slice(0, 40)}`); return core.startTurn(session.id, item.prompt, 'plan'); });
  ipcMain.handle('settings:read', async () => settingsSnapshot());
  ipcMain.handle('settings:update', async (_event, next: { mode?: ExecutionMode; model?: string; activeModelProfileId?: string; upsertModel?: ModelProfileInput; toggleModel?: { id: string; enabled: boolean }; deleteModelId?: string; contextWindow?: number; maxOutputTokens?: number }) => {
    const input = next && typeof next === 'object' ? next : {};
    let providerChanged = false;
    if (input.mode) { mode = input.mode; core.setMode(mode); }
    if (input.upsertModel) {
      const value = input.upsertModel;
      const name = value.name?.trim();
      const provider = value.provider?.trim();
      const model = value.model?.trim();
      const baseUrl = value.baseUrl?.trim().replace(/\/$/, '');
      if (!name || name.length > 100) throw new Error('模型名称不能为空且不能超过 100 个字符');
      if (!provider || provider.length > 100) throw new Error('服务商不能为空且不能超过 100 个字符');
      if (!model || model.length > 200) throw new Error('模型标识不能为空且不能超过 200 个字符');
      if (!baseUrl || baseUrl.length > 1000) throw new Error('Base URL 不能为空且不能超过 1000 个字符');
      const parsedUrl = new URL(baseUrl);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new Error('Base URL 必须使用 http 或 https');
      const existingIndex = value.id ? modelProfiles.findIndex((profile) => profile.id === value.id) : -1;
      if (value.id && existingIndex < 0) throw new Error('模型配置不存在');
      const existing = existingIndex >= 0 ? modelProfiles[existingIndex] : undefined;
      let apiKeyEncrypted = existing?.apiKeyEncrypted;
      if (value.clearApiKey) apiKeyEncrypted = undefined;
      if (typeof value.apiKey === 'string' && value.apiKey.trim()) apiKeyEncrypted = encryptApiKey(value.apiKey.trim());
      const profile: StoredModelProfile = { id: existing?.id ?? randomUUID(), name, provider, model, baseUrl, enabled: value.enabled ?? existing?.enabled ?? true, ...(apiKeyEncrypted ? { apiKeyEncrypted } : {}) };
      if (existingIndex >= 0) modelProfiles[existingIndex] = profile;
      else modelProfiles.push(profile);
      if (profile.id === activeModelProfileId) providerChanged = true;
    }
    if (input.toggleModel) {
      const target = modelProfiles.find((profile) => profile.id === input.toggleModel!.id);
      if (!target) throw new Error('模型配置不存在');
      if (!input.toggleModel.enabled && target.id === activeModelProfileId) {
        const replacement = modelProfiles.find((profile) => profile.id !== target.id && profile.enabled);
        if (!replacement) throw new Error('当前模型不能停用：请先启用并选择其他模型');
        activeModelProfileId = replacement.id;
        providerChanged = true;
      }
      target.enabled = input.toggleModel.enabled;
    }
    if (input.deleteModelId) {
      if (modelProfiles.length <= 1) throw new Error('至少需要保留一个模型配置');
      const target = modelProfiles.find((profile) => profile.id === input.deleteModelId);
      if (!target) throw new Error('模型配置不存在');
      modelProfiles = modelProfiles.filter((profile) => profile.id !== target.id);
      if (target.id === activeModelProfileId) {
        const replacement = modelProfiles.find((profile) => profile.enabled) ?? modelProfiles[0]!;
        replacement.enabled = true;
        activeModelProfileId = replacement.id;
        providerChanged = true;
      }
    }
    if (typeof input.activeModelProfileId === 'string') {
      const target = modelProfiles.find((profile) => profile.id === input.activeModelProfileId && profile.enabled);
      if (!target) throw new Error('只能选择已启用的模型配置');
      if (target.id !== activeModelProfileId) { activeModelProfileId = target.id; providerChanged = true; }
    } else if (typeof input.model === 'string') {
      const selectedModel = input.model.trim();
      const target = modelProfiles.find((profile) => profile.model === selectedModel && profile.enabled);
      if (!target) throw new Error('模型配置不存在或未启用');
      if (target.id !== activeModelProfileId) { activeModelProfileId = target.id; providerChanged = true; }
    }
    if (typeof input.contextWindow === 'number') modelConfig.contextWindow = Math.max(8_000, Math.min(1_000_000, input.contextWindow));
    if (typeof input.maxOutputTokens === 'number') modelConfig.maxOutputTokens = Math.max(256, Math.min(64_000, input.maxOutputTokens));
    if (providerChanged) applyActiveProfile();
    await savePersistedSettings();
    if (providerChanged) core.reconfigureModel(new OpenAICompatibleProvider(modelConfig), modelConfig);
    logger.write('INFO', 'settings.updated', { model: modelConfig.model, baseUrl: modelConfig.baseUrl, mode, providerChanged, keyStorage: apiKeySource, hasApiKey: Boolean(process.env[modelConfig.apiKeyEnv]) });
    return settingsSnapshot();
  });
}

async function createWindow(): Promise<void> {
  createCore();
  // preload 使用 ESM + 类型安全 IPC 桥；保持 Renderer 无 Node 权限和上下文隔离，
  // 但不对 preload 强制 Chromium sandbox，否则 Electron 38 会拒绝加载该 ESM 桥，
  // Renderer 会误退回 previewApi，造成“按钮可见但后端不执行”的假成功。
  mainWindow = new BrowserWindow({ width: 1480, height: 940, minWidth: 1050, minHeight: 680, backgroundColor: '#f6f6f7', title: 'SeeCoder', webPreferences: { preload: join(__dirname, '../preload/preload.mjs'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && input.key.toLowerCase() === 'n') {
      event.preventDefault();
      mainWindow?.webContents.send('seecoder:menu', 'new-session');
    }
  });
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) await mainWindow.loadURL(rendererUrl); else await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  logger.init(app.getPath('userData'));
  await loadPersistedSettings();
  // 记录恢复后的真实工作区，避免启动日志误导排障或让人以为 Core 曾绑定源码目录。
  logger.write('INFO', 'app.ready', { version: app.getVersion(), platform: process.platform, workspace });
  registerIpc();
  Menu.setApplicationMenu(null);
  await createWindow();
  startScheduleLoop();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
}).catch((error) => {
  logger.write('ERROR', 'app.start.failed', { message: error instanceof Error ? error.message : String(error) });
});
app.on('render-process-gone', (_event, _webContents, details) => logger.write('ERROR', 'renderer.gone', { reason: details.reason, exitCode: details.exitCode }));
app.on('window-all-closed', () => { logger.write('INFO', 'app.window-all-closed'); if (scheduleTimer) clearInterval(scheduleTimer); if (process.platform !== 'darwin') app.quit(); });
