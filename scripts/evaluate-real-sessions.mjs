import { readFile, readdir } from 'node:fs/promises';
import { Console } from 'node:console';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const output = new Console({ stdout: process.stdout, stderr: process.stderr });

const terminalTypes = new Set(['turn.completed', 'turn.failed', 'turn.cancelled']);
const sideEffectTools = new Set([
  'write_file', 'apply_patch', 'run_command', 'git_stage', 'git_unstage',
  'git_revert', 'git_commit', 'git_push', 'checkpoint_restore',
]);
const controlFlowErrorCodes = new Set(['exploration_budget_exhausted']);

function toolErrorCode(event) {
  return event.result?.error?.code ?? event.result?.code;
}

export function unwrap(record) {
  return record?.payload ?? record?.event ?? record;
}

export function evaluateScenario(scenario, events) {
  const userEvent = events
    .filter((event) => event.type === 'message.user' && event.text === scenario.prompt)
    .sort((left, right) => new Date(right.timestamp ?? 0).getTime() - new Date(left.timestamp ?? 0).getTime())[0];
  if (!userEvent?.turnId) return { id: scenario.id, found: false, pass: false, failures: ['未找到完全匹配的真实任务轨迹'] };
  const turnId = userEvent.turnId;
  const turnEvents = events.filter((event) => event.turnId === turnId || event.turn?.id === turnId);
  const requested = turnEvents.filter((event) => event.type === 'tool.requested');
  const completed = turnEvents.filter((event) => event.type === 'tool.completed');
  const models = turnEvents.filter((event) => event.type === 'model.completed');
  const terminal = [...turnEvents].reverse().find((event) => terminalTypes.has(event.type));
  const answers = turnEvents.filter((event) => event.type === 'message.completed').map((event) => event.text ?? '');
  const signatures = requested.map((event) => `${event.call?.name}:${JSON.stringify(event.call?.args ?? {})}`);
  const duplicates = signatures.length - new Set(signatures).size;
  const sideEffects = requested.filter((event) => sideEffectTools.has(event.call?.name)).length;
  const failedTools = completed.filter((event) => (
    event.result?.ok === false && !controlFlowErrorCodes.has(toolErrorCode(event))
  )).length;
  const maxInputTokens = Math.max(0, ...models.map((event) => Number(event.inputTokens ?? 0)));
  const metrics = {
    status: terminal?.type?.replace('turn.', '') ?? 'running',
    iterations: models.length,
    toolCalls: requested.length,
    failedTools,
    duplicateCalls: duplicates,
    maxInputTokensPerRequest: maxInputTokens,
    answerChars: answers.join('\n').length,
    sideEffects,
    durationMs: terminal?.turn?.startedAt && terminal?.turn?.completedAt
      ? new Date(terminal.turn.completedAt).getTime() - new Date(terminal.turn.startedAt).getTime()
      : undefined,
    tools: requested.map((event) => event.call?.name).filter(Boolean),
  };
  const limits = scenario.limits ?? {};
  const metricByLimit = {
    maxIterations: 'iterations',
    maxToolCalls: 'toolCalls',
    maxFailedTools: 'failedTools',
    maxDuplicateCalls: 'duplicateCalls',
    maxInputTokensPerRequest: 'maxInputTokensPerRequest',
    maxAnswerChars: 'answerChars',
    maxSideEffects: 'sideEffects',
  };
  const failures = [];
  if (metrics.status !== 'completed') failures.push(`状态为 ${metrics.status}`);
  for (const requiredTool of scenario.requiredTools ?? []) {
    if (!metrics.tools.includes(requiredTool)) failures.push(`缺少必要工具证据：${requiredTool}`);
  }
  for (const [limitName, limit] of Object.entries(limits)) {
    const metricName = metricByLimit[limitName];
    if (typeof limit === 'number' && metricName && typeof metrics[metricName] === 'number' && metrics[metricName] > limit) {
      failures.push(`${metricName}=${metrics[metricName]}，上限=${limit}`);
    }
  }
  return { id: scenario.id, found: true, pass: failures.length === 0, turnId, metrics, failures };
}

async function loadEvents(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const events = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const text = await readFile(join(root, entry.name, 'events.jsonl'), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { events.push(unwrap(JSON.parse(line))); } catch { /* 损坏尾行由会话恢复逻辑忽略，评测保持同样行为。 */ }
      }
    } catch { /* 空任务没有事件文件。 */ }
  }
  return events;
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const here = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
  const catalogPath = resolve(argument('--catalog', join(here, 'tests', 'evals', 'realistic-prompts.json')));
  const defaultRoot = join(process.env.APPDATA ?? '', 'SeeCoder', 'sessions-data', 'sessions');
  const sessionsRoot = resolve(argument('--sessions-root', defaultRoot));
  const scenarios = JSON.parse(await readFile(catalogPath, 'utf8'));
  const events = await loadEvents(sessionsRoot);
  const results = scenarios.map((scenario) => evaluateScenario(scenario, events));
  output.table(results.map((result) => ({
    id: result.id,
    found: result.found,
    pass: result.pass,
    status: result.metrics?.status ?? '-',
    iterations: result.metrics?.iterations ?? '-',
    tools: result.metrics?.toolCalls ?? '-',
    maxInput: result.metrics?.maxInputTokensPerRequest ?? '-',
    answerChars: result.metrics?.answerChars ?? '-',
    failures: result.failures.join('; '),
  })));
  const evaluated = results.filter((result) => result.found);
  if (!evaluated.length) process.exitCode = 2;
  else if (evaluated.some((result) => !result.pass)) process.exitCode = 1;
  if (process.argv.includes('--require-all') && results.some((result) => !result.found)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
