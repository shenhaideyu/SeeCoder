// Vitest 提供测试分组与断言函数。
import { describe, expect, it } from 'vitest';
// AgentEvent 用于让测试事件保持与真实协议一致。
import type { AgentEvent, ChangeSet } from '@seecoder/protocol';
// buildConversationRecords 是 TaskPage 将事件流整理成消息、工具和 Turn 操作区的纯函数。
import { buildConversationRecords } from '../apps/desktop/src/renderer/components/task-page';
// TimelineItem 在 AgentEvent 外附加持久化 seq，供历史分支定位。
import { changesForTurn, type TimelineItem } from '../apps/desktop/src/renderer/app/ui-store';

// timestamp 为所有测试事件提供稳定时间，测试不依赖真实时钟。
const timestamp = '2026-08-31T13:00:00.000Z';
// timeline 把 AgentEvent 与可选持久化序号包装成 Renderer 输入。
const timeline = (seq: number, event: AgentEvent): TimelineItem => ({ id: `seq-${seq}`, seq, event });

// TaskPage Turn 操作区测试覆盖中间消息、终态边界、文件归属和分支序号。
describe('Turn actions presentation', () => {
  // 验证每个 Turn 只有终态位置出现操作区，中间模型迭代不会各自生成按钮。
  it('creates one action footer per terminal turn with its final text and edited files', () => {
    // 第一轮包含两条助手消息和一次文件修改；第二轮只包含最终回答。
    const events: TimelineItem[] = [
      timeline(1, { type: 'message.user', timestamp, turnId: 'turn-1', text: '修改文件' }),
      timeline(2, { type: 'message.completed', timestamp, turnId: 'turn-1', text: '我先检查文件。' }),
      timeline(3, {
        type: 'changes.created',
        timestamp,
        changeSet: {
          id: 'change-1',
          turnId: 'turn-1',
          files: [{ path: 'src/app.ts', before: 'old', after: 'new' }],
          createdAt: timestamp,
        },
      }),
      timeline(4, {
        type: 'checkpoint.created',
        timestamp,
        turnId: 'turn-1',
        checkpoint: {
          id: 'checkpoint-turn-1',
          sessionId: 'session-1',
          turnId: 'turn-1',
          changeSetIds: ['change-1'],
          files: [{ path: 'src/app.ts', beforeHash: 'before', afterHash: 'after' }],
          createdAt: timestamp,
        },
      }),
      timeline(5, { type: 'message.completed', timestamp, turnId: 'turn-1', text: '修改已经完成。' }),
      timeline(6, {
        type: 'turn.completed',
        timestamp,
        turn: { id: 'turn-1', sessionId: 'session-1', status: 'completed', startedAt: timestamp, completedAt: timestamp, iteration: 2 },
      }),
      timeline(7, { type: 'message.user', timestamp, turnId: 'turn-2', text: '解释代码' }),
      timeline(8, { type: 'message.completed', timestamp, turnId: 'turn-2', text: '这是解释结果。' }),
      timeline(9, {
        type: 'turn.completed',
        timestamp,
        turn: { id: 'turn-2', sessionId: 'session-1', status: 'completed', startedAt: timestamp, completedAt: timestamp, iteration: 1 },
      }),
    ];
    // 调用纯整理函数得到实际 UI 记录。
    const records = buildConversationRecords(events);
    // 只筛选 Turn 底部操作区；两条中间/最终助手消息不能各自生成操作区。
    const actions = records.filter((record) => record.kind === 'turn-actions');
    // 两个终态 Turn 必须恰好对应两个操作区。
    expect(actions).toHaveLength(2);
    // 第一轮复制的是最后一条正文，并展示该轮编辑文件与终态 seq。
    expect(actions[0]).toMatchObject({
      kind: 'turn-actions',
      turnId: 'turn-1',
      eventSeq: 6,
      finalText: '修改已经完成。',
      editedFiles: ['src/app.ts'],
    });
    // 第二轮没有文件修改，但仍可复制答案并从其终态位置分支。
    expect(actions[1]).toMatchObject({
      kind: 'turn-actions',
      turnId: 'turn-2',
      eventSeq: 9,
      finalText: '这是解释结果。',
      editedFiles: [],
    });
    // 第一轮操作区必须位于该轮最终助手消息之后、第二轮用户消息之前。
    expect(records.findIndex((record) => record.id === 'turn-actions-turn-1')).toBeLessThan(
      records.findIndex((record) => record.kind === 'message' && record.message.type === 'message.user' && record.message.turnId === 'turn-2'),
    );
    // 第一轮恢复点应绑定到发起该轮的用户消息，而不是成为中间活动白条。
    expect(records.find((record) => record.kind === 'message' && record.message.type === 'message.user' && record.message.turnId === 'turn-1')).toMatchObject({
      checkpointId: 'checkpoint-turn-1',
    });
    // checkpoint.created 已被视图模型吸收，时间线中不能再出现独立恢复点活动。
    expect(records.some((record) => record.id === 'seq-4')).toBe(false);
  });

  // 验证从“已编辑文件”打开右侧面板时只显示被点击 Turn 的 ChangeSet。
  it('filters the right inspector changes to the selected turn', () => {
    // 两个 ChangeSet 分别属于不同 Turn，但可能修改同一个 Session。
    const changes: ChangeSet[] = [
      { id: 'change-1', turnId: 'turn-1', files: [{ path: 'src/one.ts', before: '', after: 'one' }], createdAt: timestamp },
      { id: 'change-2', turnId: 'turn-2', files: [{ path: 'src/two.ts', before: '', after: 'two' }], createdAt: timestamp },
    ];
    // 指定 turn-1 时右侧面板只能收到第一组变更。
    expect(changesForTurn(changes, 'turn-1').map((change) => change.id)).toEqual(['change-1']);
    // 用户直接打开普通变更页签时不指定 Turn，应显示当前 Session 的全部变更。
    expect(changesForTurn(changes).map((change) => change.id)).toEqual(['change-1', 'change-2']);
  });
});
