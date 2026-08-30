import type { AgentEvent } from '@seecoder/protocol';

export type TurnTerminalEvent = Extract<AgentEvent, { type: 'turn.completed' | 'turn.failed' | 'turn.cancelled' }>;

/**
 * 只返回最新 Turn 的终态。最新 Turn 仍在运行时返回 undefined，
 * 避免把上一 Turn 的失败或完成横幅误当成当前状态。
 */
export function latestTurnTerminal(events: AgentEvent[]): TurnTerminalEvent | undefined {
  const reversed = [...events].reverse();
  const latestStarted = reversed.find((event): event is Extract<AgentEvent, { type: 'turn.started' }> => event.type === 'turn.started');
  if (!latestStarted) {
    return reversed.find((event): event is TurnTerminalEvent =>
      event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled');
  }
  return reversed.find((event): event is TurnTerminalEvent =>
    (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled')
    && event.turn.id === latestStarted.turn.id);
}
