import { createHash, randomUUID } from 'node:crypto';
import { estimateTokens, type ModelConfig } from '@seecoder/model';
import type {
  AgentEvent, ContextCompactionMetrics, Item, ModelMessage, PlanStep,
  SemanticSummary, SessionEvent, ToolResult,
} from '@seecoder/protocol';

export interface DecisionRecord {
  id: string;
  decision: string;
  reason?: string;
  status: 'active' | 'superseded';
}

export interface ValidationRecord {
  command: string;
  revision: number;
  status: 'passed' | 'failed';
  summary: string;
  timestamp: string;
}

export interface FileStateRecord {
  path: string;
  contentHash: string | null;
  lastReadRevision?: number;
  lastChangedRevision?: number;
}

export interface ErrorRecord {
  code: string;
  message: string;
  revision: number;
  status: 'open' | 'resolved';
  timestamp: string;
}

export interface ContextLedgerStateV2 {
  version: 2;
  goal: string;
  acceptanceCriteria: string[];
  constraints: string[];
  plan: PlanStep[];
  changeRevision: number;
  decisions: DecisionRecord[];
  files: FileStateRecord[];
  validations: ValidationRecord[];
  errors: ErrorRecord[];
}

type LegacyLedger = {
  goal?: string;
  constraints?: string[];
  plan?: PlanStep[];
  changedFiles?: string[];
  tests?: string[];
  errors?: string[];
};

const timestamp = () => new Date().toISOString();
export const contentHash = (value: string): string => createHash('sha256').update(value).digest('hex');

export class ContextLedger {
  private state: ContextLedgerStateV2 = {
    version: 2, goal: '', acceptanceCriteria: [], constraints: [], plan: [], changeRevision: 0,
    decisions: [], files: [], validations: [], errors: [],
  };

  setGoal(goal: string): void { this.state.goal = goal.slice(0, 4000); }
  setPlan(plan: PlanStep[]): void { this.state.plan = plan.slice(0, 50); }
  revision(): number { return this.state.changeRevision; }

  restore(input: ContextLedgerStateV2 | LegacyLedger): void {
    if ((input as ContextLedgerStateV2).version === 2) {
      const value = input as ContextLedgerStateV2;
      this.state = {
        version: 2,
        goal: value.goal ?? '',
        acceptanceCriteria: value.acceptanceCriteria ?? [], constraints: value.constraints ?? [],
        plan: value.plan ?? [], changeRevision: value.changeRevision ?? 0,
        decisions: value.decisions ?? [], files: value.files ?? [], validations: value.validations ?? [], errors: value.errors ?? [],
      };
      return;
    }
    const legacy = input as LegacyLedger;
    this.state = {
      version: 2, goal: legacy.goal ?? '', acceptanceCriteria: [], constraints: legacy.constraints ?? [],
      plan: legacy.plan ?? [], changeRevision: 0, decisions: [],
      files: (legacy.changedFiles ?? []).map((path) => ({ path, contentHash: null, lastChangedRevision: 0 })),
      validations: (legacy.tests ?? []).map((summary) => ({ command: summary.slice(0, 300), revision: 0, status: summary.startsWith('通过') ? 'passed' : 'failed', summary: summary.slice(0, 500), timestamp: timestamp() })),
      errors: (legacy.errors ?? []).map((message) => ({ code: 'legacy_error', message: message.slice(0, 500), revision: 0, status: 'open', timestamp: timestamp() })),
    };
  }

  recordChanges(files: Array<{ path: string; after: string | null }>): number {
    this.state.changeRevision += 1;
    const revision = this.state.changeRevision;
    for (const file of files) {
      const existing = this.state.files.find((item) => item.path === file.path);
      const nextHash = file.after === null ? null : contentHash(file.after);
      if (existing) { existing.contentHash = nextHash; existing.lastChangedRevision = revision; }
      else this.state.files.push({ path: file.path, contentHash: nextHash, lastChangedRevision: revision });
    }
    this.state.files = this.state.files.slice(-100);
    return revision;
  }

  recordRead(path: string, hash: string): void {
    const existing = this.state.files.find((item) => item.path === path);
    if (existing) { existing.contentHash = hash; existing.lastReadRevision = this.state.changeRevision; }
    else this.state.files.push({ path, contentHash: hash, lastReadRevision: this.state.changeRevision });
  }

  addValidation(command: string, ok: boolean, summary: string): void {
    this.state.validations.push({ command: command.slice(0, 300), revision: this.state.changeRevision, status: ok ? 'passed' : 'failed', summary: summary.slice(0, 500), timestamp: timestamp() });
    this.state.validations = this.state.validations.slice(-40);
  }

  addError(code: string, message: string): void {
    this.state.errors.push({ code, message: message.slice(0, 500), revision: this.state.changeRevision, status: 'open', timestamp: timestamp() });
    this.state.errors = this.state.errors.slice(-40);
  }

  hasChanges(): boolean { return this.state.changeRevision > 0; }
  requiresFreshValidation(): boolean {
    const documentation = /\.(?:md|mdx|txt|rst|adoc)$/i;
    return this.state.files.some((file) => file.lastChangedRevision === this.state.changeRevision && !documentation.test(file.path));
  }
  hasFreshValidation(): boolean { return this.state.validations.some((item) => item.revision === this.state.changeRevision && item.status === 'passed'); }
  snapshot(): ContextLedgerStateV2 { return structuredClone(this.state); }
  summary(): string { return JSON.stringify(this.snapshot(), null, 2); }
}

export interface FileEvidence {
  id: string;
  path: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  text: string;
  revision: number;
  createdAt: string;
  referenced: boolean;
}

export class FileEvidenceStore {
  private readonly entries = new Map<string, FileEvidence>();
  private readonly keys = new Map<string, string>();
  private key(path: string, hash: string, startLine: number, endLine: number): string { return `${path}\0${hash}\0${startLine}\0${endLine}`; }

  record(path: string, text: string, startLine: number, endLine: number, revision: number): { evidence: FileEvidence; duplicate: boolean } {
    const hash = contentHash(text);
    const key = this.key(path, hash, startLine, endLine);
    const existingId = this.keys.get(key);
    if (existingId) {
      const existing = this.entries.get(existingId)!;
      existing.referenced = true;
      return { evidence: existing, duplicate: true };
    }
    const evidence: FileEvidence = { id: randomUUID(), path, contentHash: hash, startLine, endLine, text, revision, createdAt: timestamp(), referenced: false };
    this.entries.set(evidence.id, evidence); this.keys.set(key, evidence.id);
    return { evidence, duplicate: false };
  }

  invalidate(paths: string[]): void {
    const targets = new Set(paths);
    for (const [id, entry] of this.entries) if (targets.has(entry.path)) { this.entries.delete(id); this.keys.delete(this.key(entry.path, entry.contentHash, entry.startLine, entry.endLine)); }
  }

  referenced(revision: number): FileEvidence[] { return [...this.entries.values()].filter((entry) => entry.referenced && entry.revision === revision); }
  clear(): void { this.entries.clear(); this.keys.clear(); }
}

export interface MemoryEntry {
  id: string;
  kind: 'decision' | 'error' | 'validation' | 'change' | 'user' | 'assistant';
  text: string;
  paths: string[];
  keywords: string[];
  sessionId: string;
  turnId?: string;
  revision?: number;
  timestamp: string;
  status?: 'active' | 'resolved' | 'superseded';
}

function keywords(value: string): string[] {
  const normalized = value.toLowerCase();
  const output = new Set(normalized.match(/[a-z0-9_./-]{2,}/g) ?? []);
  const chinese = [...normalized.replaceAll(/[^\p{Script=Han}]/gu, '')];
  for (let index = 0; index < chinese.length - 1; index += 1) output.add(chinese[index]! + chinese[index + 1]!);
  return [...output].slice(0, 200);
}

function pathsIn(value: string): string[] { return [...new Set(value.match(/[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+/g) ?? [])].slice(0, 20); }

export class MemoryIndex {
  private entries: MemoryEntry[] = [];

  add(entry: Omit<MemoryEntry, 'id' | 'keywords' | 'paths'> & { paths?: string[] }): void {
    this.entries.push({ ...entry, id: randomUUID(), paths: entry.paths ?? pathsIn(entry.text), keywords: keywords(entry.text) });
    this.entries = this.entries.slice(-500);
  }

  ingest(sessionId: string, event: AgentEvent, item: Item | undefined, revision: number): void {
    if (item?.kind === 'user_message') this.add({ kind: 'user', text: item.text.slice(0, 4000), sessionId, ...('turnId' in event && event.turnId ? { turnId: event.turnId } : {}), revision, timestamp: item.createdAt, status: 'active' });
    else if (item?.kind === 'assistant_message' && item.text) this.add({ kind: 'assistant', text: item.text.slice(0, 4000), sessionId, ...('turnId' in event && event.turnId ? { turnId: event.turnId } : {}), revision, timestamp: item.createdAt, status: 'active' });
    else if (item?.kind === 'changes') this.add({ kind: 'change', text: `修改文件：${item.changeSet.files.map((file) => file.path).join('、')}`, paths: item.changeSet.files.map((file) => file.path), sessionId, turnId: item.changeSet.turnId, revision, timestamp: item.createdAt, status: 'active' });
    else if (item?.kind === 'error') this.add({ kind: 'error', text: `${item.error.code}: ${item.error.message}`, sessionId, revision, timestamp: item.createdAt, status: 'active' });
    if (event.type === 'tool.completed' && event.result.error) this.add({ kind: 'error', text: `${event.result.error.code}: ${event.result.error.message}`, sessionId, turnId: event.turnId, revision, timestamp: event.timestamp, status: 'active' });
  }

  rebuild(sessionId: string, records: SessionEvent[], revision: number): void {
    this.entries = this.entries.filter((entry) => entry.sessionId !== sessionId);
    for (const record of records) this.ingest(sessionId, record.event, record.item, revision);
  }

  syncLedger(sessionId: string, state: ContextLedgerStateV2): void {
    this.entries = this.entries.filter((entry) => entry.sessionId !== sessionId || !['decision', 'validation', 'error'].includes(entry.kind));
    for (const decision of state.decisions) this.add({
      kind: 'decision', text: `${decision.decision}${decision.reason ? `：${decision.reason}` : ''}`,
      sessionId, revision: state.changeRevision, timestamp: timestamp(), status: decision.status,
    });
    for (const validation of state.validations) this.add({
      kind: 'validation', text: `${validation.command}: ${validation.summary}`,
      sessionId, revision: validation.revision, timestamp: validation.timestamp, status: 'active',
    });
    for (const error of state.errors) this.add({
      kind: 'error', text: `${error.code}: ${error.message}`,
      sessionId, revision: error.revision, timestamp: error.timestamp, status: error.status === 'open' ? 'active' : 'resolved',
    });
  }

  retrieve(query: string, revision: number, limit = 6, maxChars = 4000, excludeTurnId?: string): MemoryEntry[] {
    const queryKeys = new Set(keywords(query));
    const queryPaths = pathsIn(query);
    const now = Date.now();
    const scored = this.entries.flatMap((entry) => {
      if (excludeTurnId && entry.turnId === excludeTurnId) return [];
      if (entry.status === 'resolved' || entry.status === 'superseded') return [];
      if (entry.kind === 'validation' && entry.revision !== revision) return [];
      let score = entry.keywords.reduce((sum, key) => sum + (queryKeys.has(key) ? 3 : 0), 0);
      score += entry.paths.reduce((sum, path) => sum + (queryPaths.some((value) => value.includes(path) || path.includes(value)) ? 8 : 0), 0);
      if (entry.revision === revision) score += 2;
      if (entry.status === 'active') score += 1;
      score += Math.max(0, 1 - (now - Date.parse(entry.timestamp)) / 86_400_000 / 30);
      return score > 0 ? [{ entry, score }] : [];
    }).sort((left, right) => right.score - left.score || right.entry.timestamp.localeCompare(left.entry.timestamp));
    const output: MemoryEntry[] = []; let chars = 0;
    for (const { entry } of scored) { if (output.length >= limit || chars + entry.text.length > maxChars) break; output.push(entry); chars += entry.text.length; }
    return output;
  }
}

const validationPattern = /(^|\s)(test|lint|typecheck|build)(\s|:|$)|pytest|node\s+--test|python\s+-m\s+pytest/i;
export function isValidationCommand(command: string): boolean { return validationPattern.test(command); }

function headTail(value: string, head = 3000, tail = 5000): { text: string; truncated: boolean } {
  if (value.length <= head + tail) return { text: value, truncated: false };
  return { text: `${value.slice(0, head)}\n…[已裁剪]…\n${value.slice(-tail)}`, truncated: true };
}

function diagnosticLines(value: string): string[] {
  return value.split(/\r?\n/).filter((line) => /(?:error|failed|exception|warning|\.(?:ts|tsx|js|py|java|cpp))[:(\s]/i.test(line)).slice(-30).map((line) => line.slice(0, 500));
}

export function serializeObservation(toolName: string, args: unknown, result: ToolResult, ledger: ContextLedger, evidence: FileEvidenceStore): string {
  const base = { ok: result.ok, ...(result.error ? { error: result.error } : {}), durationMs: result.durationMs };
  if (toolName === 'list_files' && result.ok) {
    const value = result.output && typeof result.output === 'object' && !Array.isArray(result.output)
      ? result.output as { entries?: unknown; count?: unknown; truncated?: unknown; limit?: unknown }
      : { entries: result.output };
    const entries = Array.isArray(value.entries) ? value.entries.filter((entry): entry is string => typeof entry === 'string') : [];
    return JSON.stringify({ ...base, output: { entries, count: typeof value.count === 'number' ? value.count : entries.length, truncated: value.truncated === true, limit: typeof value.limit === 'number' ? value.limit : 200 } });
  }
  if (toolName === 'read_file' && result.ok && result.output && typeof result.output === 'object') {
    const value = result.output as { path?: unknown; startLine?: unknown; endLine?: unknown; text?: unknown };
    if (typeof value.path === 'string' && typeof value.text === 'string') {
      const startLine = typeof value.startLine === 'number' ? value.startLine : 1; const endLine = typeof value.endLine === 'number' ? value.endLine : startLine;
      const recorded = evidence.record(value.path, value.text, startLine, endLine, ledger.revision()); ledger.recordRead(value.path, recorded.evidence.contentHash);
      return JSON.stringify(recorded.duplicate ? { ...base, output: { path: value.path, evidenceRef: recorded.evidence.id, contentHash: recorded.evidence.contentHash, startLine, endLine, cached: true } } : { ...base, output: { ...value, evidenceRef: recorded.evidence.id, contentHash: recorded.evidence.contentHash } });
    }
  }
  if (toolName === 'read_files' && result.ok && Array.isArray(result.output)) {
    const output = result.output.map((raw) => {
      const value = raw as { path?: unknown; text?: unknown; error?: unknown };
      if (typeof value.path !== 'string' || typeof value.text !== 'string') return value;
      const lines = value.text.split(/\r?\n/); const recorded = evidence.record(value.path, value.text, 1, lines.length, ledger.revision()); ledger.recordRead(value.path, recorded.evidence.contentHash);
      return recorded.duplicate ? { path: value.path, evidenceRef: recorded.evidence.id, contentHash: recorded.evidence.contentHash, cached: true } : { ...value, evidenceRef: recorded.evidence.id, contentHash: recorded.evidence.contentHash };
    });
    return JSON.stringify({ ...base, output });
  }
  if (toolName === 'run_command' && result.output && typeof result.output === 'object') {
    const value = result.output as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
    const stdout = headTail(typeof value.stdout === 'string' ? value.stdout : '', 2500, 2500); const stderr = headTail(typeof value.stderr === 'string' ? value.stderr : '', 1000, 5000);
    return JSON.stringify({ ...base, output: { command: String((args as { command?: unknown } | undefined)?.command ?? '').slice(0, 500), exitCode: value.exitCode, stdout: stdout.text, stderr: stderr.text, diagnostics: diagnosticLines(`${stdout.text}\n${stderr.text}`), truncated: stdout.truncated || stderr.truncated } });
  }
  if (toolName === 'write_file' || toolName === 'apply_patch') {
    const changes = result.output as { kind?: unknown; files?: Array<{ path: string; before: string | null; after: string | null }> } | undefined;
    if (changes?.kind === 'changes' && Array.isArray(changes.files)) return JSON.stringify({ ...base, output: { kind: 'changes', files: changes.files.map((file) => ({ path: file.path, operation: file.after === null ? 'deleted' : file.before === null ? 'created' : 'updated', beforeChars: file.before?.length ?? 0, afterChars: file.after?.length ?? 0 })) } });
  }
  if (toolName === 'search_text' && Array.isArray(result.output)) {
    const unique = [...new Map(result.output.map((entry) => [JSON.stringify(entry), entry])).values()].slice(0, 50);
    return JSON.stringify({ ...base, output: unique, total: result.output.length, truncated: unique.length < result.output.length });
  }
  if (toolName === 'git_diff' && result.output && typeof result.output === 'object') {
    const value = result.output as { exitCode?: unknown; stdout?: unknown; stderr?: unknown }; const diff = headTail(typeof value.stdout === 'string' ? value.stdout : '', 5000, 5000);
    return JSON.stringify({ ...base, output: { exitCode: value.exitCode, diff: diff.text, stderr: typeof value.stderr === 'string' ? value.stderr.slice(-2000) : '', truncated: diff.truncated } });
  }
  const serialized = JSON.stringify(result);
  if (serialized.length <= 16_000) return serialized;
  return JSON.stringify({ ...base, output: `[工具输出过长，已裁剪；完整结果保留在轨迹]\n${serialized.slice(0, 10_000)}\n…\n${serialized.slice(-4_000)}` });
}

function messageGroups(messages: ModelMessage[]): ModelMessage[][] {
  const groups: ModelMessage[][] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const pending = new Set(message.toolCalls.map((call) => call.id)); const group = [message]; index += 1;
      while (index < messages.length && messages[index]!.role === 'tool') { const tool = messages[index]!; if (pending.has(tool.toolCallId ?? '')) pending.delete(tool.toolCallId!); group.push(tool); index += 1; }
      if (pending.size === 0) groups.push(group);
    } else if (message.role === 'tool') index += 1;
    else { groups.push([message]); index += 1; }
  }
  return groups;
}

export function sanitizeModelMessages(messages: ModelMessage[]): ModelMessage[] { return messageGroups(messages).flat(); }

function collapseReferencedEvidence(messages: ModelMessage[], referenced: FileEvidence[]): ModelMessage[] {
  const ids = new Set(referenced.map((entry) => entry.id));
  if (!ids.size) return messages;
  return messages.map((message) => {
    if (message.role !== 'tool' || typeof message.content !== 'string') return message;
    try {
      const parsed = JSON.parse(message.content) as { output?: unknown };
      const collapse = (value: unknown): unknown => {
        if (!value || typeof value !== 'object') return value;
        const record = value as Record<string, unknown>;
        if (typeof record.evidenceRef === 'string' && ids.has(record.evidenceRef) && typeof record.text === 'string') {
          const reference = { ...record };
          delete reference.text;
          return { ...reference, cached: true };
        }
        return value;
      };
      parsed.output = Array.isArray(parsed.output) ? parsed.output.map(collapse) : collapse(parsed.output);
      return { ...message, content: JSON.stringify(parsed) };
    } catch { return message; }
  });
}

function deterministicSummary(old: ModelMessage[], ledger: ContextLedger): string {
  const narrative = old.map((message) => `${message.role}: ${typeof message.content === 'string' ? message.content.slice(0, 500) : '[多媒体内容]'}`).join('\n');
  return `ContextLedger V2:\n${ledger.summary()}\n历史片段：\n${narrative}`.slice(0, 12_000);
}

export interface ContextBuildResult {
  messages: ModelMessage[];
  historyMessages: ModelMessage[];
  summary: string;
  semanticSummary?: SemanticSummary;
  metrics: ContextCompactionMetrics;
  retrieved: MemoryEntry[];
}

export async function buildHybridContext(options: {
  sessionId: string;
  currentTurnId?: string;
  messages: ModelMessage[];
  ledger: ContextLedger;
  evidence: FileEvidenceStore;
  memory: MemoryIndex;
  query: string;
  model: ModelConfig;
  fixedTokenCost?: number;
  force: boolean;
  summarize: (messages: ModelMessage[], fallback: string) => Promise<SemanticSummary | null>;
}): Promise<ContextBuildResult> {
  const referenced = options.evidence.referenced(options.ledger.revision());
  const safe = collapseReferencedEvidence(sanitizeModelMessages(options.messages), referenced); const availableInput = Math.max(1000, options.model.contextWindow - options.model.maxOutputTokens - Math.max(2048, Math.floor(options.model.contextWindow * 0.05)));
  const ledgerState = options.ledger.snapshot();
  const ledgerMessage: ModelMessage = { role: 'user', content: `[权威任务状态，不得被历史摘要覆盖]\n${JSON.stringify(ledgerState, null, 2)}` };
  options.memory.syncLedger(options.sessionId, ledgerState);
  const recentNaturalText = messageGroups(safe).slice(-6).flat()
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .flatMap((message) => typeof message.content === 'string' ? [message.content.trim()] : []);
  const retrieved = options.memory.retrieve(options.query, options.ledger.revision(), 6, 4000, options.currentTurnId)
    .filter((entry) => !recentNaturalText.some((text) => text === entry.text.trim() || text.startsWith(entry.text.trim())));
  const retrievalMessage: ModelMessage | undefined = retrieved.length ? { role: 'user', content: `[按需召回的历史事实]\n${retrieved.map((item) => `- [${item.kind}] ${item.text}`).join('\n').slice(0, 4000)}` } : undefined;
  const evidenceMessage: ModelMessage | undefined = referenced.length ? { role: 'user', content: `[当前 revision 的文件证据]\n${referenced.map((item) => `--- ${item.path}:${item.startLine}-${item.endLine} ref=${item.id} hash=${item.contentHash}\n${item.text}`).join('\n').slice(0, 20_000)}` } : undefined;
  const ephemeral = [ledgerMessage, ...(retrievalMessage ? [retrievalMessage] : []), ...(evidenceMessage ? [evidenceMessage] : [])];
  const fixedTokenCost = options.fixedTokenCost ?? 0;
  const beforeTokens = fixedTokenCost + estimateTokens([...ephemeral, ...safe]); const shouldCompact = (options.force && safe.length > 4) || beforeTokens > availableInput * 0.75;
  if (!shouldCompact) return { messages: [...ephemeral, ...safe], historyMessages: safe, summary: '', metrics: { beforeTokens, afterTokens: beforeTokens, availableInput, compacted: false, retrievedEntries: retrieved.length, droppedEvidence: 0 }, retrieved };

  const groups = messageGroups(safe);
  const lastGroupIndex = groups.length - 1;
  let lastToolGroupIndex = -1;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const first = groups[index]?.[0];
    if (first?.role === 'assistant' && first.toolCalls?.length) { lastToolGroupIndex = index; break; }
  }
  const protectedIndexes = new Set([lastGroupIndex, lastToolGroupIndex].filter((index) => index >= 0));
  const keptIndexes = new Set([
    ...groups.slice(-Math.min(6, groups.length)).map((_, offset) => groups.length - Math.min(6, groups.length) + offset),
    ...protectedIndexes,
  ]);
  const selectedMessages = () => [...keptIndexes].sort((left, right) => left - right).flatMap((index) => groups[index] ?? []);
  let keep = selectedMessages();
  // 摘要覆盖除强制保护组之外的历史。这样后续为了预算移除“最近原文”时，事实仍在摘要中。
  const old = groups.flatMap((group, index) => protectedIndexes.has(index) ? [] : group);
  const fallback = deterministicSummary(old, options.ledger); const semantic = old.length ? await options.summarize(old, fallback) : null;
  let summary = semantic ? JSON.stringify(semantic) : fallback;
  let summaryMessage: ModelMessage = { role: 'user', content: `[历史压缩摘要]\n[仅作叙事参考]\n${summary}` };
  let activeRetrieved = retrievalMessage; let activeEvidence = evidenceMessage; let droppedEvidence = 0;
  const request = () => [ledgerMessage, ...(activeRetrieved ? [activeRetrieved] : []), ...(activeEvidence ? [activeEvidence] : []), summaryMessage, ...keep];
  const target = availableInput * 0.60;
  const exceedsTarget = () => fixedTokenCost + estimateTokens(request()) > target;
  if (exceedsTarget()) activeRetrieved = undefined;
  if (exceedsTarget() && activeEvidence) { activeEvidence = undefined; droppedEvidence = referenced.length; }
  if (exceedsTarget() && summary.length > 4000) { summary = summary.slice(0, 4000); summaryMessage = { role: 'user', content: `[历史压缩摘要]\n[仅作叙事参考]\n${summary}` }; }
  while (exceedsTarget()) {
    const removable = [...keptIndexes].sort((left, right) => left - right).find((index) => !protectedIndexes.has(index));
    if (removable === undefined) break;
    keptIndexes.delete(removable);
    keep = selectedMessages();
  }
  const historyMessages = [summaryMessage, ...keep]; const messages = sanitizeModelMessages(request()); const afterTokens = fixedTokenCost + estimateTokens(messages);
  return { messages, historyMessages, summary, ...(semantic ? { semanticSummary: semantic } : {}), metrics: { beforeTokens, afterTokens, availableInput, compacted: true, summarySource: semantic ? 'model' : 'deterministic-fallback', retrievedEntries: activeRetrieved ? retrieved.length : 0, droppedEvidence }, retrieved: activeRetrieved ? retrieved : [] };
}
