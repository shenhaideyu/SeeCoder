import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRegistry, WorkspacePolicy } from './index';

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
  });
});

describe('file tools', () => {
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
});
