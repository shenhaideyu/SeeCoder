import { appendFile, mkdir, readFile, rename, writeFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AgentEvent, ChangeSet, Checkpoint, Item, SessionEvent, Session, Turn } from '@seecoder/protocol';

export interface ReplayDiagnostic {
  code: 'duplicate_seq' | 'out_of_order_seq' | 'cross_session_event' | 'orphan_tool_result' | 'duplicate_terminal';
  message: string;
  seq?: number | undefined;
  eventId?: string | undefined;
}

export interface SessionReplay {
  records: SessionEvent[];
  modelItems: Item[];
  changeSets: ChangeSet[];
  checkpoints: Checkpoint[];
  unfinishedTurns: Turn[];
  diagnostics: ReplayDiagnostic[];
}

/** 纯事件回放：不读写磁盘、不调用模型，也绝不重新执行历史工具。 */
export function replaySessionEvents(sessionId: string, input: SessionEvent[]): SessionReplay {
  const diagnostics: ReplayDiagnostic[] = [];
  let inputPreviousSeq = 0;
  for (const record of input) {
    if (typeof record.seq === 'number' && record.seq > 0) {
      if (record.seq < inputPreviousSeq) diagnostics.push({ code: 'out_of_order_seq', message: `事件序号从 ${inputPreviousSeq} 回退到 ${record.seq}`, seq: record.seq, eventId: record.id });
      inputPreviousSeq = Math.max(inputPreviousSeq, record.seq);
    }
  }
  const records = input.map((record, index) => ({ record, index }))
    .sort((left, right) => ((left.record.seq ?? left.index + 1) - (right.record.seq ?? right.index + 1)) || left.index - right.index)
    .map(({ record }) => record);
  const seenSeq = new Set<number>();
  const started = new Map<string, Turn>();
  const terminal = new Set<string>();
  const toolCalls = new Set<string>();
  const changeSets = new Map<string, ChangeSet>();
  const checkpoints = new Map<string, Checkpoint>();
  let modelItems: Item[] = [];

  for (const record of records) {
    const seq = record.seq;
    if (typeof seq === 'number' && seq > 0) {
      if (seenSeq.has(seq)) diagnostics.push({ code: 'duplicate_seq', message: `重复事件序号 ${seq}`, seq, eventId: record.id });
      seenSeq.add(seq);
    }
    const eventSessionId = record.sessionId ?? record.event.sessionId;
    if (eventSessionId && eventSessionId !== sessionId) {
      diagnostics.push({ code: 'cross_session_event', message: `事件属于其他任务 ${eventSessionId}`, seq, eventId: record.id });
      continue;
    }
    const event = record.event;
    if (event.type === 'turn.started') started.set(event.turn.id, event.turn);
    if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled') {
      if (terminal.has(event.turn.id)) diagnostics.push({ code: 'duplicate_terminal', message: `Turn ${event.turn.id} 存在多个终态`, seq, eventId: record.id });
      terminal.add(event.turn.id);
    }
    if (event.type === 'assistant.tool_calls') for (const call of event.calls) toolCalls.add(call.id);
    if (event.type === 'changes.created') changeSets.set(event.changeSet.id, event.changeSet);
    if (event.type === 'checkpoint.created') checkpoints.set(event.checkpoint.id, event.checkpoint);

    const item = record.item;
    if (!item) continue;
    if (item.kind === 'compaction') {
      modelItems = [item];
      toolCalls.clear();
      for (const message of item.messages ?? []) for (const call of message.toolCalls ?? []) toolCalls.add(call.id);
      continue;
    }
    if (item.kind === 'assistant_message') for (const call of item.toolCalls ?? []) toolCalls.add(call.id);
    if (item.kind === 'tool_result' && !toolCalls.has(item.callId)) {
      diagnostics.push({ code: 'orphan_tool_result', message: `Tool Result ${item.callId} 缺少对应 Assistant Tool Call`, seq, eventId: record.id });
      continue;
    }
    if (item.kind === 'changes') changeSets.set(item.changeSet.id, item.changeSet);
    modelItems.push(item);
  }

  return {
    records,
    modelItems,
    changeSets: [...changeSets.values()],
    checkpoints: [...checkpoints.values()],
    unfinishedTurns: [...started.values()].filter((turn) => !terminal.has(turn.id)),
    diagnostics,
  };
}

export class SessionStore {
  private readonly sequences = new Map<string, number>();
  private readonly appendQueues = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  private sessionDir(sessionId: string): string {
    return join(this.root, 'sessions', sessionId);
  }

  async saveSession(session: Session): Promise<void> {
    const directory = this.sessionDir(session.id);
    await mkdir(directory, { recursive: true });
    const target = join(directory, 'meta.json');
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(session, null, 2), 'utf8');
    await rename(temp, target);
  }

  async readSession(sessionId: string): Promise<Session | null> {
    try {
      return JSON.parse(await readFile(join(this.sessionDir(sessionId), 'meta.json'), 'utf8')) as Session;
    } catch {
      return null;
    }
  }

  async append(sessionId: string, event: SessionEvent): Promise<void> {
    const previous = this.appendQueues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const directory = this.sessionDir(sessionId);
      await mkdir(directory, { recursive: true });
      const next = (this.sequences.get(sessionId) ?? 0) + 1;
      this.sequences.set(sessionId, next);
      const routed = { ...event.event, sessionId: event.event.sessionId ?? sessionId };
      const turnId = 'turnId' in routed ? routed.turnId : 'turn' in routed ? routed.turn.id : undefined;
      const persisted: SessionEvent = {
        ...event,
        version: 3,
        id: event.id ?? randomUUID(),
        seq: event.seq ?? next,
        sessionId: event.sessionId ?? sessionId,
        type: routed.type,
        timestamp: routed.timestamp,
        ...(turnId ? { turnId } : {}),
        event: routed,
        payload: routed,
      };
      await appendFile(join(directory, 'events.jsonl'), `${JSON.stringify(persisted)}\n`, 'utf8');
    });
    this.appendQueues.set(sessionId, current);
    try {
      await current;
    } finally {
      if (this.appendQueues.get(sessionId) === current) this.appendQueues.delete(sessionId);
    }
  }

  async readEvents(sessionId: string): Promise<SessionEvent[]> {
    try {
      const text = await readFile(join(this.sessionDir(sessionId), 'events.jsonl'), 'utf8');
      const records = text
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const parsed = JSON.parse(line) as Partial<SessionEvent> & { payload?: AgentEvent };
            if (parsed.event) return [{ ...parsed, sessionId: parsed.sessionId ?? sessionId, event: { ...parsed.event, sessionId: parsed.event.sessionId ?? sessionId } } as SessionEvent];
            if (parsed.payload) return [{ version: 3, id: parsed.id ?? randomUUID(), seq: parsed.seq, sessionId: parsed.sessionId ?? sessionId, event: { ...parsed.payload, sessionId: parsed.sessionId ?? sessionId } } as SessionEvent];
            return [];
          } catch {
            return [];
          }
        });
      records.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
      const highest = records.reduce((max, record) => Math.max(max, record.seq ?? 0), 0);
      this.sequences.set(sessionId, Math.max(this.sequences.get(sessionId) ?? 0, highest));
      return records;
    } catch {
      return [];
    }
  }

  async listSessions(): Promise<Session[]> {
    try {
      const entries = await readdir(join(this.root, 'sessions'), { withFileTypes: true });
      const sessions: Session[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const session = await this.readSession(entry.name);
        if (session) sessions.push(session);
      }
      return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(sessionId)) throw new Error('sessionId 参数无效');
    await Promise.all([
      rm(this.sessionDir(sessionId), { recursive: true, force: true }),
      rm(join(this.root, 'snapshots', sessionId), { recursive: true, force: true }),
    ]);
    this.sequences.delete(sessionId);
    this.appendQueues.delete(sessionId);
  }

  async writeSnapshot(sessionId: string, changeSetId: string, path: string, content: string | null): Promise<void> {
    const target = join(this.root, 'snapshots', sessionId, changeSetId, `${path.replace(/[:\\/]/g, '_')}.snapshot`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content ?? '__SEECODER_ABSENT__', 'utf8');
  }

  async readSnapshot(sessionId: string, changeSetId: string, path: string): Promise<string | null> {
    const target = join(this.root, 'snapshots', sessionId, changeSetId, `${path.replace(/[:\\/]/g, '_')}.snapshot`);
    try {
      const value = await readFile(target, 'utf8');
      return value === '__SEECODER_ABSENT__' ? null : value;
    } catch {
      return null;
    }
  }

  async writeState<T>(sessionId: string, state: T): Promise<void> {
    const directory = this.sessionDir(sessionId);
    await mkdir(directory, { recursive: true });
    const target = join(directory, 'state.json');
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
    await rename(temp, target);
  }

  async readState<T>(sessionId: string): Promise<T | null> {
    try { return JSON.parse(await readFile(join(this.sessionDir(sessionId), 'state.json'), 'utf8')) as T; } catch { return null; }
  }
}
