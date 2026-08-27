import { spawn } from 'node:child_process';
import { readFile, readdir, realpath, writeFile, mkdir, unlink } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z, type ZodTypeAny } from 'zod';
import type { ChangeFile, PermissionMode, ToolCall, ToolResult } from '@seecoder/protocol';

export interface ToolContext {
  workspace: string;
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
  signal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ZodTypeAny;
  sideEffect: boolean;
  risk: 'low' | 'medium' | 'high';
  execute(args: unknown, context: ToolContext): Promise<ToolResult>;
}

export class WorkspacePolicy {
  readonly root: string;

  constructor(workspace: string) {
    this.root = resolve(workspace);
  }

  async path(input = '.'): Promise<string> {
    const candidate = resolve(this.root, input);
    const existing = await realpath(candidate).catch(() => candidate);
    const canonicalRoot = await realpath(this.root).catch(() => this.root);
    const outside = relative(canonicalRoot, existing).startsWith('..') || isAbsolute(relative(canonicalRoot, existing));
    if (outside) throw new Error(`路径越出工作区: ${input}`);
    return candidate;
  }

  isInside(input: string): boolean {
    const candidate = resolve(this.root, input);
    const lexical = relative(this.root, candidate);
    if (lexical.startsWith('..') || isAbsolute(lexical)) return false;
    try { lstatSync(candidate); } catch { return true; }
    let checked = candidate;
    try { checked = realpathSync.native(candidate); } catch { /* new paths are checked lexically */ }
    let root = this.root;
    try { root = realpathSync.native(this.root); } catch { /* workspace may be created after config */ }
    const rel = relative(root, checked);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  }

  canAutoApprove(call: ToolCall, mode: PermissionMode): boolean {
    if (mode === 'guided') return false;
    if (!['write_file', 'apply_patch', 'run_command', 'set_plan'].includes(call.name)) return true;
    if (call.name === 'set_plan') return true;
    if (call.name === 'write_file' || call.name === 'apply_patch') {
      const args = call.args as { path?: unknown };
      return typeof args.path === 'string' && this.isInside(args.path);
    }
    const args = call.args as { command?: unknown; cwd?: unknown };
    if (typeof args.cwd === 'string' && !this.isInside(args.cwd)) return false;
    if (typeof args.command !== 'string') return false;
    return !/(remove-item|rm\s+-rf|rmdir|del\s+\/s|format(-volume)?|shutdown|reg\s+|git\s+(reset|clean|push)|curl\s+|wget\s+|npm\s+install|pnpm\s+add|yarn\s+add)/i.test(args.command);
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.seecoder-${Date.now()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, content, 'utf8');
  const fs = await import('node:fs/promises');
  await fs.rename(temporary, path);
}

function result(ok: boolean, output: unknown, durationMs: number, error?: ToolResult['error']): ToolResult {
  return error ? { ok, error, durationMs } : { ok, output, durationMs };
}

async function readExisting(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

interface PatchFile {
  oldPath: string;
  newPath: string;
  hunks: string[];
}

function parseUnifiedPatch(patch: string): PatchFile[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const files: PatchFile[] = [];
  let current: PatchFile | undefined;
  for (const line of lines) {
    if (line.startsWith('--- ')) {
      if (current) files.push(current);
      current = { oldPath: line.slice(4).split('\t')[0] ?? '', newPath: '', hunks: [] };
    } else if (line.startsWith('+++ ') && current) {
      current.newPath = line.slice(4).split('\t')[0] ?? '';
    } else if (line.startsWith('@@ ') && current) {
      current.hunks.push(line);
    } else if (current && current.hunks.length > 0) {
      const last = current.hunks.length - 1;
      current.hunks[last] = `${current.hunks[last]}\n${line}`;
    }
  }
  if (current) files.push(current);
  if (!files.length || files.some((file) => !file.newPath)) throw new Error('补丁格式无效，需要 unified diff');
  return files;
}

function applyFilePatch(before: string, file: PatchFile): string {
  const source = before.replace(/\r\n/g, '\n').split('\n');
  let delta = 0;
  for (const hunk of file.hunks) {
    const [header, ...body] = hunk.split('\n');
    const match = header?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) throw new Error(`补丁区块无效: ${header}`);
    const start = Number(match[1]) - 1 + delta;
    const removed: string[] = [];
    const added: string[] = [];
    const patchBody = body.at(-1) === '' ? body.slice(0, -1) : body;
    for (const line of patchBody) {
      if (line.startsWith('-')) removed.push(line.slice(1));
      else if (line.startsWith('+')) added.push(line.slice(1));
      else if (line.startsWith(' ') || line === '') {
        const value = line.startsWith(' ') ? line.slice(1) : '';
        removed.push(value);
        added.push(value);
      }
    }
    const actual = source.slice(start, start + removed.length);
    if (actual.join('\n') !== removed.join('\n')) throw new Error(`补丁上下文不匹配: ${file.newPath}`);
    source.splice(start, removed.length, ...added);
    delta += added.length - removed.length;
  }
  return source.join('\n');
}

async function collectFiles(root: string, current: string, output: string[], depth: number, max: number): Promise<void> {
  if (output.length >= max || depth < 0) return;
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (output.length >= max || ['.git', 'node_modules', 'dist', 'out', 'coverage'].includes(entry.name)) continue;
    const full = join(current, entry.name);
    if (entry.isDirectory()) await collectFiles(root, full, output, depth - 1, max);
    else output.push(relative(root, full));
  }
}

function commandRunner(command: string, cwd: string, context: ToolContext, timeoutMs = 60_000): Promise<ToolResult> {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const windows = process.platform === 'win32';
    const child = spawn(windows ? 'powershell.exe' : 'sh', windows ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command], {
      cwd,
      env: { ...process.env, CI: '1' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8').slice(0, 1_048_576);
      if (stream === 'stdout') stdout = `${stdout}${text}`.slice(-1_048_576);
      else stderr = `${stderr}${text}`.slice(-1_048_576);
      context.onOutput?.(stream, text);
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', (error) => finish(result(false, undefined, Date.now() - started, { code: 'spawn_error', message: error.message })));
    child.on('close', (code) => finish(code === 0
      ? result(true, { exitCode: code, stdout, stderr }, Date.now() - started)
      : result(false, { exitCode: code, stdout, stderr }, Date.now() - started, { code: 'command_failed', message: `命令退出码 ${code}` })));
    const timer = setTimeout(() => {
      if (windows) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      else child.kill('SIGKILL');
      finish(result(false, { stdout, stderr }, Date.now() - started, { code: 'timeout', message: `命令超过 ${timeoutMs}ms` }));
    }, timeoutMs);
    context.signal?.addEventListener('abort', () => {
      if (windows) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      else child.kill('SIGTERM');
      finish(result(false, { stdout, stderr }, Date.now() - started, { code: 'cancelled', message: '命令已取消' }));
    }, { once: true });
  });
}

export function createToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'list_files', description: '列出工作区内文件和目录', sideEffect: false, risk: 'low',
      parameters: z.object({ path: z.string().optional(), depth: z.number().int().min(0).max(5).optional() }),
      async execute(raw, context) {
        const started = Date.now(); const args = raw as { path?: string; depth?: number };
        try { const path = await new WorkspacePolicy(context.workspace).path(args.path); const files: string[] = []; await collectFiles(context.workspace, path, files, args.depth ?? 2, 200); return result(true, files, Date.now() - started); }
        catch (error) { return result(false, undefined, Date.now() - started, { code: 'path_denied', message: error instanceof Error ? error.message : '路径无效' }); }
      },
    },
    {
      name: 'read_file', description: '读取工作区内文本文件，可按行截断', sideEffect: false, risk: 'low',
      parameters: z.object({ path: z.string(), startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional() }),
      async execute(raw, context) {
        const started = Date.now(); const args = raw as { path: string; startLine?: number; endLine?: number };
        try { const path = await new WorkspacePolicy(context.workspace).path(args.path); const text = await readFile(path, 'utf8'); const lines = text.split(/\r?\n/); const start = (args.startLine ?? 1) - 1; const end = Math.min(args.endLine ?? start + 400, start + 400, lines.length); return result(true, { path: relative(context.workspace, path), startLine: start + 1, endLine: end, text: lines.slice(start, end).join('\n') }, Date.now() - started); }
        catch (error) { return result(false, undefined, Date.now() - started, { code: 'read_failed', message: error instanceof Error ? error.message : '读取失败' }); }
      },
    },
    {
      name: 'search_text', description: '在工作区文本文件中搜索字符串或正则', sideEffect: false, risk: 'low',
      parameters: z.object({ query: z.string().min(1), path: z.string().optional(), glob: z.string().optional(), maxResults: z.number().int().min(1).max(100).optional() }),
      async execute(raw, context) {
        const started = Date.now(); const args = raw as { query: string; path?: string; glob?: string; maxResults?: number }; const max = args.maxResults ?? 50; const base = await new WorkspacePolicy(context.workspace).path(args.path); const files: string[] = []; await collectFiles(context.workspace, base, files, 8, 1000); const matches: Array<{ path: string; line: number; text: string }> = []; let regex: RegExp; try { regex = new RegExp(args.query, 'i'); } catch { regex = new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } for (const relPath of files) { if (args.glob && !relPath.toLowerCase().endsWith(args.glob.replace('*', '').toLowerCase())) continue; if (matches.length >= max) break; const text = await readExisting(join(context.workspace, relPath)); if (!text || text.includes('\u0000')) continue; text.split(/\r?\n/).forEach((line, index) => { if (matches.length < max && regex.test(line)) matches.push({ path: relPath, line: index + 1, text: line.slice(0, 300) }); }); } return result(true, matches, Date.now() - started);
      },
    },
    {
      name: 'write_file', description: '原子写入工作区内文本文件', sideEffect: true, risk: 'medium',
      parameters: z.object({ path: z.string(), content: z.string() }),
      async execute(raw, context) {
        const started = Date.now(); const args = raw as { path: string; content: string };
        try { const path = await new WorkspacePolicy(context.workspace).path(args.path); const before = await readExisting(path); await atomicWrite(path, args.content); const files: ChangeFile[] = [{ path: relative(context.workspace, path), before, after: args.content }]; return result(true, { kind: 'changes', files }, Date.now() - started); }
        catch (error) { return result(false, undefined, Date.now() - started, { code: 'write_failed', message: error instanceof Error ? error.message : '写入失败' }); }
      },
    },
    {
      name: 'apply_patch', description: '应用 unified diff，所有区块校验通过后原子写入', sideEffect: true, risk: 'medium',
      parameters: z.object({ patch: z.string().min(1) }),
      async execute(raw, context) {
        const started = Date.now(); const args = raw as { patch: string };
        try { const files = parseUnifiedPatch(args.patch); const policy = new WorkspacePolicy(context.workspace); const changes: ChangeFile[] = []; const next: Array<{ path: string; before: string | null; after: string }> = []; for (const file of files) { const name = (file.newPath || file.oldPath).replace(/^([ab])\//, ''); const path = await policy.path(name); const before = await readExisting(path); if (before === null) throw new Error(`补丁目标不存在: ${name}`); const after = applyFilePatch(before, file); changes.push({ path: relative(context.workspace, path), before, after }); next.push({ path, before, after }); } for (const item of next) await atomicWrite(item.path, item.after); return result(true, { kind: 'changes', files: changes }, Date.now() - started); }
        catch (error) { return result(false, undefined, Date.now() - started, { code: 'patch_failed', message: error instanceof Error ? error.message : '补丁失败' }); }
      },
    },
    {
      name: 'run_command', description: '在工作区内运行 PowerShell 命令并流式返回输出', sideEffect: true, risk: 'high',
      parameters: z.object({ command: z.string().min(1), cwd: z.string().optional(), timeoutMs: z.number().int().min(1000).max(120000).optional() }),
      async execute(raw, context) { const args = raw as { command: string; cwd?: string; timeoutMs?: number }; try { const cwd = await new WorkspacePolicy(context.workspace).path(args.cwd); return await commandRunner(args.command, cwd, context, args.timeoutMs); } catch (error) { return result(false, undefined, 0, { code: 'command_denied', message: error instanceof Error ? error.message : '命令目录无效' }); } },
    },
    {
      name: 'git_diff', description: '查看当前工作区 Git Diff', sideEffect: false, risk: 'low',
      parameters: z.object({ path: z.string().optional() }),
      async execute(raw, context) { const args = raw as { path?: string }; const cwd = await new WorkspacePolicy(context.workspace).path('.'); const command = args.path ? `git diff -- ${JSON.stringify(args.path)}` : 'git diff'; return commandRunner(command, cwd, context, 30_000); },
    },
    {
      name: 'set_plan', description: '更新用户可见的执行计划', sideEffect: false, risk: 'low',
      parameters: z.object({ steps: z.array(z.object({ id: z.string(), label: z.string(), status: z.enum(['pending', 'running', 'completed', 'failed']) })) }),
      async execute(raw) { return result(true, raw, 0); },
    },
    {
      name: 'finish', description: '提交任务完成摘要和验证证据', sideEffect: false, risk: 'low',
      parameters: z.object({ summary: z.string(), verification: z.array(z.string()).default([]) }),
      async execute(raw) { return result(true, raw, 0); },
    },
    {
      name: 'delegate', description: '委派只读 Explore 或 Review 子 Agent（由 Core 调度）', sideEffect: false, risk: 'low',
      parameters: z.object({ role: z.enum(['explore', 'review']), task: z.string(), focusPaths: z.array(z.string()).optional() }),
      async execute() { return result(false, undefined, 0, { code: 'delegate_unhandled', message: 'delegate 必须由 Agent Core 调度' }); },
    },
  ];
}

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDefinition>();
  constructor(definitions = createToolDefinitions()) { definitions.forEach((definition) => this.byName.set(definition.name, definition)); }
  get(name: string): ToolDefinition | undefined { return this.byName.get(name); }
  list(): ToolDefinition[] { return [...this.byName.values()]; }
}

export async function restoreChangeSet(workspace: string, files: ChangeFile[]): Promise<ToolResult> {
  const started = Date.now();
  const policy = new WorkspacePolicy(workspace);
  try {
    for (const file of files) {
      const path = await policy.path(file.path);
      if (file.before === null) await unlink(path).catch(() => undefined);
      else await atomicWrite(path, file.before);
    }
    return result(true, { restored: files.map((file) => file.path) }, Date.now() - started);
  } catch (error) {
    return result(false, undefined, Date.now() - started, { code: 'restore_failed', message: error instanceof Error ? error.message : '撤销失败' });
  }
}
