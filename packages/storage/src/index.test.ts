import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from './index';

describe('SessionStore V2 JSONL', () => {
  it('reads V1 records and ignores a damaged trailing line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seecoder-storage-'));
    try {
      const threadDir = join(root, 'sessions', 'thread-1');
      await (await import('node:fs/promises')).mkdir(threadDir, { recursive: true });
      await writeFile(join(threadDir, 'meta.json'), JSON.stringify({ id: 'thread-1', title: '历史', workspacePath: root, createdAt: '2026-01-01', updatedAt: '2026-01-01' }), 'utf8');
      await appendFile(join(threadDir, 'events.jsonl'), `${JSON.stringify({ event: { type: 'message.user', timestamp: '2026-01-01', turnId: 'turn-1', text: '旧记录' } })}\n{"broken"\n`, 'utf8');
      const store = new SessionStore(root);
      const events = await store.readEvents('thread-1');
      expect(events).toHaveLength(1);
      expect(events[0]?.event.threadId).toBe('thread-1');
      await store.append('thread-1', { event: { type: 'message.user', timestamp: '2026-01-02', turnId: 'turn-2', text: '新记录', threadId: 'thread-1' } });
      const next = await store.readEvents('thread-1');
      expect(next.at(-1)?.version).toBe(2);
      expect(next.at(-1)?.payload?.type).toBe('message.user');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
