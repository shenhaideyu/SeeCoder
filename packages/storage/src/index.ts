import { appendFile, mkdir, readFile, rename, writeFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AgentEvent, SessionEvent, Thread } from '@seecoder/protocol';

export class SessionStore {
  private readonly sequences = new Map<string, number>();

  constructor(private readonly root: string) {}

  private threadDir(threadId: string): string {
    return join(this.root, 'sessions', threadId);
  }

  async saveThread(thread: Thread): Promise<void> {
    const directory = this.threadDir(thread.id);
    await mkdir(directory, { recursive: true });
    const target = join(directory, 'meta.json');
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(thread, null, 2), 'utf8');
    await rename(temp, target);
  }

  async readThread(threadId: string): Promise<Thread | null> {
    try {
      return JSON.parse(await readFile(join(this.threadDir(threadId), 'meta.json'), 'utf8')) as Thread;
    } catch {
      return null;
    }
  }

  async append(threadId: string, event: SessionEvent): Promise<void> {
    const directory = this.threadDir(threadId);
    await mkdir(directory, { recursive: true });
    const next = (this.sequences.get(threadId) ?? 0) + 1;
    this.sequences.set(threadId, next);
    const persisted: SessionEvent = {
      ...event,
      version: 2,
      id: event.id ?? randomUUID(),
      seq: event.seq ?? next,
      threadId: event.threadId ?? threadId,
      event: { ...event.event, threadId: event.event.threadId ?? threadId },
      payload: { ...event.event, threadId: event.event.threadId ?? threadId },
    };
    await appendFile(join(directory, 'events.jsonl'), `${JSON.stringify(persisted)}\n`, 'utf8');
  }

  async readEvents(threadId: string): Promise<SessionEvent[]> {
    try {
      const text = await readFile(join(this.threadDir(threadId), 'events.jsonl'), 'utf8');
      const records = text
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const parsed = JSON.parse(line) as Partial<SessionEvent> & { payload?: AgentEvent };
            if (parsed.event) return [{ ...parsed, threadId: parsed.threadId ?? threadId, event: { ...parsed.event, threadId: parsed.event.threadId ?? threadId } } as SessionEvent];
            if (parsed.payload) return [{ version: 2, id: parsed.id ?? randomUUID(), seq: parsed.seq, threadId: parsed.threadId ?? threadId, event: { ...parsed.payload, threadId: parsed.threadId ?? threadId } } as SessionEvent];
            return [];
          } catch {
            return [];
          }
        });
      const highest = records.reduce((max, record) => Math.max(max, record.seq ?? 0), 0);
      this.sequences.set(threadId, Math.max(this.sequences.get(threadId) ?? 0, highest));
      return records;
    } catch {
      return [];
    }
  }

  async listThreads(): Promise<Thread[]> {
    try {
      const entries = await readdir(join(this.root, 'sessions'), { withFileTypes: true });
      const threads: Thread[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const thread = await this.readThread(entry.name);
        if (thread) threads.push(thread);
      }
      return threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }

  async writeSnapshot(threadId: string, changeSetId: string, path: string, content: string | null): Promise<void> {
    const target = join(this.root, 'snapshots', threadId, changeSetId, `${path.replace(/[:\\/]/g, '_')}.snapshot`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content ?? '__SEECODER_ABSENT__', 'utf8');
  }

  async readSnapshot(threadId: string, changeSetId: string, path: string): Promise<string | null> {
    const target = join(this.root, 'snapshots', threadId, changeSetId, `${path.replace(/[:\\/]/g, '_')}.snapshot`);
    try {
      const value = await readFile(target, 'utf8');
      return value === '__SEECODER_ABSENT__' ? null : value;
    } catch {
      return null;
    }
  }

  async writeState<T>(threadId: string, state: T): Promise<void> {
    const directory = this.threadDir(threadId);
    await mkdir(directory, { recursive: true });
    const target = join(directory, 'state.json');
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
    await rename(temp, target);
  }

  async readState<T>(threadId: string): Promise<T | null> {
    try { return JSON.parse(await readFile(join(this.threadDir(threadId), 'state.json'), 'utf8')) as T; } catch { return null; }
  }
}
