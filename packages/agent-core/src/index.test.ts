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
});
