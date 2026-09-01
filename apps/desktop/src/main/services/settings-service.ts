import { app, safeStorage } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentCore } from '@seecoder/agent-core';
import { OpenAICompatibleProvider, type ModelConfig } from '@seecoder/model';
import type { ExecutionMode, ModelProfile, ModelProfileInput } from '@seecoder/protocol';
import type { MainLogger } from './main-logger';

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
  apiKeyEncrypted?: string;
  trustedHookHashes?: Record<string, string>;
  activeModelProfileId?: string;
  modelProfiles?: StoredModelProfile[];
}

export interface SettingsUpdate {
  mode?: ExecutionMode;
  model?: string;
  activeModelProfileId?: string;
  upsertModel?: ModelProfileInput;
  toggleModel?: { id: string; enabled: boolean };
  deleteModelId?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

interface SettingsServiceOptions {
  modelConfig: ModelConfig;
  logger: MainLogger;
  getCore: () => AgentCore;
  getWorkspace: () => string;
  setWorkspace: (workspace: string) => void;
  getMode: () => ExecutionMode;
  setMode: (mode: ExecutionMode) => void;
  sameWorkspace: (left: string, right: string) => boolean;
}

export class SettingsService {
  private readonly environmentApiKey = process.env.SEECODER_API_KEY;
  private apiKeySource: 'environment' | 'os' | 'none' = 'none';
  private trustedHookHashes: Record<string, string> = {};
  private modelProfiles: StoredModelProfile[] = [];
  private activeModelProfileId = '';
  private recent: string[] = [];

  constructor(private readonly options: SettingsServiceOptions) {}

  recentWorkspaces(): string[] { return this.recent; }

  rememberWorkspace(workspace: string): void {
    this.recent = [workspace, ...this.recent.filter((item) => !this.options.sameWorkspace(item, workspace))].slice(0, 8);
  }

  isHookTrusted(hash: string): boolean {
    return this.trustedHookHashes[this.hookTrustKey()] === hash;
  }

  async setHookTrusted(hash: string | undefined): Promise<void> {
    if (hash) this.trustedHookHashes[this.hookTrustKey()] = hash;
    else delete this.trustedHookHashes[this.hookTrustKey()];
    await this.save();
  }

  private settingsPath(): string { return join(app.getPath('userData'), 'config', 'settings.json'); }
  private hookTrustKey(): string {
    const workspace = resolve(this.options.getWorkspace());
    return process.platform === 'win32' ? workspace.toLowerCase() : workspace;
  }
  private inferProvider(baseUrl: string): string {
    return baseUrl.includes('deepseek') ? 'DeepSeek' : baseUrl.includes('openai.com') ? 'OpenAI' : 'OpenAI 兼容';
  }
  private apiKeyHint(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return value.length > 4 ? `••••••••${value.slice(-4)}` : '••••••••';
  }
  private encryptApiKey(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储暂不可用，请稍后重试或设置 SEECODER_API_KEY 环境变量');
    return safeStorage.encryptString(value).toString('base64');
  }
  private decryptApiKey(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取已保存的 API Key');
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  }
  private profileKey(profile: StoredModelProfile): string | undefined {
    if (profile.apiKeyEncrypted) {
      try { return this.decryptApiKey(profile.apiKeyEncrypted); } catch { return undefined; }
    }
    return this.environmentApiKey;
  }
  private activeProfile(): StoredModelProfile {
    const selected = this.modelProfiles.find((profile) => profile.id === this.activeModelProfileId && profile.enabled)
      ?? this.modelProfiles.find((profile) => profile.enabled)
      ?? this.modelProfiles[0];
    if (!selected) throw new Error('至少需要一个模型配置');
    this.activeModelProfileId = selected.id;
    return selected;
  }
  private applyActiveProfile(): void {
    const profile = this.activeProfile();
    this.options.modelConfig.model = profile.model;
    this.options.modelConfig.baseUrl = profile.baseUrl;
    const key = this.profileKey(profile);
    if (key) process.env[this.options.modelConfig.apiKeyEnv] = key;
    else delete process.env[this.options.modelConfig.apiKeyEnv];
    this.apiKeySource = profile.apiKeyEncrypted ? 'os' : key ? 'environment' : 'none';
  }
  private profileView(profile: StoredModelProfile): ModelProfile {
    const key = this.profileKey(profile);
    const hint = this.apiKeyHint(key);
    return { id: profile.id, name: profile.name, provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl, enabled: profile.enabled, hasApiKey: Boolean(key), keyStorage: profile.apiKeyEncrypted ? 'os' : key ? 'environment' : 'none', ...(hint ? { apiKeyHint: hint } : {}) };
  }

  async load(): Promise<void> {
    const config = this.options.modelConfig;
    try {
      const value = JSON.parse(await readFile(this.settingsPath(), 'utf8')) as PersistedSettings;
      if (typeof value.workspace === 'string' && existsSync(value.workspace)) this.options.setWorkspace(value.workspace);
      if (value.mode === 'plan' || value.mode === 'guided' || value.mode === 'auto') this.options.setMode(value.mode);
      const workspace = this.options.getWorkspace();
      this.recent = [workspace, ...(Array.isArray(value.recentWorkspaces) ? value.recentWorkspaces : [])]
        .filter((item, index, list) => typeof item === 'string' && existsSync(item) && list.findIndex((candidate) => this.options.sameWorkspace(candidate, item)) === index)
        .slice(0, 8);
      if (typeof value.model === 'string' && value.model.length <= 200) config.model = value.model;
      if (typeof value.baseUrl === 'string' && value.baseUrl.length <= 1000) config.baseUrl = value.baseUrl;
      if (typeof value.contextWindow === 'number') config.contextWindow = Math.max(8_000, Math.min(1_000_000, value.contextWindow));
      if (typeof value.maxOutputTokens === 'number') config.maxOutputTokens = Math.max(256, Math.min(64_000, value.maxOutputTokens));
      this.trustedHookHashes = value.trustedHookHashes && typeof value.trustedHookHashes === 'object' ? value.trustedHookHashes : {};
      this.modelProfiles = Array.isArray(value.modelProfiles)
        ? value.modelProfiles.filter((profile): profile is StoredModelProfile => Boolean(profile && typeof profile.id === 'string' && typeof profile.name === 'string' && typeof profile.provider === 'string' && typeof profile.model === 'string' && typeof profile.baseUrl === 'string')).map((profile) => ({ ...profile, enabled: profile.enabled !== false }))
        : [];
      if (!this.modelProfiles.length) this.modelProfiles = [{ id: randomUUID(), name: config.model, provider: this.inferProvider(config.baseUrl), model: config.model, baseUrl: config.baseUrl, enabled: true, ...(typeof value.apiKeyEncrypted === 'string' ? { apiKeyEncrypted: value.apiKeyEncrypted } : {}) }];
      this.activeModelProfileId = typeof value.activeModelProfileId === 'string' ? value.activeModelProfileId : this.modelProfiles[0]!.id;
      this.applyActiveProfile();
      this.options.logger.write('INFO', 'settings.loaded', { model: config.model, baseUrl: config.baseUrl });
    } catch {
      this.modelProfiles = [{ id: randomUUID(), name: config.model, provider: this.inferProvider(config.baseUrl), model: config.model, baseUrl: config.baseUrl, enabled: true }];
      this.activeModelProfileId = this.modelProfiles[0]!.id;
      this.applyActiveProfile();
    }
  }

  async save(): Promise<void> {
    const target = this.settingsPath();
    const temporary = `${target}.tmp`;
    await mkdir(join(app.getPath('userData'), 'config'), { recursive: true });
    const selected = this.activeProfile();
    const payload: PersistedSettings = { workspace: this.options.getWorkspace(), recentWorkspaces: this.recent, mode: this.options.getMode(), model: selected.model, baseUrl: selected.baseUrl, contextWindow: this.options.modelConfig.contextWindow, maxOutputTokens: this.options.modelConfig.maxOutputTokens, trustedHookHashes: this.trustedHookHashes, activeModelProfileId: this.activeModelProfileId, modelProfiles: this.modelProfiles, ...(selected.apiKeyEncrypted ? { apiKeyEncrypted: selected.apiKeyEncrypted } : {}) };
    await writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8');
    await rename(temporary, target);
  }

  snapshot() {
    const selected = this.activeProfile();
    const profiles = this.modelProfiles.map((profile) => this.profileView(profile));
    const selectedView = profiles.find((profile) => profile.id === selected.id)!;
    return { workspace: this.options.getWorkspace(), mode: this.options.getCore().getMode(), model: selected.model, recentModels: profiles.filter((profile) => profile.enabled).map((profile) => profile.model), baseUrl: selected.baseUrl, contextWindow: this.options.modelConfig.contextWindow, maxOutputTokens: this.options.modelConfig.maxOutputTokens, hasApiKey: selectedView.hasApiKey, keyStorage: selectedView.keyStorage, ...(selectedView.apiKeyHint ? { apiKeyHint: selectedView.apiKeyHint } : {}), activeModelProfileId: this.activeModelProfileId, modelProfiles: profiles, logPath: join(app.getPath('userData'), 'logs', 'main.log') };
  }

  async update(next: SettingsUpdate): Promise<ReturnType<SettingsService['snapshot']>> {
    const input = next && typeof next === 'object' ? next : {};
    let providerChanged = false;
    if (input.mode) { this.options.setMode(input.mode); this.options.getCore().setMode(input.mode); }
    if (input.upsertModel) {
      const value = input.upsertModel;
      const name = value.name?.trim(); const provider = value.provider?.trim(); const model = value.model?.trim(); const baseUrl = value.baseUrl?.trim().replace(/\/$/, '');
      if (!name || name.length > 100) throw new Error('模型名称不能为空且不能超过 100 个字符');
      if (!provider || provider.length > 100) throw new Error('服务商不能为空且不能超过 100 个字符');
      if (!model || model.length > 200) throw new Error('模型标识不能为空且不能超过 200 个字符');
      if (!baseUrl || baseUrl.length > 1000) throw new Error('Base URL 不能为空且不能超过 1000 个字符');
      const parsedUrl = new URL(baseUrl); if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new Error('Base URL 必须使用 http 或 https');
      const existingIndex = value.id ? this.modelProfiles.findIndex((profile) => profile.id === value.id) : -1;
      if (value.id && existingIndex < 0) throw new Error('模型配置不存在');
      const existing = existingIndex >= 0 ? this.modelProfiles[existingIndex] : undefined;
      let apiKeyEncrypted = existing?.apiKeyEncrypted;
      if (value.clearApiKey) apiKeyEncrypted = undefined;
      if (typeof value.apiKey === 'string' && value.apiKey.trim()) apiKeyEncrypted = this.encryptApiKey(value.apiKey.trim());
      const profile: StoredModelProfile = { id: existing?.id ?? randomUUID(), name, provider, model, baseUrl, enabled: value.enabled ?? existing?.enabled ?? true, ...(apiKeyEncrypted ? { apiKeyEncrypted } : {}) };
      if (existingIndex >= 0) this.modelProfiles[existingIndex] = profile; else this.modelProfiles.push(profile);
      if (profile.id === this.activeModelProfileId) providerChanged = true;
    }
    if (input.toggleModel) {
      const target = this.modelProfiles.find((profile) => profile.id === input.toggleModel!.id); if (!target) throw new Error('模型配置不存在');
      if (!input.toggleModel.enabled && target.id === this.activeModelProfileId) {
        const replacement = this.modelProfiles.find((profile) => profile.id !== target.id && profile.enabled); if (!replacement) throw new Error('当前模型不能停用：请先启用并选择其他模型');
        this.activeModelProfileId = replacement.id; providerChanged = true;
      }
      target.enabled = input.toggleModel.enabled;
    }
    if (input.deleteModelId) {
      if (this.modelProfiles.length <= 1) throw new Error('至少需要保留一个模型配置');
      const target = this.modelProfiles.find((profile) => profile.id === input.deleteModelId); if (!target) throw new Error('模型配置不存在');
      this.modelProfiles = this.modelProfiles.filter((profile) => profile.id !== target.id);
      if (target.id === this.activeModelProfileId) { const replacement = this.modelProfiles.find((profile) => profile.enabled) ?? this.modelProfiles[0]!; replacement.enabled = true; this.activeModelProfileId = replacement.id; providerChanged = true; }
    }
    if (typeof input.activeModelProfileId === 'string') {
      const target = this.modelProfiles.find((profile) => profile.id === input.activeModelProfileId && profile.enabled); if (!target) throw new Error('只能选择已启用的模型配置');
      if (target.id !== this.activeModelProfileId) { this.activeModelProfileId = target.id; providerChanged = true; }
    } else if (typeof input.model === 'string') {
      const selectedModel = input.model.trim(); const target = this.modelProfiles.find((profile) => profile.model === selectedModel && profile.enabled); if (!target) throw new Error('模型配置不存在或未启用');
      if (target.id !== this.activeModelProfileId) { this.activeModelProfileId = target.id; providerChanged = true; }
    }
    if (typeof input.contextWindow === 'number') this.options.modelConfig.contextWindow = Math.max(8_000, Math.min(1_000_000, input.contextWindow));
    if (typeof input.maxOutputTokens === 'number') this.options.modelConfig.maxOutputTokens = Math.max(256, Math.min(64_000, input.maxOutputTokens));
    if (providerChanged) this.applyActiveProfile();
    await this.save();
    if (providerChanged) this.options.getCore().reconfigureModel(new OpenAICompatibleProvider(this.options.modelConfig), this.options.modelConfig);
    this.options.logger.write('INFO', 'settings.updated', { model: this.options.modelConfig.model, baseUrl: this.options.modelConfig.baseUrl, mode: this.options.getMode(), providerChanged, keyStorage: this.apiKeySource, hasApiKey: Boolean(process.env[this.options.modelConfig.apiKeyEnv]) });
    return this.snapshot();
  }
}
