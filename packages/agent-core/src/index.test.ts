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
      await new Promise((resolve) => setTimeout(resolve, 30));
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
});
