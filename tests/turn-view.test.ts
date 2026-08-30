import { describe, expect, it } from 'vitest';
import type { AgentEvent, Turn } from '@seecoder/protocol';
import { latestTurnTerminal } from '../apps/desktop/src/renderer/turn-view';

const turn = (id: string, status: Turn['status']): Turn => ({
  id,
  sessionId: 'session-1',
  status,
  startedAt: '2026-08-30T00:00:00.000Z',
  iteration: 1,
});

describe('当前 Turn 终态选择', () => {
  it('新 Turn 开始后不再返回上一 Turn 的失败', () => {
    const events: AgentEvent[] = [
      { type: 'turn.started', timestamp: '2026-08-30T00:00:00.000Z', turn: turn('turn-a', 'running') },
      { type: 'turn.failed', timestamp: '2026-08-30T00:01:00.000Z', turn: turn('turn-a', 'failed'), error: { code: 'tool_error', message: '旧任务失败', retryable: false } },
      { type: 'turn.started', timestamp: '2026-08-30T00:02:00.000Z', turn: turn('turn-b', 'running') },
      { type: 'approval.requested', timestamp: '2026-08-30T00:02:01.000Z', approval: { id: 'approval-b', turnId: 'turn-b', call: { id: 'call-b', name: 'apply_patch', args: {} }, reason: '需要确认', risk: 'medium', status: 'pending' } },
    ];

    expect(latestTurnTerminal(events)).toBeUndefined();
  });

  it('返回最新 Turn 自己的完成结果', () => {
    const events: AgentEvent[] = [
      { type: 'turn.started', timestamp: '2026-08-30T00:00:00.000Z', turn: turn('turn-a', 'running') },
      { type: 'turn.failed', timestamp: '2026-08-30T00:01:00.000Z', turn: turn('turn-a', 'failed'), error: { code: 'tool_error', message: '旧任务失败', retryable: false } },
      { type: 'turn.started', timestamp: '2026-08-30T00:02:00.000Z', turn: turn('turn-b', 'running') },
      { type: 'turn.completed', timestamp: '2026-08-30T00:03:00.000Z', turn: turn('turn-b', 'completed') },
    ];

    expect(latestTurnTerminal(events)?.type).toBe('turn.completed');
  });
});
