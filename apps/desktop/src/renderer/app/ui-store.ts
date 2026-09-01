import { create } from 'zustand';
import type {
  AgentEvent,
  Approval,
  ChangeSet,
  ExecutionMode,
  PlanStep,
  Session,
  SubagentState,
} from '@seecoder/protocol';

export interface TimelineItem {
  id: string;
  /** 持久化历史中的真实事件位置；实时事件落盘前可以暂时没有。 */
  seq?: number;
  event: AgentEvent;
}

// timelineTurnId 统一读取不同事件形状中的 Turn 归属，供实时撤销时删除整轮轨迹。
function timelineTurnId(event: AgentEvent): string | undefined {
  // 生命周期事件把 id 放在 turn 对象中。
  if (event.type === 'turn.started' || event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled') return event.turn.id;
  // ChangeSet 与审批使用各自嵌套对象。
  if (event.type === 'changes.created') return event.changeSet.turnId;
  // 审批请求属于发起工具的 Turn。
  if (event.type === 'approval.requested') return event.approval.turnId;
  // 子 Agent 状态属于父 Turn。
  if (event.type === 'subagent.updated') return event.child.parentTurnId;
  // 大多数运行事件和 turn.reverted 都直接携带 turnId。
  return 'turnId' in event && typeof event.turnId === 'string' ? event.turnId : undefined;
}
export type ToolRequestedEvent = Extract<AgentEvent, { type: 'tool.requested' }>;
export type ToolCompletedEvent = Extract<AgentEvent, { type: 'tool.completed' }>;
export type ActivityAuxiliaryEvent = Extract<AgentEvent, { type: 'context.compacted' }>;
export interface ActivityRecord {
  id: string;
  requested?: ToolRequestedEvent;
  completed?: ToolCompletedEvent;
  auxiliary?: ActivityAuxiliaryEvent;
}
export type ConversationRecord =
  | {
      id: string;
      kind: 'message';
      message: Extract<AgentEvent, { type: 'message.completed' | 'message.user' }>;
      /** 用户消息所属 Turn 的唯一恢复点；助手消息没有该字段。 */
      checkpointId?: string;
    }
  | { id: string; kind: 'activity'; activity: ActivityRecord }
  | { id: string; kind: 'activity-group'; activities: ActivityRecord[] }
  | {
      id: string;
      kind: 'turn-actions';
      turnId: string;
      eventSeq?: number;
      finalText: string;
      editedFiles: string[];
    };
export interface InputRequest {
  requestId: string;
  question: string;
  choices?: string[];
  turnId: string;
}
export type RunPhase = 'idle' | 'preparing' | 'model' | 'tool' | 'approval' | 'input' | 'review';
export interface UiState {
  sessions: Session[];
  selectedSession: Session | undefined;
  events: TimelineItem[];
  streamingText: string;
  approvals: Approval[];
  inputRequests: InputRequest[];
  plans: PlanStep[];
  changes: ChangeSet[];
  children: SubagentState[];
  running: boolean;
  phase: RunPhase;
  currentTurnId: string | undefined;
  mode: ExecutionMode;
  model: string;
  toast: string | undefined;
  reviewFindings: Array<{
    severity: string;
    title: string;
    path: string;
    line?: number;
    explanation: string;
  }>;
  set: (patch: Partial<UiState>) => void;
  addEvent: (event: AgentEvent, seq?: number) => void;
}

// 右侧变更面板默认显示全部 ChangeSet；从 Turn 底部打开时只显示该 Turn 的修改。
export function changesForTurn(changes: ChangeSet[], turnId?: string): ChangeSet[] {
  // 没有指定 Turn 表示用户从顶部变更页签进入，应保留当前 Session 的全部修改。
  if (!turnId) return changes;
  // ChangeSet 自带 turnId，因此无需根据文件名或时间进行不可靠推断。
  return changes.filter((change) => change.turnId === turnId);
}

export const useStore = create<UiState>((set) => ({
  sessions: [],
  selectedSession: undefined,
  events: [],
  streamingText: '',
  approvals: [],
  inputRequests: [],
  plans: [],
  changes: [],
  children: [],
  running: false,
  phase: 'idle',
  currentTurnId: undefined,
  mode: 'guided',
  model: 'gpt-4o-mini',
  toast: undefined,
  reviewFindings: [],
  set: (patch) => set(patch),
  addEvent: (event, seq) =>
    set((state) => {
      if (state.selectedSession && event.sessionId && event.sessionId !== state.selectedSession.id) return state;
      // 历史事件使用稳定 seq 作为 id；实时事件尚无 seq 时继续使用临时唯一值。
      const next = [...state.events, { id: seq === undefined ? `${Date.now()}-${Math.random()}` : `seq-${seq}`, ...(seq === undefined ? {} : { seq }), event }].slice(-800);
      if (event.type === 'message.delta')
        return {
          // Delta 只用于当前流式文本；持久保留会在长回复中挤掉工具、审批和终态事件。
          events: state.events,
          streamingText: `${state.streamingText}${event.text}`,
          running: true,
          phase: 'model',
          currentTurnId: event.turnId,
        };
      if (event.type === 'message.completed')
        return { events: next, streamingText: '', running: true, phase: 'preparing', currentTurnId: event.turnId };
      if (event.type === 'turn.started')
        return { events: next, running: true, phase: 'preparing', currentTurnId: event.turn.id };
      if (event.type === 'model.requested')
        return { events: next, running: true, phase: 'model', currentTurnId: event.turnId };
      if (event.type === 'tool.requested')
        return { events: next, running: true, phase: 'tool', currentTurnId: event.turnId };
      if (event.type === 'approval.requested')
        return {
          events: next,
          approvals: [...state.approvals, event.approval],
          running: true,
          phase: 'approval',
          currentTurnId: event.approval.turnId,
        };
      if (event.type === 'approval.resolved')
        {
          const approvals = state.approvals.filter((item) => item.id !== event.approvalId);
          return { events: next, approvals, phase: approvals.length ? 'approval' : 'preparing' };
        }
      if (event.type === 'user.input.requested')
        return {
          events: next,
          inputRequests: [
            ...state.inputRequests,
            {
              requestId: event.requestId,
              question: event.question,
              turnId: event.turnId,
              ...(event.choices ? { choices: event.choices } : {}),
            },
          ],
          running: true,
          phase: 'input',
          currentTurnId: event.turnId,
        };
      if (event.type === 'user.input.resolved')
        {
          const inputRequests = state.inputRequests.filter((item) => item.requestId !== event.requestId);
          return { events: next, inputRequests, phase: inputRequests.length ? 'input' : 'preparing' };
        }
      if (event.type === 'review.started') return { events: next, phase: 'review' };
      if (event.type === 'plan.updated') return { events: next, plans: event.steps };
      if (event.type === 'changes.created')
        return { events: next, changes: [...state.changes, event.changeSet] };
      if (event.type === 'changes.reverted')
        return {
          events: next,
          changes: state.changes.filter((item) => item.id !== event.changeSetId),
        };
      if (event.type === 'turn.reverted') {
        // 从实时事件数组中删除该 Turn 的用户消息、助手回答、工具、终态和 Checkpoint。
        const visibleEvents = next.filter((item) => item.event.type === 'turn.reverted' || timelineTurnId(item.event) !== event.turnId);
        // 右侧当前任务只保留其他 Turn 的 ChangeSet。
        const visibleChanges = state.changes.filter((item) => item.turnId !== event.turnId);
        // 计划面板回到删除后历史中最近一次仍可见的计划。
        const previousPlan = [...visibleEvents].reverse().find((item) => item.event.type === 'plan.updated');
        // 返回同步收敛后的界面状态；App 随后会从持久化历史完整重载一次。
        return {
          events: visibleEvents,
          changes: visibleChanges,
          plans: previousPlan?.event.type === 'plan.updated' ? previousPlan.event.steps : [],
          approvals: state.approvals.filter((item) => item.turnId !== event.turnId),
          inputRequests: state.inputRequests.filter((item) => item.turnId !== event.turnId),
          children: state.children.filter((item) => item.parentTurnId !== event.turnId),
          streamingText: '',
          running: false,
          phase: 'idle',
          currentTurnId: undefined,
        };
      }
      if (event.type === 'checkpoint.created' || event.type === 'checkpoint.restored')
        return { events: next };
      if (event.type === 'subagent.updated')
        return {
          events: next,
          children: [...state.children.filter((item) => item.id !== event.child.id), event.child],
        };
      if (event.type === 'review.finding')
        return { events: next, reviewFindings: [...state.reviewFindings, event.finding] };
      if (event.type === 'mode.changed') return { events: next, mode: event.mode };
      if (
        event.type === 'turn.completed' ||
        event.type === 'turn.failed' ||
        event.type === 'turn.cancelled'
      )
        return {
          events: next,
          running: false,
          phase: 'idle',
          streamingText: '',
          currentTurnId: undefined,
          approvals: state.approvals.filter((item) => item.turnId !== event.turn.id),
          inputRequests: state.inputRequests.filter((item) => item.turnId !== event.turn.id),
        };
      return { events: next };
    }),
}));
