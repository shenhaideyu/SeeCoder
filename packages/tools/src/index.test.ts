import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandRisk, commandRunner, ToolRegistry, WorkspacePolicy } from './index';

describe('WorkspacePolicy', () => {
  it('rejects paths outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-policy-'));
    try {
      const policy = new WorkspacePolicy(root);
      await expect(policy.path('../secret.txt')).rejects.toThrow('越出工作区');
      expect(policy.isInside(join(root, 'src', 'main.ts'))).toBe(true);
      expect(policy.isInside(join(root, '..', 'secret.txt'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not expose credential files to tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-secret-'));
    try {
      await writeFile(join(root, '.env'), 'API_KEY=do-not-read', 'utf8');
      const registry = new ToolRegistry();
      const listed = await registry.get('list_files')!.execute({ path: '.', depth: 2 }, { workspace: root });
      expect(listed.output).not.toContain('.env');
      const read = await registry.get('read_file')!.execute({ path: '.env' }, { workspace: root });
      expect(read.ok).toBe(false);
      expect(read.error?.message).toContain('凭据');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('auto approves only safe workspace actions', () => {
    const policy = new WorkspacePolicy('C:/workspace');
    expect(policy.canAutoApprove({ id: '1', name: 'read_file', args: { path: 'a.ts' } }, 'auto')).toBe(true);
    expect(policy.canAutoApprove({ id: '1b', name: 'read_file', args: { path: 'a.ts' } }, 'guided')).toBe(true);
    expect(policy.canAutoApprove({ id: '2', name: 'run_command', args: { command: 'pnpm test', cwd: '.' } }, 'auto')).toBe(true);
    expect(policy.canAutoApprove({ id: '3', name: 'run_command', args: { command: 'Remove-Item -Recurse .git', cwd: '.' } }, 'auto')).toBe(false);
    expect(policy.canAutoApprove({ id: '4', name: 'write_file', args: { path: 'a.ts' } }, 'guided')).toBe(false);
    expect(policy.canAutoApprove({ id: '5', name: 'apply_patch', args: { patch: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch' } }, 'auto')).toBe(true);
    expect(policy.canAutoApprove({ id: '6', name: 'apply_patch', args: { patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new' } }, 'auto')).toBe(true);
    expect(policy.canAutoApprove({ id: '7', name: 'apply_patch', args: { patch: '*** Begin Patch\n*** Update File: ../outside.ts\n@@\n-old\n+new\n*** End Patch' } }, 'auto')).toBe(false);
  });
});

describe('file tools', () => {
  it('keeps dependency, cache, and build directories out of project traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-list-clean-'));
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'main.ts'), 'export {}', 'utf8');
      for (const directory of ['.venv', '__pycache__', '.pytest_cache', 'node_modules', 'builds', 'generated']) {
        await mkdir(join(root, directory), { recursive: true });
        await writeFile(join(root, directory, 'noise.txt'), 'noise', 'utf8');
      }
      const output = await new ToolRegistry().get('list_files')!.execute({ path: '.', depth: 3 }, { workspace: root });
      expect(output).toMatchObject({ ok: true });
      expect((output.output as string[]).map((path) => path.replace(/\\/g, '/'))).toEqual(['src/main.ts']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('labels read-only and test commands without presenting them as high risk', () => {
    expect(commandRisk('git log --oneline -15')).toBe('low');
    expect(commandRisk('pnpm test:unit')).toBe('low');
    expect(commandRisk('node --test frontend/tests/')).toBe('low');
    expect(commandRisk('node --version; node --test frontend/tests/agentStatus.test.mjs 2>&1 | Out-String')).toBe('low');
    expect(commandRisk('Get-ChildItem tests')).toBe('medium');
    expect(commandRisk('git push origin main')).toBe('high');
  });

  it('stops a workspace search when the task is cancelled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-search-cancel-'));
    try {
      const controller = new AbortController();
      controller.abort();
      const tool = new ToolRegistry().get('search_text');
      await expect(tool!.execute({ query: 'anything' }, { workspace: root, signal: controller.signal })).rejects.toThrow('操作已取消');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('searches project text without exposing credential files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-search-'));
    try {
      await writeFile(join(root, 'public.txt'), 'needle in public code', 'utf8');
      await writeFile(join(root, '.env'), 'needle=private', 'utf8');
      const output = await new ToolRegistry().get('search_text')!.execute({ query: 'needle' }, { workspace: root });
      expect(output.ok).toBe(true);
      expect(output.output).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'public.txt' })]));
      expect(JSON.stringify(output.output)).not.toContain('.env');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('treats a file path as a valid list and search target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-file-target-'));
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'entry.ts'), 'const marker = "needle";\n', 'utf8');
      const registry = new ToolRegistry();
      const listed = await registry.get('list_files')!.execute({ path: 'src/entry.ts' }, { workspace: root });
      const searched = await registry.get('search_text')!.execute({ query: 'needle', path: 'src/entry.ts' }, { workspace: root });
      expect(listed.ok).toBe(true);
      expect((listed.output as string[])[0]?.replace(/\\/g, '/')).toBe('src/entry.ts');
      expect(searched).toMatchObject({ ok: true, output: [expect.objectContaining({ line: 1, text: expect.stringContaining('needle') })] });
      const missing = await registry.get('search_text')!.execute({ query: 'needle', path: 'missing.ts' }, { workspace: root });
      expect(missing).toMatchObject({ ok: false, error: { code: 'search_failed' } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('writes atomically and returns a change record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-tools-'));
    try {
      await writeFile(join(root, 'a.txt'), 'before', 'utf8');
      const tool = new ToolRegistry().get('write_file');
      expect(tool).toBeDefined();
      const output = await tool!.execute({ path: 'a.txt', content: 'after' }, { workspace: root });
      expect(output.ok).toBe(true);
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('after');
      expect(output.output).toMatchObject({ kind: 'changes', files: [{ path: 'a.txt', before: 'before', after: 'after' }] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('creates a new file below a canonicalized Windows workspace path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-new-file-'));
    try {
      const tool = new ToolRegistry().get('write_file');
      const output = await tool!.execute({ path: 'src/new.txt', content: 'created' }, { workspace: root });
      expect(output.ok).toBe(true);
      expect(await readFile(join(root, 'src', 'new.txt'), 'utf8')).toBe('created');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('applies a unified patch and rejects stale context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-patch-'));
    try {
      await writeFile(join(root, 'a.txt'), 'one\ntwo\n', 'utf8');
      const tool = new ToolRegistry().get('apply_patch');
      const patch = ['--- a/a.txt', '+++ b/a.txt', '@@ -1,2 +1,2 @@', ' one', '-two', '+changed', ''].join('\n');
      const output = await tool!.execute({ patch }, { workspace: root });
      expect(output.ok).toBe(true);
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\nchanged\n');
      const stale = ['--- a/a.txt', '+++ b/a.txt', '@@ -1,2 +1,2 @@', ' one', '-wrong', '+bad', ''].join('\n');
      const rejected = await tool!.execute({ patch: stale }, { workspace: root });
      expect(rejected.ok).toBe(false);
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\nchanged\n');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('applies the Codex patch format emitted by compatible coding models', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-codex-patch-'));
    try {
      await writeFile(join(root, 'a.txt'), 'header\none\ntwo\nfooter\n', 'utf8');
      const tool = new ToolRegistry().get('apply_patch')!;
      const patch = ['*** Begin Patch', '*** Update File: a.txt', '@@', ' one', '-two', '+changed', '*** End Patch'].join('\n');
      const output = await tool.execute({ patch }, { workspace: root });
      expect(output.ok).toBe(true);
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('header\none\nchanged\nfooter\n');

      const stale = ['*** Begin Patch', '*** Update File: a.txt', '@@', ' missing', '-old', '+bad', '*** End Patch'].join('\n');
      const rejected = await tool.execute({ patch: stale }, { workspace: root });
      expect(rejected).toMatchObject({ ok: false, error: { code: 'patch_failed' } });
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('header\none\nchanged\nfooter\n');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('preserves stdout, stderr and exit code when a command fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-command-failure-'));
    try {
      const output = await commandRunner(
        `node -e "console.log('visible-output'); console.error('visible-diagnostic'); process.exit(3)"`,
        root,
        { workspace: root },
      );
      expect(output).toMatchObject({
        ok: false,
        error: { code: 'command_failed' },
      });
      const diagnostic = output.output as { exitCode: number; stdout: string; stderr: string };
      expect(diagnostic.exitCode).not.toBe(0);
      expect(diagnostic.stdout).toContain('visible-output');
      expect(`${diagnostic.stdout}\n${diagnostic.stderr}`).toContain('visible-diagnostic');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('applies a uniquely matching shifted hunk and preserves CRLF line endings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-patch-crlf-'));
    try {
      await writeFile(join(root, 'a.txt'), 'zero\r\none\r\ntwo\r\nthree\r\n', 'utf8');
      const tool = new ToolRegistry().get('apply_patch');
      const patch = ['--- a/a.txt', '+++ b/a.txt', '@@ -1,2 +1,2 @@', ' one', '-two', '+changed', ''].join('\n');
      const output = await tool!.execute({ patch }, { workspace: root });
      expect(output.ok).toBe(true);
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('zero\r\none\r\nchanged\r\nthree\r\n');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('limits git diff to the selected workspace inside a parent repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-git-scope-'));
    const workspace = join(root, 'project');
    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(join(root, 'outside.txt'), 'before', 'utf8');
      await writeFile(join(workspace, 'inside.txt'), 'before', 'utf8');
      expect((await commandRunner('git init', root, { workspace: root })).ok).toBe(true);
      expect((await commandRunner('git add -A', root, { workspace: root })).ok).toBe(true);
      await writeFile(join(root, 'outside.txt'), 'outside change', 'utf8');
      await writeFile(join(workspace, 'inside.txt'), 'inside change', 'utf8');
      const output = await new ToolRegistry().get('git_diff')!.execute({}, { workspace });
      const stdout = (output.output as { stdout?: string } | undefined)?.stdout ?? '';
      expect(output.ok).toBe(true);
      expect(stdout).toContain('inside change');
      expect(stdout).not.toContain('outside change');
      expect(stdout).not.toContain('outside.txt');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
