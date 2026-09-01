import { appendFile, mkdir, readFile, rename, writeFile, readdir, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AgentEvent, ChangeSet, Checkpoint, Item, SessionEvent, Session, ToolArtifact, Turn } from '@seecoder/protocol';

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

/** 从不同事件形状中取得所属 Turn；没有 Turn 语义的 Session 事件返回 undefined。 */
function eventTurnId(event: AgentEvent): string | undefined {
  // Turn 生命周期事件把 id 放在 turn 对象中。
  if (event.type === 'turn.started' || event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled') return event.turn.id;
  // ChangeSet 和子 Agent 使用自己的结构保存所属 Turn。
  if (event.type === 'changes.created') return event.changeSet.turnId;
  // 审批事件通过 approval 指向发起工具的 Turn。
  if (event.type === 'approval.requested') return event.approval.turnId;
  // 子 Agent 状态通过 parentTurnId 指回父 Turn。
  if (event.type === 'subagent.updated') return event.child.parentTurnId;
  // 其余带 turnId 的事件可以直接读取；turn.reverted 也属于这一类。
  return 'turnId' in event && typeof event.turnId === 'string' ? event.turnId : undefined;
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
  // sortedRecords 先建立稳定事件顺序，撤销标记可能出现在被撤销 Turn 之后。
  const sortedRecords = input.map((record, index) => ({ record, index }))
    .sort((left, right) => ((left.record.seq ?? left.index + 1) - (right.record.seq ?? right.index + 1)) || left.index - right.index)
    .map(({ record }) => record);
  // revertedTurns 预扫描全部撤销标记，保证即使旧 Turn 在标记前面也会从回放结果中消失。
  const revertedTurns = new Set(
    sortedRecords
      .filter((record): record is SessionEvent & { event: Extract<AgentEvent, { type: 'turn.reverted' }> } => record.event.type === 'turn.reverted')
      .map((record) => record.event.turnId),
  );
  // callTurns 让不携带 turnId 的流式 tool.output 也能随所属 Turn 一起隐藏。
  const callTurns = new Map<string, string>();
  // tool.requested 同时含 callId 与 turnId，可建立稳定关联。
  for (const record of sortedRecords) if (record.event.type === 'tool.requested') callTurns.set(record.event.call.id, record.event.turnId);
  // 保留撤销标记本身用于审计，其余属于目标 Turn 的事件和 Item 都不再对上层可见。
  const records = sortedRecords.filter((record) => {
    // tombstone 必须留下，否则下一次回放无法知道目标 Turn 已撤销。
    if (record.event.type === 'turn.reverted') return true;
    // 普通事件优先直接取 turnId；tool.output 通过 callId 反查。
    const turnId = eventTurnId(record.event) ?? (record.event.type === 'tool.output' ? callTurns.get(record.event.callId) : undefined);
    // 没有 Turn 归属的 Session 级事件继续保留。
    return !turnId || !revertedTurns.has(turnId);
  });
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

  getLastSequence(sessionId: string): number {
    return this.sequences.get(sessionId) ?? 0;
  }

  /** 新分支的第一条增量事件必须从父分支截断点之后继续编号。 */
  initializeSequence(sessionId: string, sequence: number): void {
    this.sequences.set(sessionId, Math.max(this.sequences.get(sessionId) ?? 0, sequence));
  }

  async writeArtifact(sessionId: string, toolCallId: string, toolName: string, content: string): Promise<ToolArtifact> {
    const id = randomUUID();
    const directory = join(this.sessionDir(sessionId), 'artifacts');
    await mkdir(directory, { recursive: true });
    const artifact: ToolArtifact = {
      id,
      sessionId,
      toolCallId,
      toolName,
      mediaType: 'application/json',
      size: Buffer.byteLength(content, 'utf8'),
      sha256: createHash('sha256').update(content).digest('hex'),
      createdAt: new Date().toISOString(),
    };
    const contentTarget = join(directory, `${id}.json`);
    const metadataTarget = join(directory, `${id}.meta.json`);
    await writeFile(`${contentTarget}.tmp`, content, 'utf8');
    await rename(`${contentTarget}.tmp`, contentTarget);
    await writeFile(`${metadataTarget}.tmp`, JSON.stringify(artifact, null, 2), 'utf8');
    await rename(`${metadataTarget}.tmp`, metadataTarget);
    return artifact;
  }

  async readArtifact(
    sessionId: string,
    artifactId: string,
    offset = 0,
    limit = 16_000,
  ): Promise<{ artifact: ToolArtifact; text: string; offset: number; nextOffset?: number }> {
    if (!/^[a-f0-9-]{36}$/i.test(artifactId)) throw new Error('artifactRef 参数无效');
    let ownerSessionId = sessionId;
    let artifact: ToolArtifact;
    try {
      artifact = JSON.parse(await readFile(join(this.sessionDir(ownerSessionId), 'artifacts', `${artifactId}.meta.json`), 'utf8')) as ToolArtifact;
    } catch {
      const visible = (await this.readEvents(sessionId)).find(
        (record) => record.event.type === 'artifact.created' && record.event.artifact.id === artifactId,
      );
      if (!visible || visible.event.type !== 'artifact.created') throw new Error('Artifact 不属于当前 Session');
      ownerSessionId = visible.event.artifact.sessionId;
      artifact = JSON.parse(await readFile(join(this.sessionDir(ownerSessionId), 'artifacts', `${artifactId}.meta.json`), 'utf8')) as ToolArtifact;
    }
    if (artifact.sessionId !== ownerSessionId || artifact.id !== artifactId) throw new Error('Artifact 不属于当前 Session');
    const directory = join(this.sessionDir(ownerSessionId), 'artifacts');
    const content = await readFile(join(directory, `${artifactId}.json`), 'utf8');
    const safeOffset = Math.max(0, Math.min(offset, content.length));
    const safeLimit = Math.max(1, Math.min(limit, 50_000));
    const end = Math.min(content.length, safeOffset + safeLimit);
    return {
      artifact,
      text: content.slice(safeOffset, end),
      offset: safeOffset,
      ...(end < content.length ? { nextOffset: end } : {}),
    };
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

  private async readOwnEvents(sessionId: string): Promise<SessionEvent[]> {
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

  /** 读取当前分支可见历史：父分支截止点 + 当前分支自己的增量事件。 */
  async readEvents(sessionId: string): Promise<SessionEvent[]> {
    return this.readBranchEvents(sessionId, new Set());
  }

  private async readBranchEvents(sessionId: string, visiting: Set<string>): Promise<SessionEvent[]> {
    if (visiting.has(sessionId)) throw new Error(`Session 分支存在循环引用：${sessionId}`);
    visiting.add(sessionId);
    try {
      const session = await this.readSession(sessionId);
      const own = await this.readOwnEvents(sessionId);
      if (!session?.lineage) return own;
      const parent = await this.readBranchEvents(session.lineage.parentSessionId, visiting);
      const inherited = parent
        .filter((record) => (record.seq ?? 0) <= session.lineage!.forkedFromSeq)
        .map((record) => this.rebaseRecord(record, sessionId));
      const records = [...inherited, ...own].sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
      const highest = records.reduce((max, record) => Math.max(max, record.seq ?? 0), session.lineage.forkedFromSeq);
      this.initializeSequence(sessionId, highest);
      return records;
    } finally {
      visiting.delete(sessionId);
    }
  }

  private rebaseRecord(record: SessionEvent, sessionId: string): SessionEvent {
    const event = { ...record.event, sessionId } as AgentEvent;
    return { ...record, sessionId, event, payload: event };
  }

  /** 最新压缩 Item 所在序号是最早边界，保证分支一定包含替代旧历史的摘要。 */
  async getCompactionFloor(sessionId: string): Promise<number> {
    let floor = 0;
    for (const record of await this.readEvents(sessionId)) {
      if (record.item?.kind === 'compaction' && record.item.snapshot) {
        floor = Math.max(floor, record.seq ?? record.item.snapshot.coveredEventSeq);
      }
    }
    return floor;
  }

  async hasChildBranches(sessionId: string): Promise<boolean> {
    return (await this.listSessions()).some((session) => session.lineage?.parentSessionId === sessionId);
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
