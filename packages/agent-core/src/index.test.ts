import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeModelProvider } from '@seecoder/model';
import { SessionStore } from '@seecoder/storage';
import { ToolRegistry } from '@seecoder/tools';
import { AgentCore } from './index';

const model = { baseUrl: 'http://fake', model: 'fake', apiKeyEnv: 'UNUSED', contextWindow: 20_000, temperature: 0, maxOutputTokens: 2000 };

describe('AgentCore', () => {
  it('runs a tool turn and reaches completed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-core-'));
    try {
      await writeFile(join(root, 'hello.txt'), 'hello', 'utf8');
      const provider = new FakeModelProvider([
        [
          { type: 'toolCallDelta', callId: 'call-1', name: 'list_files', argsDelta: '{"path":"."}' },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
        [{ type: 'textDelta', text: '我已检查工作区。' }, { type: 'completed', finishReason: 'stop' }],
      ]);
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), registry: new ToolRegistry(), mode: 'auto' });
      const events: string[] = [];
      const wait = new Promise<void>((resolve) => core.onEvent((event) => { events.push(event.type); if (event.type === 'turn.completed') resolve(); }));
      const thread = await core.createThread('测试');
      await core.startTurn(thread.id, '查看项目');
      await wait;
      expect(events).toContain('tool.completed');
      expect(events).toContain('message.completed');
      expect(events).toContain('turn.completed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('waits for and applies approval before writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-approval-'));
    try {
      const provider = new FakeModelProvider([
        [{ type: 'toolCallDelta', callId: 'write-1', name: 'write_file', argsDelta: '{"path":"new.txt","content":"ok"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'textDelta', text: '已写入。' }, { type: 'completed', finishReason: 'stop' }],
      ]);
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'guided' });
      const approvals: string[] = []; const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'approval.requested') approvals.push(event.approval.id); if (event.type === 'turn.completed') resolve(); }));
      const thread = await core.createThread('审批测试'); await core.startTurn(thread.id, '写文件');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(approvals).toHaveLength(1);
      await core.resolveApproval(approvals[0]!, 'allow'); await completed;
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('cancels a turn waiting for approval without leaving a zombie task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-cancel-'));
    try {
      const provider = new FakeModelProvider([
        [{ type: 'toolCallDelta', callId: 'cancel-write', name: 'write_file', argsDelta: '{"path":"blocked.txt","content":"no"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'textDelta', text: '已重新开始。' }, { type: 'completed', finishReason: 'stop' }],
      ]);
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'guided' });
      let turnId = '';
      const approval = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'approval.requested') resolve(); }));
      const cancelled = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.cancelled') resolve(); }));
      const thread = await core.createThread('取消审批');
      turnId = await core.startTurn(thread.id, '写文件');
      await approval;
      await expect(core.startTurn(thread.id, '并发任务')).rejects.toThrow('已有执行中的 Turn');
      core.cancelTurn(turnId);
      await cancelled;
      await expect(readFile(join(root, 'blocked.txt'), 'utf8')).rejects.toThrow();
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
      await expect(core.startTurn(thread.id, '取消后可再次执行')).resolves.toBeTypeOf('string');
      await completed;
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('can restore a recorded ChangeSet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-revert-'));
    try {
      await writeFile(join(root, 'a.txt'), 'before', 'utf8');
      const provider = new FakeModelProvider([
        [{ type: 'toolCallDelta', callId: 'write-restore', name: 'write_file', argsDelta: '{"path":"a.txt","content":"after"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'textDelta', text: '完成' }, { type: 'completed', finishReason: 'stop' }],
      ]);
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      let changeSetId = '';
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'changes.created') changeSetId = event.changeSet.id; if (event.type === 'turn.completed') resolve(); }));
      const thread = await core.createThread('撤销测试'); await core.startTurn(thread.id, '修改文件'); await completed;
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('after');
      expect((await core.revertChangeSet(changeSetId)).ok).toBe(true);
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('before');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('blocks side effects in Plan mode and preserves assistant tool calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-plan-'));
    try {
      const provider = new FakeModelProvider([
        [{ type: 'toolCallDelta', callId: 'plan-write', name: 'write_file', argsDelta: '{"path":"blocked.txt","content":"nope"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'textDelta', text: '计划已完成，等待批准。' }, { type: 'completed', finishReason: 'stop' }],
      ]);
      const store = new SessionStore(join(root, '.sessions'));
      const core = new AgentCore({ workspace: root, provider, model, store, mode: 'plan' });
      const results: string[] = [];
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'tool.completed') results.push(event.result.error?.code ?? 'ok'); if (event.type === 'turn.completed') resolve(); }));
      const thread = await core.createThread('Plan 只读');
      await core.startTurn(thread.id, '请不要写文件');
      await completed;
      await expect(readFile(join(root, 'blocked.txt'), 'utf8')).rejects.toThrow();
      expect(results).toContain('plan_read_only');
      const history = await store.readEvents(thread.id);
      expect(history.some((record) => record.item?.kind === 'assistant_message' && record.item.toolCalls?.[0]?.id === 'plan-write')).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('detects checkpoint conflicts before restoring files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-checkpoint-'));
    try {
      await writeFile(join(root, 'a.txt'), 'before', 'utf8');
      const provider = new FakeModelProvider([
        [{ type: 'toolCallDelta', callId: 'checkpoint-write', name: 'write_file', argsDelta: '{"path":"a.txt","content":"after"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'textDelta', text: '完成' }, { type: 'completed', finishReason: 'stop' }],
      ]);
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      let checkpointId = '';
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'checkpoint.created') checkpointId = event.checkpoint.id; if (event.type === 'turn.completed') resolve(); }));
      const thread = await core.createThread('冲突检查'); await core.startTurn(thread.id, '修改文件'); await completed;
      await writeFile(join(root, 'a.txt'), '外部修改', 'utf8');
      const result = await core.restoreCheckpoint(checkpointId);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('checkpoint_conflict');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('isolates threads by workspace after a workspace switch', async () => {
    const rootA = await mkdtemp(join(tmpdir(), 'seecoder-workspace-a-'));
    const rootB = await mkdtemp(join(tmpdir(), 'seecoder-workspace-b-'));
    const store = new SessionStore(join(tmpdir(), `seecoder-shared-${Date.now()}`));
    try {
      const coreA = new AgentCore({ workspace: rootA, provider: new FakeModelProvider([]), model, store, mode: 'plan' });
      const threadA = await coreA.createThread('A');
      const coreB = new AgentCore({ workspace: rootB, provider: new FakeModelProvider([]), model, store, mode: 'plan' });
      expect(await coreB.listThreads()).toEqual([]);
      expect(await coreB.hydrateThread(threadA.id)).toBeNull();
      expect(await coreB.readThreadEvents(threadA.id)).toEqual([]);
    } finally {
      await rm(rootA, { recursive: true, force: true });
      await rm(rootB, { recursive: true, force: true });
    }
  });

  it('persists an explicit context compaction and reports token reduction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-compact-'));
    try {
      const textTurn = (index: number) => [{ type: 'textDelta' as const, text: `第 ${index} 轮 ${'上下文'.repeat(200)}` }, { type: 'completed' as const, finishReason: 'stop' }];
      const provider = new FakeModelProvider([
        ...Array.from({ length: 5 }, (_, index) => textTurn(index)),
        [{ type: 'toolCallDelta', callId: 'compact-now', name: 'compact_context', argsDelta: '{}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'textDelta', text: '上下文已整理。' }, { type: 'completed', finishReason: 'stop' }],
      ]);
      const store = new SessionStore(join(root, '.sessions'));
      const core = new AgentCore({ workspace: root, provider, model, store, mode: 'auto' });
      const thread = await core.createThread('压缩测试');
      const run = async (prompt: string) => {
        const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
        await core.startTurn(thread.id, prompt);
        await completed;
      };
      for (let index = 0; index < 5; index += 1) await run(`用户任务 ${index} ${'内容'.repeat(200)}`);
      let metrics: { compacted?: boolean; beforeTokens?: number; afterTokens?: number } = {};
      const unsubscribe = core.onEvent((event) => {
        if (event.type === 'tool.completed' && event.callId === 'compact-now') metrics = event.result.output as typeof metrics;
      });
      await run('请主动压缩上下文');
      unsubscribe();
      expect(metrics.compacted).toBe(true);
      expect(metrics.afterTokens).toBeLessThan(metrics.beforeTokens!);
      const history = await store.readEvents(thread.id);
      expect(history.some((record) => record.item?.kind === 'compaction')).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not replay a side effect when a model repeats the same call id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-idempotent-'));
    try {
      const repeated = [{ type: 'toolCallDelta' as const, callId: 'same-write', name: 'write_file', argsDelta: '{"path":"once.txt","content":"once"}' }, { type: 'completed' as const, finishReason: 'tool_calls' }];
      const provider = new FakeModelProvider([repeated, repeated, [{ type: 'textDelta', text: '完成' }, { type: 'completed', finishReason: 'stop' }]]);
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      let executionCount = 0;
      let executionResult: boolean | undefined;
      let executionError = '';
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'tool.completed' && event.callId === 'same-write') { executionCount += 1; executionResult = event.result.ok; executionError = event.result.error?.message ?? ''; } if (event.type === 'turn.completed') resolve(); }));
      const thread = await core.createThread('幂等测试');
      await core.startTurn(thread.id, '只写一次');
      await completed;
      expect(executionCount).toBe(1);
      expect(executionResult, executionError).toBe(true);
      expect(await readFile(join(root, 'once.txt'), 'utf8')).toBe('once');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
