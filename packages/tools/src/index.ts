import { spawn } from 'node:child_process';
import { readFile, readdir, realpath, writeFile, mkdir, stat, unlink } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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

/**
 * 凭据类文件不进入 Agent 上下文，也不出现在 Files 面板。
 * 这是应用层最小权限策略，不等同于操作系统沙箱。
 */
export function isSensitivePath(input: string): boolean {
  const normalized = input.replace(/\\/g, '/').toLowerCase();
  const basename = normalized.split('/').pop() ?? normalized;
  if (basename === '.env' || (basename.startsWith('.env.') && !['.env.example', '.env.sample', '.env.template'].includes(basename))) return true;
  if (/(^|[-_.])(secret|secrets|credential|credentials|token|apikey|api_key|private)([-_.]|$)/.test(basename)) return true;
  return /\.(pem|key|p12|pfx|kdbx)$/i.test(basename) || basename === 'id_rsa' || basename === 'id_ed25519';
}

export class WorkspacePolicy {
  readonly root: string;

  constructor(workspace: string) {
    this.root = resolve(workspace);
  }

  async path(input = '.'): Promise<string> {
    const candidate = resolve(this.root, input);
    const canonicalRoot = await realpath(this.root).catch(() => this.root);
    const lexical = relative(this.root, candidate);
    if (lexical.startsWith('..') || isAbsolute(lexical)) throw new Error(`路径越出工作区: ${input}`);
    const existing = await canonicalizeFuturePath(candidate);
    const canonicalRelative = relative(canonicalRoot, existing);
    const outside = canonicalRelative.startsWith('..') || isAbsolute(canonicalRelative);
    if (outside) throw new Error(`路径越出工作区: ${input}`);
    if (isSensitivePath(input)) throw new Error(`出于安全原因，禁止访问凭据文件: ${input}`);
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
    const readOnly = ['list_files', 'read_file', 'read_files', 'search_text', 'git_diff', 'set_plan', 'finish', 'delegate', 'ask_user', 'checkpoint', 'review_changes', 'compact_context'];
    if (readOnly.includes(call.name)) return true;
    if (mode === 'guided') return false;
    if (!['write_file', 'apply_patch', 'run_command', 'set_plan'].includes(call.name)) return true;
    if (call.name === 'set_plan') return true;
    if (call.name === 'apply_patch') {
      const patch = (call.args as { patch?: unknown }).patch;
      if (typeof patch !== 'string') return false;
      const paths = extractPatchPaths(patch);
      return paths.length > 0 && paths.every((path) => this.isInside(path));
    }
    if (call.name === 'write_file') {
      const args = call.args as { path?: unknown };
      return typeof args.path === 'string' && this.isInside(args.path);
    }
    const args = call.args as { command?: unknown; cwd?: unknown };
    if (typeof args.cwd === 'string' && !this.isInside(args.cwd)) return false;
    if (typeof args.command !== 'string') return false;
    return !isHighRiskCommand(args.command);
  }
}

/**
 * 应用层的高风险命令识别。它不是操作系统沙箱，只负责在 Agent 自动模式和
 * 终端 IPC 边界做最后一道明确拒绝；需要人工确认的 Git 操作由专用按钮处理。
 */
export function isHighRiskCommand(command: string): boolean {
  return /(remove-item|rm\s+-rf|rmdir|del\s+\/s|format(-volume)?|shutdown|reg\s+|git\s+(reset|clean|push)|curl\s+|wget\s+|npm\s+(install|i\b)|pnpm\s+(add|install)|yarn\s+(add|install)|invoke-webrequest)/i.test(command);
}

export function commandRisk(command: string): ToolDefinition['risk'] {
  if (isHighRiskCommand(command)) return 'high';
  const normalized = command.replace(/\s*2>&1\s*\|\s*Out-String\s*$/i, '');
  const safe = /^\s*(git\s+(status|diff|log|show|branch)\b|(?:pnpm|npm|yarn)\s+(test|run\s+(test|lint|typecheck|build))\b|node\s+(--version\b|--test\b)|pytest\b|python\s+-m\s+pytest\b)/i;
  const parts = normalized.split(';').map((part) => part.trim()).filter(Boolean);
  if (parts.length && parts.every((part) => safe.test(part))) return 'low';
  return 'medium';
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.seecoder-${Date.now()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, content, 'utf8');
  const fs = await import('node:fs/promises');
  await fs.rename(temporary, path);
}

function result(ok: boolean, output: unknown, durationMs: number, error?: ToolResult['error']): ToolResult {
  return { ok, ...(output !== undefined ? { output } : {}), ...(error ? { error } : {}), durationMs };
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

function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) paths.add(match[1]!.trim());
  for (const match of patch.matchAll(/^\+\+\+\s+(?:b\/)?([^\t\r\n]+)$/gm)) {
    if (match[1] !== '/dev/null') paths.add(match[1]!.trim());
  }
  return [...paths];
}

function parseCodexPatch(patch: string): PatchFile[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const files: PatchFile[] = [];
  let current: PatchFile | undefined;
  for (const line of lines) {
    const file = line.match(/^\*\*\* Update File:\s*(.+)$/);
    if (file) {
      if (current) files.push(current);
      current = { oldPath: file[1]!.trim(), newPath: file[1]!.trim(), hunks: [] };
    } else if (line === '@@' && current) {
      current.hunks.push('@@');
    } else if (current && current.hunks.length > 0 && !line.startsWith('*** End Patch')) {
      const last = current.hunks.length - 1;
      current.hunks[last] = `${current.hunks[last]}\n${line}`;
    }
  }
  if (current) files.push(current);
  if (!files.length || files.some((file) => file.hunks.length === 0)) throw new Error('Codex 补丁格式无效');
  return files;
}

function parseUnifiedPatch(patch: string): PatchFile[] {
  if (patch.includes('*** Begin Patch')) return parseCodexPatch(patch);
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
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const source = before.replace(/\r\n/g, '\n').split('\n');
  let delta = 0;
  for (const hunk of file.hunks) {
    const [header, ...body] = hunk.split('\n');
    const match = header?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    const contextOnly = header === '@@';
    if (!match && !contextOnly) throw new Error(`补丁区块无效: ${header}`);
    const expectedStart = match ? Number(match[1]) - 1 + delta : 0;
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
    let start = expectedStart;
    const matchesAt = (index: number) => source.slice(index, index + removed.length).join('\n') === removed.join('\n');
    if (!matchesAt(start)) {
      const candidates: number[] = [];
      const from = contextOnly ? 0 : Math.max(0, expectedStart - 80);
      const to = contextOnly ? source.length : Math.min(source.length, expectedStart + 80);
      for (let index = from; index <= to; index += 1) if (matchesAt(index)) candidates.push(index);
      if (candidates.length !== 1) throw new Error(`补丁上下文不匹配: ${file.newPath}`);
      start = candidates[0]!;
    }
    source.splice(start, removed.length, ...added);
    delta += start - expectedStart + added.length - removed.length;
  }
  return source.join(eol);
}

const ignoredTraversalDirectories = new Set([
  '.git', '.idea', '.venv', 'venv', 'node_modules', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', '.cache', 'dist', 'out', 'build', 'builds', 'generated', 'coverage',
  '.next', '.nuxt', 'target',
]);

async function collectFiles(root: string, current: string, output: string[], depth: number, max: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('操作已取消');
  if (output.length >= max || depth < 0) return;
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (signal?.aborted) throw new Error('操作已取消');
    if (output.length >= max || entry.isSymbolicLink() || (entry.isDirectory() && ignoredTraversalDirectories.has(entry.name)) || isSensitivePath(entry.name)) continue;
    const full = join(current, entry.name);
    if (entry.isDirectory()) await collectFiles(root, full, output, depth - 1, max, signal);
    else output.push(relative(root, full));
  }
}

async function canonicalizeFuturePath(candidate: string): Promise<string> {
  let current = candidate;
  const missing: string[] = [];
  while (true) {
    try {
      const existing = await realpath(current);
      return resolve(existing, ...missing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return candidate;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

async function searchWithRg(
  query: string,
  base: string,
  workspace: string,
  glob: string | undefined,
  max: number,
  signal?: AbortSignal,
): Promise<Array<{ path: string; line: number; text: string }> | null> {
  if (signal?.aborted) throw new Error('操作已取消');
  return new Promise((resolvePromise, reject) => {
    const args = ['--line-number', '--no-heading', '--color', 'never', '--max-columns', '300'];
    if (glob) args.push('--glob', glob);
    for (const excluded of ['!.env', '!.env.*', '!*.pem', '!*.key', '!*.p12', '!*.pfx', '!*secret*', '!*credential*', '!*token*', '!*apikey*', '!*api_key*']) args.push('--glob', excluded);
    args.push('--', query, '.');
    const child = spawn('rg', args, { cwd: base, windowsHide: true });
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let buffer = '';
    let unavailable = false;
    const onAbort = () => child.kill();
    const consume = (chunk: string, flush = false) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      if (!flush) buffer = lines.pop() ?? '';
      else buffer = '';
      for (const line of lines) {
        const match = line.match(/^(.*?):(\d+):(.*)$/);
        if (!match || matches.length >= max) continue;
        matches.push({ path: relative(workspace, resolve(base, match[1]!)), line: Number(match[2]), text: match[3]!.slice(0, 300) });
      }
      if (matches.length >= max) child.kill();
    };
    child.stdout.on('data', (chunk: Buffer) => consume(chunk.toString('utf8')));
    child.on('error', (error: NodeJS.ErrnoException) => {
      unavailable = error.code === 'ENOENT';
      if (!unavailable) reject(error);
    });
    child.on('close', () => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new Error('操作已取消'));
      else if (unavailable) resolvePromise(null);
      else { consume('', true); resolvePromise(matches); }
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function commandRunner(command: string, cwd: string, context: ToolContext, timeoutMs = 60_000): Promise<ToolResult> {
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
        try {
          const path = await new WorkspacePolicy(context.workspace).path(args.path);
          if ((await stat(path)).isFile()) return result(true, [relative(context.workspace, path)], Date.now() - started);
          const files: string[] = [];
          await collectFiles(context.workspace, path, files, args.depth ?? 2, 200, context.signal);
          return result(true, files, Date.now() - started);
        }
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
      name: 'read_files', description: '一次批量读取多个已知文本文件；已定位多个文件时优先于重复 read_file', sideEffect: false, risk: 'low',
      parameters: z.object({ paths: z.array(z.string().min(1)).min(1).max(30) }),
      async execute(raw, context) {
        const started = Date.now(); const args = raw as { paths: string[] }; const outputs: Array<{ path: string; text?: string; error?: string }> = [];
        for (const input of args.paths) {
          if (context.signal?.aborted) return result(false, outputs, Date.now() - started, { code: 'cancelled', message: '批量读取已取消' });
          try { const path = await new WorkspacePolicy(context.workspace).path(input); const text = await readFile(path, 'utf8'); outputs.push({ path: relative(context.workspace, path), text: text.split(/\r?\n/).slice(0, 400).join('\n') }); }
          catch (error) { outputs.push({ path: input, error: error instanceof Error ? error.message : '读取失败' }); }
        }
        return result(true, outputs, Date.now() - started);
      },
    },
    {
      name: 'search_text', description: '先按字符串或正则定位相关文件和行，再按需读取命中片段', sideEffect: false, risk: 'low',
      parameters: z.object({ query: z.string().min(1), path: z.string().optional(), glob: z.string().optional(), maxResults: z.number().int().min(1).max(100).optional() }),
      async execute(raw, context) {
        const started = Date.now(); const args = raw as { query: string; path?: string; glob?: string; maxResults?: number }; const max = args.maxResults ?? 50;
        try {
          const base = await new WorkspacePolicy(context.workspace).path(args.path);
          const matches: Array<{ path: string; line: number; text: string }> = [];
          let regex: RegExp; try { regex = new RegExp(args.query, 'i'); } catch { regex = new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
          if ((await stat(base)).isFile()) {
            const text = await readExisting(base);
            if (text && !text.includes('\u0000')) text.split(/\r?\n/).forEach((line, index) => { if (matches.length < max && regex.test(line)) matches.push({ path: relative(context.workspace, base), line: index + 1, text: line.slice(0, 300) }); });
            return result(true, matches, Date.now() - started);
          }
          const fastMatches = await searchWithRg(args.query, base, context.workspace, args.glob, max, context.signal);
          if (fastMatches) return result(true, fastMatches, Date.now() - started);
          const files: string[] = []; await collectFiles(context.workspace, base, files, 8, 1000, context.signal); for (const relPath of files) { if (context.signal?.aborted) return result(false, matches, Date.now() - started, { code: 'cancelled', message: '搜索已取消' }); if (args.glob && !relPath.toLowerCase().endsWith(args.glob.replace('*', '').toLowerCase())) continue; if (matches.length >= max) break; const text = await readExisting(join(context.workspace, relPath)); if (!text || text.includes('\u0000')) continue; text.split(/\r?\n/).forEach((line, index) => { if (matches.length < max && regex.test(line)) matches.push({ path: relPath, line: index + 1, text: line.slice(0, 300) }); }); } return result(true, matches, Date.now() - started);
        } catch (error) {
          if (context.signal?.aborted) throw error;
          return result(false, undefined, Date.now() - started, { code: 'search_failed', message: error instanceof Error ? error.message : '搜索失败' });
        }
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
      name: 'apply_patch', description: '应用标准 unified diff 或 *** Begin Patch / *** Update File 补丁；所有旧内容校验通过后原子写入', sideEffect: true, risk: 'medium',
      parameters: z.object({ patch: z.string().min(1) }),
      async execute(raw, context) {
        const started = Date.now(); const args = raw as { patch: string };
        try { const files = parseUnifiedPatch(args.patch); const policy = new WorkspacePolicy(context.workspace); const changes: ChangeFile[] = []; const next: Array<{ path: string; before: string | null; after: string }> = []; for (const file of files) { const name = (file.newPath || file.oldPath).replace(/^([ab])\//, ''); const path = await policy.path(name); const before = await readExisting(path); if (before === null) throw new Error(`补丁目标不存在: ${name}`); const after = applyFilePatch(before, file); changes.push({ path: relative(context.workspace, path), before, after }); next.push({ path, before, after }); } for (const item of next) await atomicWrite(item.path, item.after); return result(true, { kind: 'changes', files: changes }, Date.now() - started); }
        catch (error) { return result(false, undefined, Date.now() - started, { code: 'patch_failed', message: error instanceof Error ? error.message : '补丁失败' }); }
      },
    },
    {
      name: 'run_command', description: '在工作区内运行构建、测试或版本控制命令并流式返回输出；文件定位请优先使用 list_files、search_text 和 read_files', sideEffect: true, risk: 'high',
      parameters: z.object({ command: z.string().min(1), cwd: z.string().optional(), timeoutMs: z.number().int().min(1000).max(120000).optional() }),
      async execute(raw, context) { const args = raw as { command: string; cwd?: string; timeoutMs?: number }; try { const cwd = await new WorkspacePolicy(context.workspace).path(args.cwd); return await commandRunner(args.command, cwd, context, args.timeoutMs); } catch (error) { return result(false, undefined, 0, { code: 'command_denied', message: error instanceof Error ? error.message : '命令目录无效' }); } },
    },
    {
      name: 'git_diff', description: '查看当前工作区 Git Diff', sideEffect: false, risk: 'low',
      parameters: z.object({ path: z.string().optional() }),
      async execute(raw, context) { const args = raw as { path?: string }; const cwd = await new WorkspacePolicy(context.workspace).path('.'); const command = args.path ? `git diff -- ${JSON.stringify(args.path)}` : 'git diff -- .'; return commandRunner(command, cwd, context, 30_000); },
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
    {
      name: 'ask_user', description: '向用户提出一个结构化问题并暂停当前任务', sideEffect: false, risk: 'low',
      parameters: z.object({ question: z.string().min(1).max(2000), choices: z.array(z.string().min(1).max(200)).max(8).optional() }),
      async execute() { return result(false, undefined, 0, { code: 'ask_user_unhandled', message: 'ask_user 必须由 Agent Core 调度' }); },
    },
    {
      name: 'checkpoint', description: '创建一个用户可恢复的检查点', sideEffect: false, risk: 'low',
      parameters: z.object({}),
      async execute() { return result(false, undefined, 0, { code: 'checkpoint_unhandled', message: 'checkpoint 必须由 Agent Core 调度' }); },
    },
    {
      name: 'review_changes', description: '启动只读代码变更审查', sideEffect: false, risk: 'low',
      parameters: z.object({ scope: z.string().max(100).optional() }),
      async execute() { return result(false, undefined, 0, { code: 'review_unhandled', message: 'review_changes 必须由 Agent Core 调度' }); },
    },
    {
      name: 'compact_context', description: '主动压缩历史上下文并保留任务摘要', sideEffect: false, risk: 'low',
      parameters: z.object({}),
      async execute() { return result(true, { compacted: true }, 0); },
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
