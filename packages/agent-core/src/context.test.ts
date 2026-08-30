import { describe, expect, it } from 'vitest';
import type { ModelMessage, SemanticSummary, ToolResult } from '@seecoder/protocol';
import { buildHybridContext, ContextLedger, FileEvidenceStore, MemoryIndex, serializeObservation } from './context.js';

const model = { baseUrl: 'http://fake', model: 'fake', apiKeyEnv: 'UNUSED', contextWindow: 10_000, temperature: 0, maxOutputTokens: 1000 };
const semantic: SemanticSummary = { userIntent: '修复问题', requirements: ['保留行为'], activeDecisions: [], supersededDecisions: [], completedWork: [], unresolvedQuestions: [], narrative: '旧讨论已压缩' };

describe('hybrid context', () => {
  it('migrates legacy ledger and tracks revision-scoped validation', () => {
    const ledger = new ContextLedger();
    ledger.restore({ goal: '旧任务', changedFiles: ['a.ts'], tests: ['通过: pnpm test'], errors: ['旧错误'] });
    expect(ledger.snapshot()).toMatchObject({ version: 2, goal: '旧任务', changeRevision: 0 });
    ledger.recordChanges([{ path: 'a.ts', after: 'one' }]);
    ledger.addValidation('pnpm test', true, 'ok');
    expect(ledger.hasFreshValidation()).toBe(true);
    ledger.recordChanges([{ path: 'a.ts', after: 'two' }]);
    expect(ledger.hasFreshValidation()).toBe(false);
  });

  it('deduplicates evidence by content and invalidates it after changes', () => {
    const evidence = new FileEvidenceStore();
    const first = evidence.record('src/a.ts', 'const a = 1;', 1, 1, 0);
    const second = evidence.record('src/a.ts', 'const a = 1;', 1, 1, 0);
    expect(first.duplicate).toBe(false); expect(second.duplicate).toBe(true);
    expect(evidence.referenced(0)).toHaveLength(1);
    evidence.invalidate(['src/a.ts']);
    expect(evidence.referenced(0)).toEqual([]);
    expect(evidence.record('src/a.ts', 'const a = 2;', 1, 1, 1).duplicate).toBe(false);
  });

  it('compresses observations by tool semantics while preserving diagnostics', () => {
    const ledger = new ContextLedger(); const evidence = new FileEvidenceStore();
    const read: ToolResult = { ok: true, output: { path: 'a.ts', startLine: 1, endLine: 1, text: 'hello' }, durationMs: 2 };
    expect(JSON.parse(serializeObservation('read_file', {}, read, ledger, evidence)).output.text).toBe('hello');
    expect(JSON.parse(serializeObservation('read_file', {}, read, ledger, evidence)).output.cached).toBe(true);
    const command: ToolResult = { ok: false, output: { exitCode: 1, stdout: 'x'.repeat(8000), stderr: 'src/a.ts:12 error broken' }, error: { code: 'command_failed', message: '退出码 1' }, durationMs: 10 };
    const compacted = JSON.parse(serializeObservation('run_command', { command: 'pnpm test' }, command, ledger, evidence));
    expect(compacted.output.truncated).toBe(true);
    expect(compacted.output.diagnostics).toContain('src/a.ts:12 error broken');
  });

  it('retrieves Chinese terms and paths while excluding stale validations', () => {
    const memory = new MemoryIndex(); const now = new Date().toISOString();
    memory.add({ kind: 'decision', text: '登录状态统一由 src/auth/store.ts 管理', sessionId: 't', revision: 2, timestamp: now, status: 'active' });
    memory.add({ kind: 'validation', text: '登录测试通过', sessionId: 't', revision: 1, timestamp: now, status: 'active' });
    const result = memory.retrieve('登录状态 src/auth/store.ts', 2);
    expect(result.some((item) => item.kind === 'decision')).toBe(true);
    expect(result.some((item) => item.kind === 'validation')).toBe(false);
  });

  it('does not retrieve messages from the current turn as historical memory', () => {
    const memory = new MemoryIndex(); const now = new Date().toISOString();
    memory.add({ kind: 'user', text: '后端启动入口在哪里', sessionId: 't', turnId: 'current', revision: 0, timestamp: now, status: 'active' });
    memory.add({ kind: 'decision', text: '后端启动入口位于 backend/main.py', sessionId: 't', turnId: 'older', revision: 0, timestamp: now, status: 'active' });
    const result = memory.retrieve('后端启动入口', 0, 6, 4000, 'current');
    expect(result.some((item) => item.turnId === 'current')).toBe(false);
    expect(result.some((item) => item.turnId === 'older')).toBe(true);
  });

  it('does not inject a retrieved copy of natural language already present in recent context', async () => {
    const memory = new MemoryIndex(); const now = new Date().toISOString();
    memory.add({ kind: 'assistant', text: '启动入口位于 backend/main.py', sessionId: 't', turnId: 'older', revision: 0, timestamp: now, status: 'active' });
    const messages: ModelMessage[] = [
      { role: 'assistant', content: '启动入口位于 backend/main.py', toolCalls: [{ id: 'finish-1', name: 'finish', arguments: '{"summary":"完成"}' }] },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'finish-1', toolName: 'finish' },
      { role: 'user', content: '请继续说明 backend/main.py' },
    ];
    const result = await buildHybridContext({ sessionId: 't', currentTurnId: 'current', messages, ledger: new ContextLedger(), evidence: new FileEvidenceStore(), memory, query: 'backend/main.py', model, force: false, summarize: async () => semantic });
    expect(result.retrieved).toEqual([]);
  });

  it('keeps one authoritative file body after a duplicate read references Evidence', async () => {
    const ledger = new ContextLedger(); const evidence = new FileEvidenceStore(); const body = 'const evidenceBody = 42;';
    const toolResult: ToolResult = { ok: true, output: { path: 'src/a.ts', startLine: 1, endLine: 1, text: body }, durationMs: 1 };
    const first = serializeObservation('read_file', {}, toolResult, ledger, evidence);
    const second = serializeObservation('read_file', {}, toolResult, ledger, evidence);
    const messages: ModelMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: '{"path":"src/a.ts"}' }] },
      { role: 'tool', content: first, toolCallId: 'r1', toolName: 'read_file' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'r2', name: 'read_file', arguments: '{"path":"src/a.ts"}' }] },
      { role: 'tool', content: second, toolCallId: 'r2', toolName: 'read_file' },
    ];
    const result = await buildHybridContext({ sessionId: 't', currentTurnId: 'current', messages, ledger, evidence, memory: new MemoryIndex(), query: 'a.ts', model, force: false, summarize: async () => semantic });
    expect(JSON.stringify(result.messages).split(body)).toHaveLength(2);
  });

  it('uses semantic summary, preserves tool groups and reaches the target budget', async () => {
    const ledger = new ContextLedger(); ledger.setGoal('修复问题');
    const messages: ModelMessage[] = Array.from({ length: 16 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `${index}-${'上下文'.repeat(300)}` }));
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }] });
    messages.push({ role: 'tool', content: '{"ok":true}', toolCallId: 'c1', toolName: 'read_file' });
    const result = await buildHybridContext({ sessionId: 't', messages, ledger, evidence: new FileEvidenceStore(), memory: new MemoryIndex(), query: '修复问题', model, force: false, summarize: async () => semantic });
    expect(result.metrics.compacted).toBe(true);
    expect(result.metrics.summarySource).toBe('model');
    expect(result.metrics.afterTokens).toBeLessThanOrEqual(result.metrics.availableInput * 0.60);
    const assistant = result.messages.find((message) => message.role === 'assistant' && message.toolCalls?.[0]?.id === 'c1');
    const tool = result.messages.find((message) => message.role === 'tool' && message.toolCallId === 'c1');
    expect(assistant).toBeDefined(); expect(tool).toBeDefined();
  });

  it('falls back deterministically when semantic summary fails', async () => {
    const ledger = new ContextLedger(); ledger.setGoal('不能丢失的目标');
    const messages: ModelMessage[] = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: '旧消息'.repeat(200) }));
    const result = await buildHybridContext({ sessionId: 't', messages, ledger, evidence: new FileEvidenceStore(), memory: new MemoryIndex(), query: '目标', model, force: true, summarize: async () => null });
    expect(result.metrics.summarySource).toBe('deterministic-fallback');
    expect(result.summary).toContain('不能丢失的目标');
  });
});
