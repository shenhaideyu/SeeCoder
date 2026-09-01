import type { BrowserWindow } from 'electron';
import { dialog, shell } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { HookRuntime } from '@seecoder/agent-core';
import type { HookConfig } from '@seecoder/tools';
import { WorkspacePolicy, commandRunner, isHighRiskCommand, parseHookConfig } from '@seecoder/tools';
import type { LocalSkill } from '@seecoder/protocol';
import type { MainLogger } from './main-logger';
import {
  copyManagedSkill,
  managedManifestName,
  managedSkillsRoot,
  readManagedManifest,
  validateSkillSource,
} from './managed-skills';
import type { SettingsService } from './settings-service';
import { textArg } from './workspace-service';

export type ExtensionRecord = LocalSkill & {
  path: string;
  kind: 'skill' | 'hook';
  content?: string;
  hookStatus?: 'trusted' | 'untrusted' | 'invalid';
  hookError?: string;
};

type HookState = {
  path: string;
  hash: string;
  config?: HookConfig;
  status: 'trusted' | 'untrusted' | 'invalid';
  error?: string;
};

interface ExtensionServiceOptions {
  getWorkspace: () => string;
  getWindow: () => BrowserWindow | null;
  settings: SettingsService;
  logger: MainLogger;
}

export class ExtensionService {
  constructor(private readonly options: ExtensionServiceOptions) {}

  createHookRuntime(): HookRuntime {
    return {
      resolve: async (stage) => {
        const state = await this.readHookState();
        return state?.status === 'trusted' ? (state.config?.hooks[stage] ?? []) : [];
      },
      execute: async (command, context, signal) => {
        if (isHighRiskCommand(command.command)) {
          return {
            ok: false,
            durationMs: 0,
            error: { code: 'hook_command_denied', message: 'Hook 包含高风险命令，SeeCoder 已拒绝执行' },
          };
        }
        const workspace = this.options.getWorkspace();
        const cwd = await new WorkspacePolicy(workspace).path('.');
        return commandRunner(
          command.command,
          cwd,
          {
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
          },
          command.timeoutMs,
        );
      },
    };
  }

  async list(includeContent = false): Promise<ExtensionRecord[]> {
    const workspace = this.options.getWorkspace();
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
        output.push({
          id: `${source}:${entry.name}`,
          name: manifest?.displayName ?? entry.name,
          description,
          relativePath: scope === 'managed' ? `本机 Skill/${entry.name}/SKILL.md` : relative(workspace, canonical),
          path: canonical,
          kind: 'skill',
          scope,
          ...(manifest?.sourcePath ? { sourcePath: manifest.sourcePath } : {}),
          ...(includeContent ? { content } : {}),
        });
      }
    }
    const hook = await this.readHookState();
    if (hook) {
      output.push({
        id: 'seecoder:hooks',
        name: '项目 Hooks',
        description:
          hook.status === 'trusted'
            ? '已信任并启用生命周期钩子'
            : hook.status === 'invalid'
              ? '配置无效，未执行'
              : '等待信任，当前不会执行',
        relativePath: relative(workspace, hook.path),
        path: hook.path,
        kind: 'hook',
        hookStatus: hook.status,
        ...(hook.error ? { hookError: hook.error.slice(0, 500) } : {}),
      });
    }
    return output;
  }

  async loadSkill(skillId: string): Promise<{ skill: LocalSkill; content: string }> {
    const id = textArg(skillId, 'skillId', 200);
    const record = (await this.list(true)).find((item) => item.kind === 'skill' && item.id === id);
    if (!record?.content) throw new Error('Skill 不存在或已移出当前工作区');
    return {
      skill: {
        id: record.id,
        name: record.name,
        description: record.description,
        relativePath: record.relativePath,
        ...(record.scope ? { scope: record.scope } : {}),
        ...(record.sourcePath ? { sourcePath: record.sourcePath } : {}),
      },
      content: record.content,
    };
  }

  async importLocal(): Promise<{ cancelled: boolean; skill?: ExtensionRecord }> {
    const window = this.options.getWindow();
    if (!window) throw new Error('主窗口尚未就绪');
    const selected = await dialog.showOpenDialog(window, {
      title: '选择要导入的 SKILL.md',
      properties: ['openFile'],
      filters: [{ name: 'SeeCoder Skill', extensions: ['md'] }],
    });
    if (selected.canceled || !selected.filePaths[0]) return { cancelled: true };
    const source = await validateSkillSource(selected.filePaths[0]);
    const managedRoot = resolve(managedSkillsRoot());
    const sourceDirectory = resolve(source.directory);
    const scoped = relative(managedRoot, sourceDirectory);
    if (!scoped.startsWith('..') && !isAbsolute(scoped)) throw new Error('该 Skill 已位于 SeeCoder 管理目录中');
    const target = await copyManagedSkill(source);
    const imported = (await this.list()).find((item) => item.id === `managed:${basename(target)}`);
    this.options.logger.write('INFO', 'skill.imported', { skillId: imported?.id, sourcePath: source.directory });
    return { cancelled: false, ...(imported ? { skill: imported } : {}) };
  }

  async refresh(skillId: string): Promise<ExtensionRecord[]> {
    const record = await this.managedSkill(skillId);
    if (!record.sourcePath || !existsSync(record.sourcePath)) throw new Error('原始 Skill 路径不可用，请重新导入');
    const source = await validateSkillSource(join(record.sourcePath, 'SKILL.md'));
    const target = dirname(record.path);
    const manifest = await readManagedManifest(target);
    if (!manifest) throw new Error('Skill 导入信息损坏，请重新导入');
    const temporary = join(managedSkillsRoot(), `.refresh-${randomUUID()}`);
    const backup = `${target}.backup-${randomUUID()}`;
    await cp(source.directory, temporary, { recursive: true, errorOnExist: true });
    await writeFile(
      join(temporary, managedManifestName),
      JSON.stringify({ ...manifest, sourcePath: source.directory, importedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
    await rename(target, backup);
    try {
      await rename(temporary, target);
    } catch (error) {
      await rename(backup, target);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
    this.options.logger.write('INFO', 'skill.refreshed', { skillId: record.id });
    return this.list();
  }

  async rename(skillId: string, name: string): Promise<ExtensionRecord[]> {
    const record = await this.managedSkill(skillId);
    const directory = dirname(record.path);
    const manifest = await readManagedManifest(directory);
    if (!manifest) throw new Error('Skill 导入信息损坏，请重新导入');
    await writeFile(
      join(directory, managedManifestName),
      JSON.stringify({ ...manifest, displayName: textArg(name, 'name', 80) }, null, 2),
      'utf8',
    );
    return this.list();
  }

  async delete(skillId: string): Promise<ExtensionRecord[]> {
    const record = await this.managedSkill(skillId);
    await rm(dirname(record.path), { recursive: true, force: true });
    this.options.logger.write('INFO', 'skill.deleted', { skillId: record.id });
    return this.list();
  }

  async openSource(skillId: string): Promise<string> {
    const record = await this.managedSkill(skillId);
    const target = record.sourcePath && existsSync(record.sourcePath) ? record.sourcePath : record.path;
    shell.showItemInFolder(target);
    return target;
  }

  async trustHooks(enabled: boolean): Promise<ExtensionRecord[]> {
    const state = await this.readHookState();
    if (!state) throw new Error('当前工作区没有 .seecoder/hooks.json');
    const workspace = this.options.getWorkspace();
    if (enabled) {
      if (state.status === 'invalid' || !state.config) throw new Error(state.error ?? 'Hook 配置无效');
      await this.options.settings.setHookTrusted(state.hash);
      this.options.logger.write('INFO', 'hooks.trusted', { workspace, hash: state.hash.slice(0, 12) });
    } else {
      await this.options.settings.setHookTrusted(undefined);
      this.options.logger.write('INFO', 'hooks.disabled', { workspace });
    }
    return this.list();
  }

  private async readHookState(): Promise<HookState | null> {
    const path = join(this.options.getWorkspace(), '.seecoder', 'hooks.json');
    if (!existsSync(path)) return null;
    const content = await readFile(path, 'utf8');
    const hash = createHash('sha256').update(content).digest('hex');
    try {
      const config = parseHookConfig(JSON.parse(content));
      return {
        path,
        hash,
        config,
        status: this.options.settings.isHookTrusted(hash) ? 'trusted' : 'untrusted',
      };
    } catch (error) {
      return {
        path,
        hash,
        status: 'invalid',
        error: error instanceof Error ? error.message : 'Hook 配置无效',
      };
    }
  }

  private async managedSkill(skillId: string): Promise<ExtensionRecord> {
    const id = textArg(skillId, 'skillId', 200);
    if (!id.startsWith('managed:')) throw new Error('项目 Skill 由工作区管理，不能从全局库修改');
    const record = (await this.list()).find((item) => item.kind === 'skill' && item.id === id);
    if (!record || record.scope !== 'managed') throw new Error('本机 Skill 不存在');
    const root = await realpath(managedSkillsRoot());
    const directory = await realpath(dirname(record.path));
    const scoped = relative(root, directory);
    if (!scoped || scoped.startsWith('..') || isAbsolute(scoped)) throw new Error('Skill 路径超出应用管理目录');
    return record;
  }
}
