import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentCore } from '@seecoder/agent-core';
import type { ScheduleDefinition } from '@seecoder/protocol';

interface ScheduleServiceOptions {
  getCore: () => AgentCore;
  getWorkspace: () => string;
  sameWorkspace: (left: string, right: string) => boolean;
}

export class ScheduleService {
  private timer: NodeJS.Timeout | undefined;
  private readonly running = new Set<string>();
  private readonly scheduledTurns = new Map<string, string>();

  constructor(private readonly options: ScheduleServiceOptions) {}

  private async read(): Promise<ScheduleDefinition[]> {
    try {
      return JSON.parse(await readFile(join(app.getPath('userData'), 'schedules.json'), 'utf8')) as ScheduleDefinition[];
    } catch {
      return [];
    }
  }

  private async write(value: ScheduleDefinition[]): Promise<void> {
    const file = join(app.getPath('userData'), 'schedules.json');
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  }

  private nextRunAt(cadence: ScheduleDefinition['cadence']): string | undefined {
    if (cadence === 'manual') return undefined;
    const next = new Date();
    if (cadence === 'hourly') next.setHours(next.getHours() + 1);
    if (cadence === 'daily') next.setDate(next.getDate() + 1);
    if (cadence === 'weekly') next.setDate(next.getDate() + 7);
    return next.toISOString();
  }

  private visible(list: ScheduleDefinition[]): ScheduleDefinition[] {
    const workspace = this.options.getWorkspace();
    return list.filter((item) => this.options.sameWorkspace(item.projectPath, workspace));
  }

  async list(): Promise<ScheduleDefinition[]> {
    return this.visible(await this.read());
  }

  async save(input: ScheduleDefinition): Promise<ScheduleDefinition[]> {
    const workspace = this.options.getWorkspace();
    if (!input || !this.options.sameWorkspace(input.projectPath, workspace)) throw new Error('计划任务必须属于当前工作区');
    const list = await this.read();
    const nextAt = input.enabled ? (input.nextRunAt ?? this.nextRunAt(input.cadence)) : undefined;
    const value: ScheduleDefinition = { ...input, ...(nextAt ? { nextRunAt: nextAt } : {}) };
    const next = [...list.filter((item) => item.id !== input.id), value];
    await this.write(next);
    return this.visible(next);
  }

  async toggle(id: string, enabled: boolean): Promise<ScheduleDefinition[]> {
    const list = await this.read();
    const target = list.find((item) => item.id === id);
    if (!target) throw new Error('计划不存在');
    if (!this.options.sameWorkspace(target.projectPath, this.options.getWorkspace())) throw new Error('该计划属于其他工作区，请先切换工作区');
    const next = list.map((item) => (item.id === id ? { ...item, enabled } : item));
    await this.write(next);
    return this.visible(next);
  }

  async run(id: string): Promise<string> {
    const item = (await this.read()).find((value) => value.id === id);
    if (!item) throw new Error('计划不存在');
    if (!this.options.sameWorkspace(item.projectPath, this.options.getWorkspace())) throw new Error('该计划属于其他工作区，请先切换工作区');
    const core = this.options.getCore();
    const session = (await core.listSessions()).find((value) => this.options.sameWorkspace(value.workspacePath, item.projectPath)) ?? (await core.createSession(`计划：${item.prompt.slice(0, 40)}`));
    return core.startTurn(session.id, item.prompt, 'plan');
  }

  completeTurn(turnId: string): void {
    const scheduleId = this.scheduledTurns.get(turnId);
    if (!scheduleId) return;
    this.scheduledTurns.delete(turnId);
    this.running.delete(scheduleId);
  }

  start(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.tick();
    }, 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const list = await this.read();
    let changed = false;
    for (const item of list) {
      if (!item.enabled || !item.nextRunAt || Date.parse(item.nextRunAt) > now || this.running.has(item.id)) continue;
      this.running.add(item.id);
      try {
        const core = this.options.getCore();
        const session = (await core.listSessions()).find((value) => this.options.sameWorkspace(value.workspacePath, item.projectPath)) ?? (await core.createSession(`计划：${item.prompt.slice(0, 40)}`));
        const turnId = await core.startTurn(session.id, item.prompt, 'plan');
        this.scheduledTurns.set(turnId, item.id);
      } catch {
        this.running.delete(item.id);
      }
      const nextRunAt = this.nextRunAt(item.cadence);
      if (nextRunAt) item.nextRunAt = nextRunAt;
      else delete item.nextRunAt;
      changed = true;
    }
    if (changed) await this.write(list);
  }
}
