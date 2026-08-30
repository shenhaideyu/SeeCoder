import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeModelProvider } from '@seecoder/model';
import type { HookStage, ModelEvent, ModelProvider, ModelRequest } from '@seecoder/protocol';
import { SessionStore } from '@seecoder/storage';
import { ToolRegistry } from '@seecoder/tools';
import { AgentCore, type HookRuntime } from './index';

const model = { baseUrl: 'http://fake', model: 'fake', apiKeyEnv: 'UNUSED', contextWindow: 20_000, temperature: 0, maxOutputTokens: 2000 };

class RecordingProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  private cursor = 0;
  constructor(private readonly turns: ModelEvent[][]) {}
  get agentRequests(): ModelRequest[] { return this.requests.filter((request) => request.purpose !== 'context_summary'); }
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(request));
    if (request.purpose === 'context_summary') {
      yield { type: 'textDelta', text: JSON.stringify({ userIntent: '', requirements: [], activeDecisions: [], supersededDecisions: [], completedWork: [], unresolvedQuestions: [], narrative: '测试摘要' }) };
      yield { type: 'completed', finishReason: 'stop' };
      return;
    }
    const events = this.turns[Math.min(this.cursor++, this.turns.length - 1)] ?? [];
    for (const event of events) yield event;
  }
}

describe('AgentCore', () => {
  it('runs trusted hooks at tool, file edit and turn end lifecycle points', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-hooks-'));
    try {
      const stages: HookStage[] = [];
      const hooks: HookRuntime = {
        async resolve(stage) { return [{ id: `${stage}-hook`, command: 'test', timeoutMs: 1000 }]; },
        async execute(_command, context) { stages.push(context.stage); return { ok: true, durationMs: 1 }; },
      };
      const provider = new FakeModelProvider([
        [{ type: 'toolCallDelta', callId: 'write-hooked', name: 'write_file', argsDelta: '{"path":"hooked.txt","content":"ok"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'toolCallDelta', callId: 'finish-hooked', name: 'finish', argsDelta: '{"summary":"完成","verification":[]}' }, { type: 'completed', finishReason: 'tool_calls' }],
      ]);
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto', hooks });
      const events: string[] = [];
      const ended = new Promise<void>((resolve) => core.onEvent((event) => { events.push(event.type); if (event.type === 'hook.completed' && event.stage === 'turnEnd') resolve(); }));
      const session = await core.createSession('Hooks 生命周期');
      await core.startTurn(session.id, '写入并完成');
      await ended;
      expect(stages).toEqual(['preToolUse', 'postFileEdit', 'preToolUse', 'turnEnd']);
      expect(events.filter((event) => event === 'hook.started')).toHaveLength(4);
      expect(await readFile(join(root, 'hooked.txt'), 'utf8')).toBe('ok');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('blocks a tool when preToolUse fails without damaging the turn state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-hook-block-'));
    try {
      const hooks: HookRuntime = {
        async resolve(stage) { return stage === 'preToolUse' ? [{ id: 'guard', command: 'guard', timeoutMs: 1000 }] : []; },
        async execute() { return { ok: false, durationMs: 1, error: { code: 'command_failed', message: 'guard rejected' } }; },
      };
      const provider = new FakeModelProvider([
        [{ type: 'toolCallDelta', callId: 'blocked-write', name: 'write_file', argsDelta: '{"path":"blocked.txt","content":"bad"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'textDelta', text: '已停止写入。' }, { type: 'completed', finishReason: 'stop' }],
      ]);
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto', hooks });
      let blockedCode = '';
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'tool.completed' && event.callId === 'blocked-write') blockedCode = event.result.error?.code ?? ''; if (event.type === 'turn.completed') resolve(); }));
      const session = await core.createSession('Hook 阻止');
      await core.startTurn(session.id, '不要让 guard 失败');
      await completed;
      expect(blockedCode).toBe('hook_blocked');
      await expect(readFile(join(root, 'blocked.txt'), 'utf8')).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('streams text live but persists only the completed assistant message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-stream-storage-'));
    try {
      const store = new SessionStore(join(root, '.sessions'));
      const provider = new RecordingProvider([[
        { type: 'textDelta', text: '第一段' },
        { type: 'textDelta', text: '第二段' },
        { type: 'completed', finishReason: 'stop' },
      ]]);
      const core = new AgentCore({ workspace: root, provider, model, store, mode: 'auto' });
      const live: string[] = [];
      const completed = new Promise<void>((resolve) => core.onEvent((event) => {
        if (event.type === 'message.delta') live.push(event.text);
        if (event.type === 'turn.completed') resolve();
      }));
      const session = await core.createSession('流式持久化');
      await core.startTurn(session.id, '回复我');
      await completed;

      expect(live).toEqual(['第一段', '第二段']);
      const history = await store.readEvents(session.id);
      expect(history.some((record) => record.event.type === 'message.delta')).toBe(false);
      expect(history.some((record) => record.event.type === 'message.completed')).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('asks the model to keep natural tasks concise and avoid serial reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-efficient-prompt-'));
    try {
      const provider = new RecordingProvider([[{ type: 'textDelta', text: '完成' }, { type: 'completed', finishReason: 'stop' }]]);
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), registry: new ToolRegistry(), mode: 'plan' });
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
      const session = await core.createSession('自然任务');
      await core.startTurn(session.id, '后端从哪里启动？请用几句话说明。');
      await completed;
      const system = provider.requests[0]?.messages[0]?.content;
      expect(system).toContain('严格匹配用户要求的回答长度');
      expect(system).toContain('一次调用 read_files');
      expect(system).toContain('证据足以回答或实施就停止探索');
      expect(system).toContain('所有用户可见的行动说明、计划、问题、错误解释和最终总结必须使用简体中文');
      const setPlan = provider.requests[0]?.tools.find((tool) => tool.function.name === 'set_plan');
      expect(setPlan?.function.parameters).toMatchObject({
        properties: { steps: { items: { required: ['id', 'label', 'status'] } } },
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('injects an explicitly activated local skill below safety rules and records activation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-skill-prompt-'));
    try {
      const provider = new RecordingProvider([[{ type: 'textDelta', text: '已完成' }, { type: 'completed', finishReason: 'stop' }]]);
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'plan' });
      const events: string[] = [];
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { events.push(event.type); if (event.type === 'turn.completed') resolve(); }));
      const session = await core.createSession('Skill 测试');
      await core.startTurn(session.id, '请检查项目结构', undefined, [], {
        skill: { id: 'seecoder:project-review', name: 'project-review', description: '项目审查', relativePath: '.seecoder/skills/project-review/SKILL.md' },
        content: '先读取入口文件，再用中文给出三点结论。',
      });
      await completed;
      expect(provider.agentRequests[0]?.messages[0]?.content).toContain('[本轮已激活 Skill：project-review');
      expect(provider.agentRequests[0]?.messages[0]?.content).toContain('先读取入口文件');
      expect(events).toContain('skill.activated');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('deletes an idle session but rejects deletion while its turn is active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-delete-session-'));
    try {
      const provider: ModelProvider = { async *stream() { await new Promise((resolve) => setTimeout(resolve, 100)); yield { type: 'textDelta', text: '完成' }; yield { type: 'completed', finishReason: 'stop' }; } };
      const store = new SessionStore(join(root, '.sessions'));
      const core = new AgentCore({ workspace: root, provider, model, store, mode: 'plan' });
      const session = await core.createSession('待删除');
      const turnId = await core.startTurn(session.id, '执行中');
      await expect(core.deleteSession(session.id)).rejects.toThrow('运行中的任务不能删除');
      core.cancelTurn(turnId);
      await new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.cancelled') resolve(); }));
      await core.deleteSession(session.id);
      expect(await store.readSession(session.id)).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

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
      const session = await core.createSession('测试');
      await core.startTurn(session.id, '查看项目');
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
      const session = await core.createSession('审批测试'); await core.startTurn(session.id, '写文件');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(approvals).toHaveLength(1);
      await core.resolveApproval(approvals[0]!, 'allow'); await completed;
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not treat a truncated model response as task completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-output-limit-'));
    try {
      const provider = new RecordingProvider([
        [{ type: 'textDelta', text: '未完成的长响应' }, { type: 'completed', finishReason: 'length' }],
        [{ type: 'textDelta', text: '已恢复并完成' }, { type: 'completed', finishReason: 'stop' }],
      ]);
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
      const session = await core.createSession('截断恢复');
      await core.startTurn(session.id, '完成一个任务');
      await completed;

      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[1]!.messages.some((message) => String(message.content).includes('上一响应达到输出上限'))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('adds one convergence reminder before the final three model iterations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-convergence-'));
    try {
      const planningTurns = Array.from({ length: 21 }, (_, index) => [
        {
          type: 'toolCallDelta' as const,
          callId: `plan-${index}`,
          name: 'set_plan',
          argsDelta: JSON.stringify({ steps: [{ id: 'finish', label: '完成剩余工作', status: 'running' }] }),
        },
        { type: 'completed' as const, finishReason: 'tool_calls' },
      ]);
      const provider = new RecordingProvider([
        ...planningTurns,
        [{ type: 'textDelta', text: '已收敛完成' }, { type: 'completed', finishReason: 'stop' }],
      ]);
      const core = new AgentCore({
        workspace: root,
        provider,
        model: { ...model, contextWindow: 200_000 },
        store: new SessionStore(join(root, '.sessions')),
        mode: 'auto',
      });
      const completed = new Promise<void>((resolve) => core.onEvent((event) => {
        if (event.type === 'turn.completed') resolve();
      }));
      const session = await core.createSession('长任务收敛');
      await core.startTurn(session.id, '完成一个长任务');
      await completed;

      const reminder = '[迭代预算提醒]';
      expect(provider.agentRequests).toHaveLength(22);
      expect(provider.agentRequests[20]!.messages.some((message) => String(message.content).includes(reminder))).toBe(false);
      expect(provider.agentRequests[21]!.messages.filter((message) => String(message.content).includes(reminder))).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('turns repeated exploration into a bounded tool result instead of an endless read loop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-exploration-budget-'));
    try {
      await writeFile(join(root, 'evidence.txt'), 'evidence', 'utf8');
      const reads = Array.from({ length: 8 }, (_, index) => [
        { type: 'toolCallDelta' as const, callId: `read-${index}`, name: 'read_file', argsDelta: '{"path":"evidence.txt"}' },
        { type: 'completed' as const, finishReason: 'tool_calls' },
      ]);
      const provider = new RecordingProvider([
        ...reads,
        [{ type: 'toolCallDelta', callId: 'plan-after-budget', name: 'set_plan', argsDelta: '{"steps":[{"id":"fix","label":"实施最小修复","status":"running"}]}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'toolCallDelta', callId: 'read-after-plan', name: 'read_file', argsDelta: '{"path":"evidence.txt"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'toolCallDelta', callId: 'write-after-budget', name: 'write_file', argsDelta: '{"path":"fixed.txt","content":"fixed"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'textDelta', text: '已修复并验证' }, { type: 'completed', finishReason: 'stop' }],
      ]);
      const core = new AgentCore({ workspace: root, provider, model: { ...model, contextWindow: 200_000 }, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      const errors: string[] = [];
      const completed = new Promise<void>((resolve) => core.onEvent((event) => {
        if (event.type === 'tool.completed' && event.result.error) errors.push(event.result.error.code);
        if (event.type === 'turn.completed') resolve();
      }));
      const session = await core.createSession('探索预算');
      await core.startTurn(session.id, '定位后做最小修复');
      await completed;

      expect(errors).toContain('exploration_budget_exhausted');
      expect(errors.filter((code) => code === 'exploration_budget_exhausted')).toHaveLength(2);
      expect(await readFile(join(root, 'fixed.txt'), 'utf8')).toBe('fixed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('drops orphan tool messages when hydrating an interrupted legacy chain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-hydrate-chain-'));
    try {
      const store = new SessionStore(join(root, '.sessions'));
      const session = { id: 'legacy-session', title: '旧会话', workspacePath: root, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await store.saveSession(session);
      await store.append(session.id, {
        event: { type: 'context.compacted', timestamp: new Date().toISOString(), turnId: 'old-turn', sessionId: session.id, summary: '旧摘要' },
        item: { kind: 'compaction', id: 'old-item', summary: '旧摘要', messages: [
          { role: 'user', content: '原任务' },
          { role: 'tool', content: '{"ok":true}', toolCallId: 'orphan' },
        ], createdAt: new Date().toISOString() },
      });
      const provider = new RecordingProvider([[{ type: 'textDelta', text: '恢复完成' }, { type: 'completed', finishReason: 'stop' }]]);
      const core = new AgentCore({ workspace: root, provider, model, store, mode: 'auto' });
      await core.hydrateSession(session.id);
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
      await core.startTurn(session.id, '继续任务');
      await completed;

      expect(provider.requests[0]!.messages.some((message) => message.role === 'tool')).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('marks a persisted running turn as interrupted after process restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-interrupted-turn-'));
    try {
      const store = new SessionStore(join(root, '.sessions'));
      const timestamp = new Date().toISOString();
      const session = { id: 'interrupted-session', title: '中断任务', workspacePath: root, createdAt: timestamp, updatedAt: timestamp };
      const turn = { id: 'interrupted-turn', sessionId: session.id, status: 'running' as const, startedAt: timestamp, iteration: 3 };
      await store.saveSession(session);
      await store.append(session.id, { event: { type: 'turn.started', timestamp, sessionId: session.id, turn } });
      await store.append(session.id, { event: { type: 'model.requested', timestamp, sessionId: session.id, turnId: turn.id, iteration: 3 } });

      const core = new AgentCore({ workspace: root, provider: new FakeModelProvider([]), model, store, mode: 'auto' });
      await core.hydrateSession(session.id);
      await core.hydrateSession(session.id);
      const events = await store.readEvents(session.id);
      const interrupted = events.filter((record) => record.event.type === 'turn.failed' && record.event.error.code === 'interrupted');
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]!.event.type === 'turn.failed' && interrupted[0]!.event.turn.status).toBe('failed');
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
      const session = await core.createSession('取消审批');
      turnId = await core.startTurn(session.id, '写文件');
      await approval;
      await expect(core.startTurn(session.id, '并发任务')).rejects.toThrow('已有执行中的 Turn');
      core.cancelTurn(turnId);
      await cancelled;
      await expect(readFile(join(root, 'blocked.txt'), 'utf8')).rejects.toThrow();
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
      await expect(core.startTurn(session.id, '取消后可再次执行')).resolves.toBeTypeOf('string');
      await completed;
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not report an aborted model request as completed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-model-cancel-'));
    try {
      const provider: ModelProvider = {
        async *stream(_request, signal) {
          yield { type: 'textDelta', text: '处理中' };
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
        },
      };
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'plan' });
      const events: string[] = [];
      let streamedResolve!: () => void;
      const streamed = new Promise<void>((resolve) => { streamedResolve = resolve; });
      const cancelled = new Promise<void>((resolve) => core.onEvent((event) => { events.push(event.type); if (event.type === 'message.delta') streamedResolve(); if (event.type === 'turn.cancelled') resolve(); }));
      const session = await core.createSession('模型取消');
      const turnId = await core.startTurn(session.id, '开始长任务');
      await streamed;
      core.cancelTurn(turnId);
      await cancelled;
      expect(events).not.toContain('model.completed');
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
      const session = await core.createSession('撤销测试'); await core.startTurn(session.id, '修改文件'); await completed;
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
      const session = await core.createSession('Plan 只读');
      await core.startTurn(session.id, '请不要写文件');
      await completed;
      await expect(readFile(join(root, 'blocked.txt'), 'utf8')).rejects.toThrow();
      expect(results).toContain('plan_read_only');
      const history = await store.readEvents(session.id);
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
      const session = await core.createSession('冲突检查'); await core.startTurn(session.id, '修改文件'); await completed;
      await writeFile(join(root, 'a.txt'), '外部修改', 'utf8');
      const result = await core.restoreCheckpoint(checkpointId);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('checkpoint_conflict');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('isolates sessions by workspace after a workspace switch', async () => {
    const rootA = await mkdtemp(join(tmpdir(), 'seecoder-workspace-a-'));
    const rootB = await mkdtemp(join(tmpdir(), 'seecoder-workspace-b-'));
    const store = new SessionStore(join(tmpdir(), `seecoder-shared-${Date.now()}`));
    try {
      const coreA = new AgentCore({ workspace: rootA, provider: new FakeModelProvider([]), model, store, mode: 'plan' });
      const sessionA = await coreA.createSession('A');
      const coreB = new AgentCore({ workspace: rootB, provider: new FakeModelProvider([]), model, store, mode: 'plan' });
      expect(await coreB.listSessions()).toEqual([]);
      expect(await coreB.hydrateSession(sessionA.id)).toBeNull();
      expect(await coreB.readSessionEvents(sessionA.id)).toEqual([]);
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
      const session = await core.createSession('压缩测试');
      const run = async (prompt: string) => {
        const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
        await core.startTurn(session.id, prompt);
        await completed;
      };
      for (let index = 0; index < 5; index += 1) await run(`用户任务 ${index} ${'内容'.repeat(200)}`);
      let metrics: { compacted?: boolean; beforeTokens?: number; afterTokens?: number } = {};
      const unsubscribe = core.onEvent((event) => {
        if (event.type === 'context.compacted' && event.metrics) metrics = event.metrics;
      });
      await run('请主动压缩上下文');
      unsubscribe();
      expect(metrics.compacted).toBe(true);
      expect(metrics.afterTokens).toBeLessThan(metrics.beforeTokens!);
      const history = await store.readEvents(session.id);
      expect(history.some((record) => record.item?.kind === 'compaction')).toBe(true);

      const restoredProvider = new RecordingProvider([[{ type: 'textDelta', text: '恢复完成' }, { type: 'completed', finishReason: 'stop' }]]);
      const restored = new AgentCore({ workspace: root, provider: restoredProvider, model, store, mode: 'auto' });
      await restored.hydrateSession(session.id);
      const restoredCompleted = new Promise<void>((resolve) => restored.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
      await restored.startTurn(session.id, '恢复后继续');
      await restoredCompleted;
      const restoredMessages = restoredProvider.agentRequests[0]?.messages ?? [];
      const serialized = JSON.stringify(restoredMessages);
      expect(serialized).toContain('[历史压缩摘要]');
      expect(serialized).toContain('上下文摘要');
      const compactCallIndex = restoredMessages.findIndex((message) => message.role === 'assistant' && message.toolCalls?.some((call) => call.id === 'compact-now'));
      const compactResultIndex = restoredMessages.findIndex((message) => message.role === 'tool' && message.toolCallId === 'compact-now');
      expect(compactCallIndex).toBeGreaterThanOrEqual(0);
      expect(compactResultIndex).toBeGreaterThan(compactCallIndex);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps multi-tool assistant calls intact during automatic compaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-tool-chain-'));
    try {
      await writeFile(join(root, 'large.txt'), 'x'.repeat(30_000), 'utf8');
      const toolTurn = (prefix: string) => [
        ...Array.from({ length: 4 }, (_, index) => ({ type: 'toolCallDelta' as const, callId: `${prefix}-${index}`, name: 'read_file', argsDelta: '{"path":"large.txt"}' })),
        { type: 'completed' as const, finishReason: 'tool_calls' },
      ];
      const provider = new RecordingProvider([
        toolTurn('first'),
        toolTurn('second'),
        [{ type: 'textDelta', text: '完成' }, { type: 'completed', finishReason: 'stop' }],
      ]);
      const compactModel = { ...model, contextWindow: 1_000 };
      const core = new AgentCore({ workspace: root, provider, model: compactModel, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
      const session = await core.createSession('多工具压缩');
      await core.startTurn(session.id, '读取大文件');
      await completed;

      const compactedRequest = provider.agentRequests[2]!.messages.slice(1);
      let pending = new Set<string>();
      for (const message of compactedRequest) {
        if (message.role === 'assistant') pending = new Set(message.toolCalls?.map((call) => call.id) ?? []);
        else if (message.role === 'tool') {
          expect(pending.has(message.toolCallId!)).toBe(true);
          pending.delete(message.toolCallId!);
          expect(String(message.content).length).toBeLessThan(16_000);
        } else pending.clear();
      }
      expect(compactedRequest.some((message) => message.role === 'tool')).toBe(true);
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
      const session = await core.createSession('幂等测试');
      await core.startTurn(session.id, '只写一次');
      await completed;
      expect(executionCount).toBe(1);
      expect(executionResult, executionError).toBe(true);
      expect(await readFile(join(root, 'once.txt'), 'utf8')).toBe('once');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('scopes repeated call ids to one turn instead of leaking results across turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-turn-call-scope-'));
    try {
      const provider = new FakeModelProvider([
        [{ type: 'toolCallDelta', callId: 'provider-reused-id', name: 'write_file', argsDelta: '{"path":"value.txt","content":"first"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'textDelta', text: '第一轮完成' }, { type: 'completed', finishReason: 'stop' }],
        [{ type: 'toolCallDelta', callId: 'provider-reused-id', name: 'write_file', argsDelta: '{"path":"value.txt","content":"second"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'textDelta', text: '第二轮完成' }, { type: 'completed', finishReason: 'stop' }],
      ]);
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      const session = await core.createSession('跨 Turn 幂等隔离');
      const run = async (prompt: string) => {
        const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
        await core.startTurn(session.id, prompt);
        await completed;
      };
      await run('写入 first');
      await run('写入 second');
      expect(await readFile(join(root, 'value.txt'), 'utf8')).toBe('second');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('preserves the assistant tool-call chain inside read-only subagents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-subagent-chain-'));
    try {
      await writeFile(join(root, 'evidence.txt'), 'evidence', 'utf8');
      const provider = new RecordingProvider([
        [{ type: 'toolCallDelta', callId: 'delegate-1', name: 'delegate', argsDelta: '{"role":"explore","task":"查找证据"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'toolCallDelta', callId: 'child-read-1', name: 'read_file', argsDelta: '{"path":"evidence.txt"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'textDelta', text: '子 Agent 找到证据。' }, { type: 'completed', finishReason: 'stop' }],
        [{ type: 'textDelta', text: '主任务完成。' }, { type: 'completed', finishReason: 'stop' }],
      ]);
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'plan' });
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
      const session = await core.createSession('子 Agent 消息链');
      await core.startTurn(session.id, '委派探索');
      await completed;
      const childFollowUp = provider.requests[2]!;
      expect(childFollowUp.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', toolCalls: [expect.objectContaining({ id: 'child-read-1', name: 'read_file' })] }),
        expect.objectContaining({ role: 'tool', toolCallId: 'child-read-1', toolName: 'read_file' }),
      ]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('falls back deterministically when semantic summarization fails without failing the turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-summary-fallback-'));
    try {
      const textTurn = (index: number) => [{ type: 'textDelta' as const, text: `历史 ${index} ${'内容'.repeat(220)}` }, { type: 'completed' as const, finishReason: 'stop' }];
      const provider = new FakeModelProvider([
        ...Array.from({ length: 5 }, (_, index) => textTurn(index)),
        [{ type: 'toolCallDelta', callId: 'compact-fallback', name: 'compact_context', argsDelta: '{}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'textDelta', text: '降级后仍完成' }, { type: 'completed', finishReason: 'stop' }],
      ], [[{ type: 'error', code: 'network_error', message: '摘要服务不可用', retryable: true }]]);
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      const events: string[] = [];
      const session = await core.createSession('摘要失败降级');
      const run = async (prompt: string) => {
        const completed = new Promise<void>((resolve) => core.onEvent((event) => { events.push(event.type); if (event.type === 'turn.completed') resolve(); }));
        await core.startTurn(session.id, prompt);
        await completed;
      };
      for (let index = 0; index < 5; index += 1) await run(`用户历史 ${index}`);
      await run('压缩后继续');
      expect(events).toContain('context.summary.failed');
      expect(events).toContain('context.compacted');
      expect(events.at(-1)).toBe('turn.completed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('warns when finish follows a newer change than the latest successful validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-stale-validation-'));
    try {
      const provider = new FakeModelProvider([
        [{ type: 'toolCallDelta', callId: 'write-before-test', name: 'write_file', argsDelta: '{"path":"value.txt","content":"one"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'toolCallDelta', callId: 'test-revision-1', name: 'run_command', argsDelta: '{"command":"node --test"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'toolCallDelta', callId: 'write-after-test', name: 'write_file', argsDelta: '{"path":"value.txt","content":"two"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'toolCallDelta', callId: 'finish-stale', name: 'finish', argsDelta: '{"summary":"完成","verification":["node --test"]}' }, { type: 'completed', finishReason: 'tool_calls' }],
      ]);
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      let finishOutput: unknown;
      const completed = new Promise<void>((resolve) => core.onEvent((event) => {
        if (event.type === 'tool.completed' && event.callId === 'finish-stale') finishOutput = event.result.output;
        if (event.type === 'turn.completed') resolve();
      }));
      const session = await core.createSession('验证 revision');
      await core.startTurn(session.id, '修改、测试、再次修改后完成');
      await completed;
      expect(finishOutput).toMatchObject({ verificationStatus: 'warning', warning: expect.stringContaining('没有成功验证') });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('cancels an in-flight summary request and leaves no active turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-cancel-summary-'));
    try {
      const scripted = [
        ...Array.from({ length: 5 }, (_, index) => [{ type: 'textDelta' as const, text: `历史 ${index} ${'内容'.repeat(220)}` }, { type: 'completed' as const, finishReason: 'stop' }]),
        [{ type: 'toolCallDelta' as const, callId: 'compact-cancel', name: 'compact_context', argsDelta: '{}' }, { type: 'completed' as const, finishReason: 'tool_calls' }],
      ];
      let cursor = 0;
      const provider: ModelProvider = {
        async *stream(request, signal) {
          if (request.purpose === 'context_summary') {
            if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
            yield { type: 'error', code: 'cancelled', message: '摘要已取消', retryable: false };
            return;
          }
          for (const event of scripted[Math.min(cursor++, scripted.length - 1)] ?? []) yield event;
        },
      };
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      const session = await core.createSession('取消摘要');
      const run = async (prompt: string) => {
        const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
        await core.startTurn(session.id, prompt);
        await completed;
      };
      for (let index = 0; index < 5; index += 1) await run(`历史 ${index}`);
      let turnId = '';
      const cancelled = new Promise<void>((resolve) => core.onEvent((event) => {
        if (event.type === 'context.summary.requested') { turnId = event.turnId; core.cancelTurn(event.turnId); }
        if (event.type === 'turn.cancelled' && event.turn.id === turnId) resolve();
      }));
      turnId = await core.startTurn(session.id, '现在压缩，但我要取消');
      await cancelled;
      await new Promise((resolve) => setTimeout(resolve, 0));
      const nextTurnId = await core.startTurn(session.id, '取消后可以重新开始');
      expect(nextTurnId).not.toBe(turnId);
      core.cancelTurn(nextTurnId);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
