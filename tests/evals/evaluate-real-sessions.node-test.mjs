import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateScenario } from '../../scripts/evaluate-real-sessions.mjs';

test('真实任务评测会识别重复工具调用与副作用', () => {
  const prompt = '请帮我查清楚登录失败的原因，不要改代码。';
  const scenario = { id: 'natural', prompt, limits: { maxIterations: 2, maxDuplicateCalls: 0, maxSideEffects: 0 } };
  const events = [
    { type: 'message.user', turnId: 'turn-1', text: prompt },
    { type: 'model.completed', turnId: 'turn-1', inputTokens: 1000 },
    { type: 'tool.requested', turnId: 'turn-1', call: { name: 'read_file', args: { path: 'a.ts' } } },
    { type: 'tool.requested', turnId: 'turn-1', call: { name: 'read_file', args: { path: 'a.ts' } } },
    { type: 'tool.requested', turnId: 'turn-1', call: { name: 'write_file', args: { path: 'a.ts' } } },
    { type: 'turn.completed', turn: { id: 'turn-1' } },
  ];
  const result = evaluateScenario(scenario, events);
  assert.equal(result.found, true);
  assert.equal(result.pass, false);
  assert.equal(result.metrics.duplicateCalls, 1);
  assert.equal(result.metrics.sideEffects, 1);
});

test('自然任务在预算内完成时通过', () => {
  const prompt = '后端从哪里启动？请用几句话说明。';
  const scenario = { id: 'simple', prompt, limits: { maxIterations: 2, maxToolCalls: 2, maxAnswerChars: 200 } };
  const events = [
    { type: 'message.user', turnId: 'turn-2', text: prompt },
    { type: 'model.completed', turnId: 'turn-2', inputTokens: 1200 },
    { type: 'tool.requested', turnId: 'turn-2', call: { name: 'search_text', args: { query: 'main' } } },
    { type: 'tool.completed', turnId: 'turn-2', result: { ok: true } },
    { type: 'message.completed', turnId: 'turn-2', text: '入口位于 backend/main.py。' },
    { type: 'turn.completed', turn: { id: 'turn-2' } },
  ];
  assert.equal(evaluateScenario(scenario, events).pass, true);
});

test('复杂任务必须包含约定的实施与验证工具证据', () => {
  const prompt = '修复问题并运行测试。';
  const scenario = {
    id: 'complex',
    prompt,
    requiredTools: ['apply_patch', 'run_command', 'finish'],
  };
  const events = [
    { type: 'message.user', turnId: 'turn-3', text: prompt },
    { type: 'model.completed', turnId: 'turn-3', inputTokens: 900 },
    { type: 'tool.requested', turnId: 'turn-3', call: { name: 'apply_patch', args: {} } },
    { type: 'turn.completed', turn: { id: 'turn-3' } },
  ];
  const result = evaluateScenario(scenario, events);
  assert.equal(result.pass, false);
  assert.deepEqual(result.failures, ['缺少必要工具证据：run_command', '缺少必要工具证据：finish']);
});

test('探索预算信号不计为工具执行失败', () => {
  const prompt = '先调查再修复。';
  const scenario = { id: 'budget', prompt, limits: { maxFailedTools: 0 } };
  const events = [
    { type: 'message.user', turnId: 'turn-4', text: prompt },
    {
      type: 'tool.completed',
      turnId: 'turn-4',
      result: { ok: false, error: { code: 'exploration_budget_exhausted' } },
    },
    { type: 'turn.completed', turn: { id: 'turn-4' } },
  ];
  const result = evaluateScenario(scenario, events);
  assert.equal(result.pass, true);
  assert.equal(result.metrics.failedTools, 0);
});

test('评测会统计上下文压缩、召回和验证过期证据', () => {
  const prompt = '继续刚才的决定，并确认这次修改是否仍经过测试。';
  const scenario = { id: 'context', prompt, limits: { maxSummaryFailures: 0 } };
  const events = [
    { type: 'message.user', turnId: 'turn-5', text: prompt },
    { type: 'context.retrieved', turnId: 'turn-5', count: 3 },
    { type: 'context.compacted', turnId: 'turn-5', metrics: { beforeTokens: 9000, afterTokens: 4000 } },
    { type: 'tool.completed', turnId: 'turn-5', result: { ok: true, output: { verificationStatus: 'warning' } } },
    { type: 'turn.completed', turn: { id: 'turn-5' } },
  ];
  const result = evaluateScenario(scenario, events);
  assert.equal(result.pass, true);
  assert.equal(result.metrics.contextCompactions, 1);
  assert.equal(result.metrics.retrievedEntries, 3);
  assert.equal(result.metrics.verificationWarnings, 1);
});
