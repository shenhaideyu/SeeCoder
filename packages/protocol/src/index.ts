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
export type HookStage = 'preToolUse' | 'postFileEdit' | 'turnEnd';

export interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  enabled: boolean;
  hasApiKey: boolean;
  keyStorage: 'environment' | 'os' | 'none';
  apiKeyHint?: string;
}

export interface ModelProfileInput {
  id?: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  enabled?: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  state: string;
  url: string;
  headRefName: string;
  isDraft: boolean;
}

export type PullRequestStatus =
  | { status: 'ready'; pullRequests: PullRequestSummary[] }
  | { status: 'setup_required'; reason: 'gh_not_installed' | 'gh_not_authenticated'; message: string; command: string }
  | { status: 'error'; message: string };

export interface HookCommand {
  id: string;
  command: string;
  timeoutMs: number;
}

export interface HookExecutionContext {
  sessionId: string;
  turnId: string;
  stage: HookStage;
  toolName?: string;
  callId?: string;
  changedPaths?: string[];
  turnStatus?: TurnStatus;
}

export interface Session {
  id: string;
  title: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  branch?: string;
  /** 事件分支谱系；旧 Session 没有该字段时视为自己的根分支。 */
  lineage?: SessionLineage;
}

export interface SessionLineage {
  rootSessionId: string;
  parentSessionId: string;
  forkedFromSeq: number;
  compactionFloor: number;
}

export interface Turn {
  id: string;
  sessionId: string;
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

export interface InterventionEventEntry {
  id: string;
  turnId: string;
  kind: 'steering' | 'followUp';
  text: string;
  createdAt: string;
  status: 'pending' | 'consumed' | 'discarded';
}

export interface SemanticSummary {
  userIntent: string;
  requirements: string[];
  activeDecisions: string[];
  supersededDecisions: string[];
  completedWork: string[];
  unresolvedQuestions: string[];
  narrative: string;
}

export interface ContextCompactionMetrics {
  beforeTokens: number;
  afterTokens: number;
  availableInput: number;
  compacted: boolean;
  summarySource?: 'model' | 'deterministic-fallback';
  retrievedEntries: number;
  droppedEvidence: number;
  tokenScale?: number;
  cheapPrunedGroups?: number;
  summaryUsed?: boolean;
}

export interface ContextSnapshot {
  id: string;
  sessionId: string;
  coveredEventSeq: number;
  retainedGroupIds: string[];
  ledgerRevision: number;
  modelKey: string;
  tokenScale: number;
  createdAt: string;
}

export interface ToolArtifact {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  mediaType: 'application/json';
  size: number;
  sha256: string;
  createdAt: string;
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
  sessionId?: string;
  turnId: string;
  files: ChangeFile[];
  createdAt: string;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
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

export interface LocalSkill {
  id: string;
  name: string;
  description: string;
  relativePath: string;
  scope?: 'workspace' | 'managed';
  sourcePath?: string;
}

export interface ScheduleDefinition {
  id: string;
  projectPath: string;
  prompt: string;
  cadence: 'manual' | 'hourly' | 'daily' | 'weekly';
  enabled: boolean;
  nextRunAt?: string;
}

export interface SessionSummary extends Session {
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
  iteration?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  currentAction?: string;
  errorCode?: string;
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
  | { kind: 'compaction'; id: string; summary: string; messages?: ModelMessage[]; semanticSummary?: SemanticSummary; snapshot?: ContextSnapshot; ledgerVersion?: 2; metrics?: ContextCompactionMetrics; createdAt: string }
  | { kind: 'error'; id: string; error: AgentError; createdAt: string };

export type AgentEventPayload =
  | { type: 'session.created'; timestamp: string; session: Session }
  | { type: 'turn.started'; timestamp: string; turn: Turn }
  | { type: 'message.user'; timestamp: string; turnId: string; text: string }
  | { type: 'message.delta'; timestamp: string; turnId: string; text: string }
  | { type: 'message.completed'; timestamp: string; turnId: string; text: string }
  | { type: 'intervention.queued'; timestamp: string; turnId: string; intervention: InterventionEventEntry }
  | { type: 'intervention.consumed'; timestamp: string; turnId: string; intervention: InterventionEventEntry }
  | { type: 'intervention.discarded'; timestamp: string; turnId: string; intervention: InterventionEventEntry; reason: string }
  | { type: 'assistant.tool_calls'; timestamp: string; turnId: string; calls: ModelToolCall[] }
  | { type: 'plan.updated'; timestamp: string; turnId: string; steps: PlanStep[] }
  | { type: 'tool.requested'; timestamp: string; turnId: string; call: ToolCall }
  | { type: 'approval.requested'; timestamp: string; approval: Approval }
  | { type: 'approval.resolved'; timestamp: string; approvalId: string; decision: 'allow' | 'deny'; reason?: string }
  | { type: 'tool.output'; timestamp: string; callId: string; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'tool.completed'; timestamp: string; turnId: string; callId: string; result: ToolResult }
  | { type: 'artifact.created'; timestamp: string; turnId: string; artifact: ToolArtifact }
  | { type: 'changes.created'; timestamp: string; changeSet: ChangeSet }
  | { type: 'changes.reverted'; timestamp: string; changeSetId: string }
  | { type: 'subagent.updated'; timestamp: string; child: SubagentState }
  | { type: 'context.summary.requested'; timestamp: string; turnId: string }
  | { type: 'context.summary.completed'; timestamp: string; turnId: string; durationMs: number; inputTokens?: number; outputTokens?: number }
  | { type: 'context.summary.failed'; timestamp: string; turnId: string; code: string; message: string }
  | { type: 'context.retrieved'; timestamp: string; turnId: string; count: number; kinds: string[] }
  | { type: 'context.compacted'; timestamp: string; turnId: string; summary: string; metrics?: ContextCompactionMetrics }
  | { type: 'usage.updated'; timestamp: string; turnId: string; inputTokens: number; outputTokens: number }
  | { type: 'model.requested'; timestamp: string; turnId: string; iteration: number }
  | { type: 'model.completed'; timestamp: string; turnId: string; iteration: number; durationMs: number; finishReason?: string; inputTokens?: number; outputTokens?: number; retries: number }
  | { type: 'turn.completed'; timestamp: string; turn: Turn }
  | { type: 'turn.failed'; timestamp: string; turn: Turn; error: AgentError }
  | { type: 'turn.cancelled'; timestamp: string; turn: Turn }
  | { type: 'turn.reverted'; timestamp: string; turnId: string; checkpointId: string }
  | { type: 'mode.changed'; timestamp: string; mode: ExecutionMode }
  | { type: 'user.input.requested'; timestamp: string; turnId: string; requestId: string; question: string; choices?: string[] }
  | { type: 'user.input.resolved'; timestamp: string; turnId: string; requestId: string; answer: string }
  | { type: 'checkpoint.created'; timestamp: string; turnId: string; checkpoint: Checkpoint }
  | { type: 'checkpoint.restored'; timestamp: string; turnId?: string; checkpointId: string }
  | { type: 'review.started'; timestamp: string; turnId: string; scope: string }
  | { type: 'review.finding'; timestamp: string; turnId: string; finding: ReviewFinding }
  | { type: 'review.completed'; timestamp: string; turnId: string; findings: ReviewFinding[] }
  | { type: 'attachment.added'; timestamp: string; turnId?: string; attachment: AttachmentRef }
  | { type: 'skill.activated'; timestamp: string; turnId: string; skill: LocalSkill }
  | { type: 'hook.started'; timestamp: string; turnId: string; stage: HookStage; hookId: string }
  | { type: 'hook.completed'; timestamp: string; turnId: string; stage: HookStage; hookId: string; ok: boolean; durationMs: number; errorCode?: string }
  | { type: 'notification.created'; timestamp: string; sessionId: string; level: 'info' | 'success' | 'warning' | 'error'; title: string; body: string };

export type AgentEvent = AgentEventPayload & { sessionId?: string };

export interface AgentEventEnvelope<T extends AgentEventPayload = AgentEventPayload> {
  version: 3;
  id: string;
  seq: number;
  type: T['type'];
  sessionId: string;
  turnId?: string;
  timestamp: string;
  payload: T;
}

export interface SessionEvent {
  event: AgentEvent;
  payload?: AgentEvent;
  item?: Item;
  version?: 3;
  id?: string;
  seq?: number;
  type?: AgentEvent['type'];
  sessionId?: string;
  turnId?: string;
  timestamp?: string;
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
  purpose?: 'agent' | 'context_summary';
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
