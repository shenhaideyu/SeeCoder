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
