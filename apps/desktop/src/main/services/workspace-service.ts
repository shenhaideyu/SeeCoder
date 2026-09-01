import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { commandRunner, WorkspacePolicy, type ToolContext } from '@seecoder/tools';
import type { PullRequestStatus, ToolResult } from '@seecoder/protocol';
import type { MainLogger } from './main-logger';

interface WorkspaceServiceOptions {
  getWorkspace: () => string;
  logger: MainLogger;
  sameWorkspace: (left: string, right: string) => boolean;
}

export const textArg = (value: unknown, name: string, max = 100_000): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${name} 参数无效`);
  return value;
};

export const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

export class WorkspaceService {
  constructor(private readonly options: WorkspaceServiceOptions) {}

  private commandContext(onOutput?: ToolContext['onOutput']): ToolContext {
    const workspace = this.options.getWorkspace();
    return onOutput ? { workspace, onOutput } : { workspace };
  }

  async runCommand(command: string, cwd = this.options.getWorkspace(), timeoutMs = 30_000, onOutput?: ToolContext['onOutput']) {
    const commandName = command.trim().split(/\s+/)[0]?.slice(0, 40) || 'unknown';
    const started = Date.now();
    this.options.logger.write('INFO', 'workspace.command.started', { command: commandName, cwd });
    try {
      const resolved = await new WorkspacePolicy(this.options.getWorkspace()).path(cwd);
      const result = await commandRunner(command, resolved, this.commandContext(onOutput), timeoutMs);
      this.options.logger.write(result.ok ? 'INFO' : 'WARN', 'workspace.command.completed', {
        command: commandName,
        ok: result.ok,
        durationMs: Date.now() - started,
        error: result.error?.code,
      });
      return result;
    } catch (error) {
      this.options.logger.write('WARN', 'workspace.command.rejected', {
        command: commandName,
        durationMs: Date.now() - started,
        message: error instanceof Error ? error.message : '命令被拒绝',
      });
      throw error;
    }
  }

  private async scopedGitRoot(): Promise<string> {
    const workspace = this.options.getWorkspace();
    const probe = await this.runCommand('git rev-parse --show-toplevel');
    const output = probe.output as { stdout?: unknown } | undefined;
    const root = typeof output?.stdout === 'string' ? output.stdout.trim() : '';
    if (!probe.ok || !root) throw new Error('当前工作区不是 Git 仓库');
    const [canonicalWorkspace, canonicalRoot] = await Promise.all([realpath(workspace).catch(() => resolve(workspace)), realpath(root).catch(() => resolve(root))]);
    if (!this.options.sameWorkspace(canonicalWorkspace, canonicalRoot)) {
      throw new Error('Git 操作已禁用：当前目录属于上级仓库。请切换到仓库根目录，避免操作工作区外文件。');
    }
    return canonicalRoot;
  }

  async runGit(command: string, timeoutMs = 30_000) {
    return this.runCommand(command, await this.scopedGitRoot(), timeoutMs);
  }

  private commandStdout(result: ToolResult): string {
    const output = result.output as { stdout?: unknown } | undefined;
    return typeof output?.stdout === 'string' ? output.stdout.trim() : '';
  }

  async readPullRequestStatus(): Promise<PullRequestStatus> {
    try {
      const root = await this.scopedGitRoot();
      const installed = await this.runCommand('gh --version', root, 10_000);
      if (!installed.ok)
        return {
          status: 'setup_required',
          reason: 'gh_not_installed',
          message: '未检测到 GitHub CLI',
          command: 'winget install --id GitHub.cli',
        };
      const authenticated = await this.runCommand('gh auth status', root, 15_000);
      if (!authenticated.ok)
        return {
          status: 'setup_required',
          reason: 'gh_not_authenticated',
          message: 'GitHub CLI 尚未登录',
          command: 'gh auth login',
        };
      const result = await this.runCommand('gh pr list --state open --limit 50 --json number,title,state,url,headRefName,isDraft', root, 30_000);
      if (!result.ok) return { status: 'error', message: '无法读取拉取请求，请检查仓库远程地址和 GitHub 权限。' };
      const parsed: unknown = JSON.parse(this.commandStdout(result) || '[]');
      if (!Array.isArray(parsed)) return { status: 'error', message: 'GitHub CLI 返回了无法识别的数据。' };
      const pullRequests = parsed.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const value = item as Record<string, unknown>;
        if (typeof value.number !== 'number' || typeof value.title !== 'string' || typeof value.url !== 'string') return [];
        return [
          {
            number: value.number,
            title: value.title,
            state: typeof value.state === 'string' ? value.state : 'OPEN',
            url: value.url,
            headRefName: typeof value.headRefName === 'string' ? value.headRefName : '',
            isDraft: value.isDraft === true,
          },
        ];
      });
      return { status: 'ready', pullRequests };
    } catch (error) {
      this.options.logger.write('WARN', 'git.pr-status.failed', {
        message: error instanceof Error ? error.message : 'unknown',
      });
      return {
        status: 'error',
        message: error instanceof Error ? error.message : '无法读取拉取请求。',
      };
    }
  }
}
