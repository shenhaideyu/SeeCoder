export type TurnStatus =
  | 'queued'
  | 'running'
  | 'waitingApproval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'limitReached';

export type PermissionMode = 'guided' | 'auto';
export type SubagentRole = 'explore' | 'review';

export interface Thread {
  id: string;
  title: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface Turn {
  id: string;
  threadId: string;
  status: TurnStatus;
  startedAt: string;
  completedAt?: string;
  iteration: number;
}

export interface PlanStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResult {
  ok: boolean;
  output?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
  durationMs: number;
}

export interface Approval {
  id: string;
  turnId: string;
  call: ToolCall;
  reason: string;
  risk: 'low' | 'medium' | 'high';
  status: 'pending' | 'approved' | 'denied';
}

export interface ChangeFile {
  path: string;
  before: string | null;
  after: string | null;
}

export interface ChangeSet {
  id: string;
  turnId: string;
  files: ChangeFile[];
  createdAt: string;
}

export interface SubagentState {
  id: string;
  parentTurnId: string;
  role: SubagentRole;
  task: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  summary?: string;
  evidence?: Array<{ path?: string; detail: string }>;
}

export interface AgentError {
  code: string;
  message: string;
  retryable: boolean;
}

export type Item =
  | { kind: 'user_message'; id: string; text: string; createdAt: string }
  | { kind: 'assistant_message'; id: string; text: string; createdAt: string }
  | { kind: 'plan'; id: string; steps: PlanStep[]; createdAt: string }
  | { kind: 'tool_call'; id: string; call: ToolCall; createdAt: string }
  | { kind: 'tool_result'; id: string; callId: string; result: ToolResult; createdAt: string }
  | { kind: 'approval'; id: string; approval: Approval; createdAt: string }
  | { kind: 'changes'; id: string; changeSet: ChangeSet; createdAt: string }
  | { kind: 'subagent'; id: string; state: SubagentState; createdAt: string }
  | { kind: 'compaction'; id: string; summary: string; createdAt: string }
  | { kind: 'error'; id: string; error: AgentError; createdAt: string };

export type AgentEvent =
  | { type: 'thread.created'; timestamp: string; thread: Thread }
  | { type: 'turn.started'; timestamp: string; turn: Turn }
  | { type: 'message.user'; timestamp: string; turnId: string; text: string }
  | { type: 'message.delta'; timestamp: string; turnId: string; text: string }
  | { type: 'message.completed'; timestamp: string; turnId: string; text: string }
  | { type: 'plan.updated'; timestamp: string; turnId: string; steps: PlanStep[] }
  | { type: 'tool.requested'; timestamp: string; turnId: string; call: ToolCall }
  | { type: 'approval.requested'; timestamp: string; approval: Approval }
  | { type: 'approval.resolved'; timestamp: string; approvalId: string; decision: 'allow' | 'deny'; reason?: string }
  | { type: 'tool.output'; timestamp: string; callId: string; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'tool.completed'; timestamp: string; turnId: string; callId: string; result: ToolResult }
  | { type: 'changes.created'; timestamp: string; changeSet: ChangeSet }
  | { type: 'changes.reverted'; timestamp: string; changeSetId: string }
  | { type: 'subagent.updated'; timestamp: string; child: SubagentState }
  | { type: 'context.compacted'; timestamp: string; turnId: string; summary: string }
  | { type: 'usage.updated'; timestamp: string; turnId: string; inputTokens: number; outputTokens: number }
  | { type: 'turn.completed'; timestamp: string; turn: Turn }
  | { type: 'turn.failed'; timestamp: string; turn: Turn; error: AgentError }
  | { type: 'turn.cancelled'; timestamp: string; turn: Turn };

export interface SessionEvent {
  event: AgentEvent;
  item?: Item;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
  tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>;
  model: string;
  temperature: number;
  maxOutputTokens: number;
}

export type ModelEvent =
  | { type: 'textDelta'; text: string }
  | { type: 'toolCallDelta'; callId: string; name?: string; argsDelta: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'completed'; finishReason: string }
  | { type: 'error'; code: string; message: string; retryable: boolean };

export interface ModelProvider {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
