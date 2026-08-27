export type TurnStatus =
  | 'queued'
  | 'running'
  | 'waitingApproval'
  | 'waitingInput'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'limitReached';

export type PermissionMode = 'guided' | 'auto';
export type ExecutionMode = 'plan' | PermissionMode;
export type SubagentRole = 'explore' | 'review';

export interface Thread {
  id: string;
  title: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  branch?: string;
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
  threadId?: string;
  turnId: string;
  files: ChangeFile[];
  createdAt: string;
}

export interface Checkpoint {
  id: string;
  threadId: string;
  turnId: string;
  changeSetIds: string[];
  files: Array<{ path: string; beforeHash: string | null; afterHash: string | null }>;
  createdAt: string;
}

export interface ReviewFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  explanation: string;
  path: string;
  line?: number;
  suggestion?: string;
}

export interface AttachmentRef {
  id: string;
  kind: 'text' | 'image' | 'file';
  name: string;
  path: string;
  mimeType: string;
  size: number;
}

export interface ScheduleDefinition {
  id: string;
  projectPath: string;
  prompt: string;
  cadence: 'manual' | 'hourly' | 'daily' | 'weekly';
  enabled: boolean;
  nextRunAt?: string;
}

export interface ThreadSummary extends Thread {
  status: 'idle' | 'running' | 'waitingInput' | 'waitingApproval' | 'completed' | 'failed';
  pinned: boolean;
  archived: boolean;
  unread: boolean;
  branch?: string;
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
  | { kind: 'assistant_message'; id: string; text: string; toolCalls?: ModelToolCall[]; createdAt: string }
  | { kind: 'plan'; id: string; steps: PlanStep[]; createdAt: string }
  | { kind: 'tool_call'; id: string; call: ToolCall; createdAt: string }
  | { kind: 'tool_result'; id: string; callId: string; result: ToolResult; createdAt: string }
  | { kind: 'approval'; id: string; approval: Approval; createdAt: string }
  | { kind: 'changes'; id: string; changeSet: ChangeSet; createdAt: string }
  | { kind: 'subagent'; id: string; state: SubagentState; createdAt: string }
  | { kind: 'compaction'; id: string; summary: string; createdAt: string }
  | { kind: 'error'; id: string; error: AgentError; createdAt: string };

export type AgentEventPayload =
  | { type: 'thread.created'; timestamp: string; thread: Thread }
  | { type: 'turn.started'; timestamp: string; turn: Turn }
  | { type: 'message.user'; timestamp: string; turnId: string; text: string }
  | { type: 'message.delta'; timestamp: string; turnId: string; text: string }
  | { type: 'message.completed'; timestamp: string; turnId: string; text: string }
  | { type: 'assistant.tool_calls'; timestamp: string; turnId: string; calls: ModelToolCall[] }
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
  | { type: 'model.requested'; timestamp: string; turnId: string; iteration: number }
  | { type: 'model.completed'; timestamp: string; turnId: string; iteration: number; durationMs: number; finishReason?: string; inputTokens?: number; outputTokens?: number; retries: number }
  | { type: 'turn.completed'; timestamp: string; turn: Turn }
  | { type: 'turn.failed'; timestamp: string; turn: Turn; error: AgentError }
  | { type: 'turn.cancelled'; timestamp: string; turn: Turn }
  | { type: 'mode.changed'; timestamp: string; mode: ExecutionMode }
  | { type: 'user.input.requested'; timestamp: string; turnId: string; requestId: string; question: string; choices?: string[] }
  | { type: 'user.input.resolved'; timestamp: string; turnId: string; requestId: string; answer: string }
  | { type: 'checkpoint.created'; timestamp: string; turnId: string; checkpoint: Checkpoint }
  | { type: 'checkpoint.restored'; timestamp: string; turnId?: string; checkpointId: string }
  | { type: 'review.started'; timestamp: string; turnId: string; scope: string }
  | { type: 'review.finding'; timestamp: string; turnId: string; finding: ReviewFinding }
  | { type: 'review.completed'; timestamp: string; turnId: string; findings: ReviewFinding[] }
  | { type: 'attachment.added'; timestamp: string; turnId?: string; attachment: AttachmentRef }
  | { type: 'notification.created'; timestamp: string; threadId: string; level: 'info' | 'success' | 'warning' | 'error'; title: string; body: string };

export type AgentEvent = AgentEventPayload & { threadId?: string };

export interface AgentEventEnvelope<T extends AgentEventPayload = AgentEventPayload> {
  version: 2;
  id: string;
  seq: number;
  type: T['type'];
  threadId: string;
  turnId?: string;
  timestamp: string;
  payload: T;
}

export interface SessionEvent {
  event: AgentEvent;
  payload?: AgentEvent;
  item?: Item;
  version?: 1 | 2;
  id?: string;
  seq?: number;
  threadId?: string;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ModelToolCall[];
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
  | { type: 'retry'; attempt: number }
  | { type: 'error'; code: string; message: string; retryable: boolean };

export interface ModelProvider {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
