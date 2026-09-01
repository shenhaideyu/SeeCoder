import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentEvent } from '@seecoder/protocol';

export class MainLogger {
  private filePath: string | undefined;
  private queue = Promise.resolve();

  init(root: string): void {
    this.filePath = join(root, 'logs', 'main.log');
    this.queue = this.queue.then(async () => {
      await mkdir(join(root, 'logs'), { recursive: true });
    });
  }

  write(level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, unknown>): void {
    if (!this.filePath) return;
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    const line = `${new Date().toISOString()} [${level}] ${message}${suffix}\n`;
    this.queue = this.queue
      .then(async () => {
        await appendFile(this.filePath!, line, 'utf8');
      })
      .catch(() => undefined);
  }

  event(event: AgentEvent): void {
    const turnId = 'turnId' in event ? event.turnId : 'turn' in event ? event.turn.id : 'approval' in event ? event.approval.turnId : 'changeSet' in event ? event.changeSet.turnId : 'child' in event ? event.child.parentTurnId : undefined;
    const base = { type: event.type, sessionId: event.sessionId, turnId };
    if (event.type === 'tool.requested')
      this.write('INFO', 'agent.tool.requested', {
        ...base,
        callId: event.call.id,
        tool: event.call.name,
      });
    else if (event.type === 'tool.completed') {
      const controlled = event.result.error?.code === 'exploration_budget_exhausted';
      this.write(event.result.ok || controlled ? 'INFO' : 'WARN', 'agent.tool.completed', {
        ...base,
        callId: event.callId,
        ok: event.result.ok,
        controlled,
        durationMs: event.result.durationMs,
        error: event.result.error?.code,
      });
    } else if (event.type === 'tool.output')
      this.write('INFO', 'agent.tool.output', {
        ...base,
        callId: event.callId,
        stream: event.stream,
        bytes: event.text.length,
      });
    else if (event.type === 'model.completed')
      this.write('INFO', 'agent.model.completed', {
        ...base,
        iteration: event.iteration,
        durationMs: event.durationMs,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        retries: event.retries,
        finishReason: event.finishReason,
      });
    else if (event.type === 'context.summary.requested') this.write('INFO', 'agent.context.summary.requested', base);
    else if (event.type === 'context.summary.completed')
      this.write('INFO', 'agent.context.summary.completed', {
        ...base,
        durationMs: event.durationMs,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      });
    else if (event.type === 'context.summary.failed')
      this.write(event.code === 'cancelled' ? 'INFO' : 'WARN', 'agent.context.summary.failed', {
        ...base,
        code: event.code,
      });
    else if (event.type === 'context.retrieved')
      this.write('INFO', 'agent.context.retrieved', {
        ...base,
        count: event.count,
        kinds: event.kinds,
      });
    else if (event.type === 'context.compacted') this.write('INFO', 'agent.context.compacted', { ...base, ...event.metrics });
    else if (event.type === 'subagent.updated')
      this.write(event.child.status === 'failed' ? 'WARN' : 'INFO', 'agent.subagent.updated', {
        ...base,
        childId: event.child.id,
        role: event.child.role,
        status: event.child.status,
        iteration: event.child.iteration,
        durationMs: event.child.durationMs,
        inputTokens: event.child.inputTokens,
        outputTokens: event.child.outputTokens,
        currentAction: event.child.currentAction,
        error: event.child.errorCode,
      });
    else if (event.type === 'skill.activated')
      this.write('INFO', 'agent.skill.activated', {
        ...base,
        skillId: event.skill.id,
        skillName: event.skill.name,
      });
    else if (event.type === 'hook.started')
      this.write('INFO', 'agent.hook.started', {
        ...base,
        stage: event.stage,
        hookId: event.hookId,
      });
    else if (event.type === 'hook.completed')
      this.write(event.ok ? 'INFO' : 'WARN', 'agent.hook.completed', {
        ...base,
        stage: event.stage,
        hookId: event.hookId,
        ok: event.ok,
        durationMs: event.durationMs,
        error: event.errorCode,
      });
    else if (event.type === 'turn.started' || event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled')
      this.write(event.type === 'turn.failed' ? 'ERROR' : 'INFO', `agent.${event.type}`, {
        ...base,
        status: event.turn.status,
        iteration: event.turn.iteration,
        ...(event.type === 'turn.failed' ? { error: event.error.code } : {}),
      });
    else if (event.type === 'approval.requested' || event.type === 'approval.resolved' || event.type === 'checkpoint.created' || event.type === 'checkpoint.restored') this.write('INFO', `agent.${event.type}`, base);
  }
}
