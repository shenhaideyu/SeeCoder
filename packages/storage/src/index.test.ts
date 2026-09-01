import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@seecoder/protocol';
import { replaySessionEvents, SessionStore } from './index';

describe('SessionStore V3 JSONL', () => {
  it('deterministically rebuilds state and diagnoses invalid protocol records', () => {
    const turn = { id: 'turn-1', sessionId: 'session-1', status: 'running' as const, startedAt: '2026-01-01', iteration: 1 };
    const records: SessionEvent[] = [
      { version: 3, id: '2', seq: 2, sessionId: 'session-1', event: { type: 'assistant.tool_calls', timestamp: '2026-01-01', sessionId: 'session-1', turnId: turn.id, calls: [{ id: 'call-1', name: 'read_file', arguments: '{}' }] }, item: { kind: 'assistant_message', id: 'assistant', text: '', toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{}' }], createdAt: '2026-01-01' } },
      { version: 3, id: '1', seq: 1, sessionId: 'session-1', event: { type: 'turn.started', timestamp: '2026-01-01', sessionId: 'session-1', turn }, item: { kind: 'user_message', id: 'user', text: '读取文件', createdAt: '2026-01-01' } },
      { version: 3, id: '3', seq: 3, sessionId: 'session-1', event: { type: 'tool.completed', timestamp: '2026-01-01', sessionId: 'session-1', turnId: turn.id, callId: 'orphan', result: { ok: true, durationMs: 1 } }, item: { kind: 'tool_result', id: 'result', callId: 'orphan', result: { ok: true, durationMs: 1 }, createdAt: '2026-01-01' } },
      { version: 3, id: '4', seq: 4, sessionId: 'other', event: { type: 'message.user', timestamp: '2026-01-01', sessionId: 'other', turnId: 'turn-other', text: '串线' } },
    ];
    const replay = replaySessionEvents('session-1', records);
    expect(replay.records.map((record) => record.seq)).toEqual([1, 2, 3, 4]);
    expect(replay.unfinishedTurns).toEqual([turn]);
    expect(replay.modelItems.map((item) => item.kind)).toEqual(['user_message', 'assistant_message']);
    expect(replay.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(['out_of_order_seq', 'orphan_tool_result', 'cross_session_event']));
  });

  it('uses turn.reverted as a tombstone for records, model items and changes', () => {
    // 被撤销 Turn 的全部事件位于 tombstone 之前，模拟真实追加式日志。
    const records: SessionEvent[] = [
      { seq: 1, event: { type: 'message.user', timestamp: '2026-01-01', sessionId: 'session-1', turnId: 'turn-1', text: '需要删除' }, item: { kind: 'user_message', id: 'user-1', text: '需要删除', createdAt: '2026-01-01' } },
      { seq: 2, event: { type: 'message.completed', timestamp: '2026-01-01', sessionId: 'session-1', turnId: 'turn-1', text: '旧回答' }, item: { kind: 'assistant_message', id: 'assistant-1', text: '旧回答', createdAt: '2026-01-01' } },
      { seq: 3, event: { type: 'changes.created', timestamp: '2026-01-01', sessionId: 'session-1', changeSet: { id: 'change-1', sessionId: 'session-1', turnId: 'turn-1', files: [{ path: 'a.txt', before: 'a', after: 'b' }], createdAt: '2026-01-01' } } },
      { seq: 4, event: { type: 'message.user', timestamp: '2026-01-02', sessionId: 'session-1', turnId: 'turn-2', text: '保留内容' }, item: { kind: 'user_message', id: 'user-2', text: '保留内容', createdAt: '2026-01-02' } },
      { seq: 5, event: { type: 'turn.reverted', timestamp: '2026-01-03', sessionId: 'session-1', turnId: 'turn-1', checkpointId: 'checkpoint-1' } },
    ];
    // 回放器先预扫描 tombstone，再处理前面的旧事件。
    const replay = replaySessionEvents('session-1', records);
    // 可见轨迹只保留其他 Turn 和撤销事实本身。
    expect(replay.records.map((record) => record.seq)).toEqual([4, 5]);
    // 被撤销 Turn 的用户与助手 Item 不得进入后续模型上下文。
    expect(replay.modelItems).toEqual([{ kind: 'user_message', id: 'user-2', text: '保留内容', createdAt: '2026-01-02' }]);
    // 右侧变更索引不再包含目标 Turn 的 ChangeSet。
    expect(replay.changeSets).toEqual([]);
  });

  it('reads V3 records and ignores a damaged trailing line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-storage-'));
    try {
      const sessionDir = join(root, 'sessions', 'session-1');
      await (await import('node:fs/promises')).mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, 'meta.json'), JSON.stringify({ id: 'session-1', title: '历史', workspacePath: root, createdAt: '2026-01-01', updatedAt: '2026-01-01' }), 'utf8');
      await appendFile(join(sessionDir, 'events.jsonl'), `${JSON.stringify({ version: 3, sessionId: 'session-1', event: { type: 'message.user', timestamp: '2026-01-01', turnId: 'turn-1', text: '已有记录', sessionId: 'session-1' } })}\n{"broken"\n`, 'utf8');
      const store = new SessionStore(root);
      const events = await store.readEvents('session-1');
      expect(events).toHaveLength(1);
      expect(events[0]?.event.sessionId).toBe('session-1');
      await store.append('session-1', { event: { type: 'message.user', timestamp: '2026-01-02', turnId: 'turn-2', text: '新记录', sessionId: 'session-1' } });
      const next = await store.readEvents('session-1');
      expect(next.at(-1)).toMatchObject({ version: 3, type: 'message.user', sessionId: 'session-1', turnId: 'turn-2', timestamp: '2026-01-02' });
      expect(next.at(-1)?.payload?.type).toBe('message.user');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('serializes concurrent appends per session without reordering sequence numbers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-storage-order-'));
    try {
      const store = new SessionStore(root);
      await Promise.all(Array.from({ length: 40 }, (_, index) => store.append('session-order', {
        event: {
          type: 'tool.output',
          timestamp: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`,
          callId: 'command-1',
          stream: index % 2 ? 'stderr' : 'stdout',
          text: String(index),
          sessionId: 'session-order',
        },
      })));
      const events = await store.readEvents('session-order');
      expect(events.map((record) => record.seq)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
      expect(events.map((record) => record.event.type === 'tool.output' ? record.event.text : '')).toEqual(Array.from({ length: 40 }, (_, index) => String(index)));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('repairs V3 records whose physical line order differs from seq', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-storage-repair-order-'));
    try {
      const sessionDir = join(root, 'sessions', 'session-repair');
      await (await import('node:fs/promises')).mkdir(sessionDir, { recursive: true });
      const record = (seq: number, text: string) => JSON.stringify({
        version: 3,
        seq,
        sessionId: 'session-repair',
        event: { type: 'tool.output', timestamp: '2026-01-01', callId: 'command-1', stream: 'stdout', text, sessionId: 'session-repair' },
      });
      await writeFile(join(sessionDir, 'events.jsonl'), `${record(2, 'second')}\n${record(1, 'first')}\n`, 'utf8');
      const events = await new SessionStore(root).readEvents('session-repair');
      expect(events.map((event) => event.seq)).toEqual([1, 2]);
      expect(events.map((event) => event.event.type === 'tool.output' ? event.event.text : '')).toEqual(['first', 'second']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('deletes only the requested session and snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-storage-delete-'));
    try {
      const store = new SessionStore(root);
      const makeSession = (id: string) => ({ id, title: id, workspacePath: root, createdAt: '2026-01-01', updatedAt: '2026-01-01' });
      await store.saveSession(makeSession('session-one'));
      await store.saveSession(makeSession('session-two'));
      await store.writeSnapshot('session-one', 'change-1', 'a.ts', 'before');
      await store.deleteSession('session-one');
      expect(await store.readSession('session-one')).toBeNull();
      expect(await store.readSession('session-two')).not.toBeNull();
      await expect(store.deleteSession('../outside')).rejects.toThrow('sessionId 参数无效');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reads a branch as parent history through fork point plus local increments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-storage-branch-'));
    try {
      const store = new SessionStore(root);
      const base = { id: 'parent', title: '父分支', workspacePath: root, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
      await store.saveSession(base);
      for (const text of ['one', 'two', 'three']) {
        await store.append('parent', { event: { type: 'message.user', timestamp: '2026-01-01', turnId: text, text, sessionId: 'parent' } });
      }
      await store.saveSession({
        ...base,
        id: 'child',
        title: '子分支',
        lineage: { rootSessionId: 'parent', parentSessionId: 'parent', forkedFromSeq: 2, compactionFloor: 0 },
      });
      store.initializeSequence('child', 2);
      await store.append('child', { event: { type: 'message.user', timestamp: '2026-01-02', turnId: 'child', text: 'child', sessionId: 'child' } });
      await store.append('parent', { event: { type: 'message.user', timestamp: '2026-01-03', turnId: 'four', text: 'four', sessionId: 'parent' } });

      const child = await store.readEvents('child');
      expect(child.map((record) => record.seq)).toEqual([1, 2, 3]);
      expect(child.map((record) => record.event.type === 'message.user' ? record.event.text : '')).toEqual(['one', 'two', 'child']);
      expect(child.every((record) => record.event.sessionId === 'child')).toBe(true);
      expect(await store.hasChildBranches('parent')).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects cyclic branch metadata instead of recursing forever', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-storage-cycle-'));
    try {
      const store = new SessionStore(root);
      const common = { title: '循环', workspacePath: root, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
      await store.saveSession({ ...common, id: 'a', lineage: { rootSessionId: 'a', parentSessionId: 'b', forkedFromSeq: 0, compactionFloor: 0 } });
      await store.saveSession({ ...common, id: 'b', lineage: { rootSessionId: 'a', parentSessionId: 'a', forkedFromSeq: 0, compactionFloor: 0 } });
      await expect(store.readEvents('a')).rejects.toThrow('循环引用');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('allows a branch to read an artifact visible before its fork point', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-storage-branch-artifact-'));
    try {
      const store = new SessionStore(root);
      const common = { title: 'Artifact', workspacePath: root, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
      await store.saveSession({ ...common, id: 'artifact-parent' });
      const artifact = await store.writeArtifact('artifact-parent', 'call-1', 'read_file', '{"value":1}');
      await store.append('artifact-parent', { event: { type: 'artifact.created', timestamp: '2026-01-01', turnId: 'turn-1', artifact, sessionId: 'artifact-parent' } });
      await store.saveSession({ ...common, id: 'artifact-child', lineage: { rootSessionId: 'artifact-parent', parentSessionId: 'artifact-parent', forkedFromSeq: 1, compactionFloor: 0 } });
      await expect(store.readArtifact('artifact-child', artifact.id)).resolves.toMatchObject({ text: '{"value":1}' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
