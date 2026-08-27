import { appendFile, mkdir, readFile, rename, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionEvent, Thread } from '@seecoder/protocol';

export class SessionStore {
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
    await appendFile(join(directory, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  }

  async readEvents(threadId: string): Promise<SessionEvent[]> {
    try {
      const text = await readFile(join(this.threadDir(threadId), 'events.jsonl'), 'utf8');
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as SessionEvent];
          } catch {
            return [];
          }
        });
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
}
