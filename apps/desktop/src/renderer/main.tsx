import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { Editor } from '@monaco-editor/react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  Activity,
  AlertTriangle,
  Bell,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Code2,
  Command,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  FilePlus2,
  FolderOpen,
  GitBranch,
  GitFork,
  History,
  ImagePlus,
  KeyRound,
  ListChecks,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PanelRight,
  PanelRightClose,
  Pin,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  Upload,
  Users,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  AgentEvent,
  Approval,
  AttachmentRef,
  ChangeSet,
  ExecutionMode,
  LocalSkill,
  ModelProfile,
  ModelProfileInput,
  PlanStep,
  ScheduleDefinition,
  SubagentState,
  Session,
  ToolResult,
} from '@seecoder/protocol';
import type { SeeCoderApi } from '../preload/preload';
import { formatToolActivity } from './tool-activity';
import { latestTurnTerminal } from './turn-view';
import { ChangeDiffViewer, PatchDiffPreview } from './diff-viewer';
import './styles.css';

interface SettingsView {
  workspace: string;
  mode: ExecutionMode;
  model: string;
  recentModels: string[];
  baseUrl: string;
  contextWindow: number;
  maxOutputTokens: number;
  hasApiKey: boolean;
  keyStorage: 'environment' | 'os' | 'none';
  apiKeyHint?: string;
  activeModelProfileId: string;
  modelProfiles: ModelProfile[];
  logPath?: string;
}
type SettingsUpdate = Parameters<SeeCoderApi['settings']['update']>[0];

const previewSession: Session = {
  id: 'preview-session',
  title: '界面预览任务',
  workspacePath: 'Preview',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const previewResult = (output: unknown) => Promise.resolve({ ok: true, output, durationMs: 0 });
const previewApi: SeeCoderApi = {
  workspace: {
    select: async () => ({ cancelled: true }),
    list: async () => ({ current: 'Preview', recent: ['Preview'] }),
    switch: async (workspace: string) => ({ workspace }),
    open: async () => 'Preview',
  },
  session: {
    create: async (title?: string) => ({
      ...previewSession,
      id: `preview-${Date.now()}`,
      title: title ?? previewSession.title,
    }),
    list: async () => [previewSession],
    hydrate: async () => previewSession,
    history: async () => [],
    rename: async (_id, title) => ({ ...previewSession, title }),
    flag: async () => previewSession,
    delete: async (sessionId) => ({ deleted: true, sessionId }),
    fork: async () => previewSession,
    search: async () => [previewSession],
    export: async () => ({ cancelled: true }),
  },
  turn: {
    start: async () => 'preview-turn',
    followUp: async () => undefined,
    cancel: async () => undefined,
  },
  approval: { resolve: async () => undefined },
  input: { resolve: async () => undefined },
  plan: { approve: async () => 'guided' },
  changes: { revert: async () => ({ ok: true }) },
  checkpoint: { list: async () => [], restore: async () => ({ ok: true }) },
  files: {
    list: async () => previewResult([]),
    read: async () => previewResult({ text: '' }),
    search: async () => previewResult([]),
  },
  attachment: { select: async () => [] },
  git: {
    status: async () => previewResult({ output: '' }),
    diff: async () => previewResult({ output: '' }),
    branches: async () => previewResult({ output: 'main' }),
    checkout: async () => previewResult({}),
    stage: async () => previewResult({}),
    unstage: async () => previewResult({}),
    revert: async () => previewResult({}),
    commit: async () => previewResult({}),
    push: async () => previewResult({}),
    prStatus: async () => previewResult({}),
  },
  terminal: { run: async () => previewResult({ stdout: '', stderr: '', exitCode: 0 }) },
  preview: { open: async (url) => url },
  extension: { list: async () => [], import: async () => ({ cancelled: true }), refresh: async () => [], rename: async () => [], delete: async () => [], openSource: async () => '', trustHooks: async () => [] },
  schedule: {
    list: async () => [],
    save: async (value) => [value],
    toggle: async () => [],
    run: async () => 'preview-turn',
  },
  settings: {
    read: async () => ({
      workspace: 'Preview / Browser',
      mode: 'guided' as const,
      model: 'preview',
      recentModels: ['preview'],
      activeModelProfileId: 'preview',
      modelProfiles: [{ id: 'preview', name: 'Preview', provider: 'OpenAI 兼容', model: 'preview', baseUrl: '', enabled: true, hasApiKey: false, keyStorage: 'none' as const }],
      baseUrl: '',
      contextWindow: 128000,
      maxOutputTokens: 8192,
      hasApiKey: false,
      keyStorage: 'none' as const,
    }),
    update: async () => ({
      workspace: 'Preview / Browser',
      mode: 'guided' as const,
      model: 'preview',
      recentModels: ['preview'],
      activeModelProfileId: 'preview',
      modelProfiles: [{ id: 'preview', name: 'Preview', provider: 'OpenAI 兼容', model: 'preview', baseUrl: '', enabled: true, hasApiKey: false, keyStorage: 'none' as const }],
      baseUrl: '',
      contextWindow: 128000,
      maxOutputTokens: 8192,
      hasApiKey: false,
      keyStorage: 'none' as const,
    }),
  },
  events: { subscribe: () => () => undefined },
  menu: { subscribe: () => () => undefined },
};
const runtimeWindow = window as Window & { seecoder?: SeeCoderApi };
if (!runtimeWindow.seecoder) runtimeWindow.seecoder = previewApi;

interface TimelineItem {
  id: string;
  event: AgentEvent;
}
type ToolRequestedEvent = Extract<AgentEvent, { type: 'tool.requested' }>;
type ToolCompletedEvent = Extract<AgentEvent, { type: 'tool.completed' }>;
type ActivityAuxiliaryEvent = Extract<AgentEvent, { type: 'context.compacted' | 'checkpoint.created' }>;
interface ActivityRecord {
  id: string;
  requested?: ToolRequestedEvent;
  completed?: ToolCompletedEvent;
  auxiliary?: ActivityAuxiliaryEvent;
}
type ConversationRecord =
  | { id: string; kind: 'message'; message: Extract<AgentEvent, { type: 'message.completed' | 'message.user' }> }
  | { id: string; kind: 'activity'; activity: ActivityRecord }
  | { id: string; kind: 'activity-group'; activities: ActivityRecord[] };
interface InputRequest {
  requestId: string;
  question: string;
  choices?: string[];
  turnId: string;
}
type RunPhase = 'idle' | 'preparing' | 'model' | 'tool' | 'approval' | 'input' | 'review';
interface UiState {
  sessions: Session[];
  selectedSession: Session | undefined;
  events: TimelineItem[];
  streamingText: string;
  approvals: Approval[];
  inputRequests: InputRequest[];
  plans: PlanStep[];
  changes: ChangeSet[];
  children: SubagentState[];
  terminal: string[];
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
  addEvent: (event: AgentEvent) => void;
}

const useStore = create<UiState>((set) => ({
  sessions: [],
  selectedSession: undefined,
  events: [],
  streamingText: '',
  approvals: [],
  inputRequests: [],
  plans: [],
  changes: [],
  children: [],
  terminal: [],
  running: false,
  phase: 'idle',
  currentTurnId: undefined,
  mode: 'guided',
  model: 'gpt-4o-mini',
  toast: undefined,
  reviewFindings: [],
  set: (patch) => set(patch),
  addEvent: (event) =>
    set((state) => {
      if (state.selectedSession && event.sessionId && event.sessionId !== state.selectedSession.id) return state;
      const next = [...state.events, { id: `${Date.now()}-${Math.random()}`, event }].slice(-800);
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
      if (event.type === 'checkpoint.created' || event.type === 'checkpoint.restored')
        return { events: next };
      if (event.type === 'subagent.updated')
        return {
          events: next,
          children: [...state.children.filter((item) => item.id !== event.child.id), event.child],
        };
      if (event.type === 'review.finding')
        return { events: next, reviewFindings: [...state.reviewFindings, event.finding] };
      if (event.type === 'tool.output')
        return {
          events: next,
          terminal: [...state.terminal, `[${event.stream}] ${event.text}`].slice(-700),
        };
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

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const resultOutput = (value: unknown): unknown =>
  value && typeof value === 'object' && 'output' in value
    ? (value as { output?: unknown }).output
    : value;
const formatCommandOutput = (value: unknown): string => {
  const output = resultOutput(value);
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const command = output as { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
    if (typeof command.stdout === 'string' || typeof command.stderr === 'string') {
      const body = [command.stdout, command.stderr].filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n');
      return body || `退出码：${String(command.exitCode ?? '未知')}`;
    }
  }
  return JSON.stringify(output ?? '', null, 2);
};

const toolPresentation: Record<string, { label: string; description: string }> = {
  list_files: { label: '浏览项目文件', description: '查看目录结构' },
  read_file: { label: '读取文件', description: '读取项目上下文' },
  read_files: { label: '批量读取文件', description: '收集相关代码上下文' },
  search_text: { label: '搜索代码', description: '定位相关实现' },
  write_file: { label: '写入文件', description: '更新工作区内容' },
  apply_patch: { label: '应用代码修改', description: '更新工作区内容' },
  run_command: { label: '运行命令', description: '执行验证或构建' },
  git_diff: { label: '检查代码变更', description: '读取 Git Diff' },
  set_plan: { label: '更新执行计划', description: '同步任务进度' },
  delegate: { label: '委派子 Agent', description: '并行收集只读证据' },
  review_changes: { label: '审查代码变更', description: '检查缺陷与测试缺口' },
  checkpoint: { label: '创建恢复点', description: '保存当前修改快照' },
  compact_context: { label: '整理上下文', description: '压缩较早的任务记录' },
  ask_user: { label: '请求用户确认', description: '等待补充信息' },
  finish: { label: '完成任务', description: '汇总变更与验证证据' },
};

const isToolControlSignal = (result: ToolResult | undefined): boolean =>
  result?.error?.code === 'exploration_budget_exhausted';

function friendlyAgentError(message: string): { title: string; summary: string } {
  if (/tool_call_id|deserialize|invalid_request_error/i.test(message)) {
    return {
      title: '模型接口格式不兼容',
      summary: '兼容接口拒绝了工具调用上下文。可重试任务；若仍失败，请检查模型与接口配置。',
    };
  }
  if (/401|unauthorized|api.?key/i.test(message)) {
    return { title: '模型鉴权失败', summary: '请在设置中检查 API Key，然后重新尝试。' };
  }
  if (/429|rate.?limit/i.test(message)) {
    return { title: '请求过于频繁', summary: '模型服务暂时限流，请稍后重新尝试。' };
  }
  if (/timeout|timed out/i.test(message)) {
    return { title: '执行超时', summary: '模型或工具未在限制时间内完成，可缩小任务范围后重试。' };
  }
  return {
    title: '任务未完成',
    summary: message.length > 180 ? `${message.slice(0, 177)}…` : message,
  };
}

function InlineMarkdown({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          return <code key={`${index}-${part}`}>{part.slice(1, -1)}</code>;
        }
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={`${index}-${part}`}>{part.slice(2, -2)}</strong>;
        }
        return <React.Fragment key={`${index}-${part}`}>{part}</React.Fragment>;
      })}
    </>
  );
}

function MarkdownMessage({ text }: { text: string }): React.JSX.Element {
  const blocks = text.split(/(```[\s\S]*?```)/g).filter(Boolean);
  return (
    <div className="markdown-message">
      {blocks.map((block, blockIndex) => {
        if (block.startsWith('```') && block.endsWith('```')) {
          const body = block.slice(3, -3).replace(/^[^\n]*\n/, '');
          return <pre key={`${blockIndex}-${block.slice(0, 12)}`}><code>{body}</code></pre>;
        }
        return block.split(/\r?\n/).map((line, lineIndex) => {
          const trimmed = line.trim();
          if (!trimmed) return <span className="markdown-gap" key={`${blockIndex}-${lineIndex}`} />;
          const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
          if (bullet) {
            return <div className="markdown-list-item" key={`${blockIndex}-${lineIndex}`}><span>•</span><div><InlineMarkdown text={bullet[1] ?? ''} /></div></div>;
          }
          return <div className="markdown-line" key={`${blockIndex}-${lineIndex}`}><InlineMarkdown text={line} /></div>;
        });
      })}
    </div>
  );
}

interface PromptRequest {
  title: string;
  value?: string;
  description?: string;
  placeholder?: string;
  confirm?: boolean;
  submitLabel?: string;
}

function PromptDialog({
  request,
  onResolve,
}: {
  request: PromptRequest | undefined;
  onResolve: (value: string | null) => void;
}): React.JSX.Element | null {
  const [value, setValue] = useState(request?.value ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setValue(request?.value ?? '');
    if (request) window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [request]);
  if (!request) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onResolve(null); }}>
      <div className="prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="prompt-dialog-title">
        <div className="prompt-dialog-head">
          <strong id="prompt-dialog-title">{request.title}</strong>
          <button className="icon-button" data-action="dialog-close" title="关闭" aria-label="关闭" onClick={() => onResolve(null)}><X size={15} /></button>
        </div>
        {request.description && <p>{request.description}</p>}
        {!request.confirm && (
          <input
            ref={inputRef}
            autoFocus
            value={value}
            placeholder={request.placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); onResolve(value); }
              if (event.key === 'Escape') { event.preventDefault(); onResolve(null); }
            }}
          />
        )}
        <div className="prompt-dialog-actions">
          <button className="small-button" data-action="dialog-cancel" onClick={() => onResolve(null)}>取消</button>
          <button className="small-button primary" data-action="dialog-submit" onClick={() => onResolve(request.confirm ? '__confirm__' : value)}>
            {request.submitLabel ?? (request.confirm ? '确认' : '确定')}
          </button>
        </div>
      </div>
    </div>
  );
}

function App(): React.JSX.Element {
  const state = useStore();
  const {
    sessions,
    selectedSession,
    events,
    streamingText,
    approvals,
    inputRequests,
    plans,
    changes,
    children,
    terminal,
    running,
    phase,
    currentTurnId,
    mode,
    model,
    toast,
    reviewFindings,
  } = state;
  const set = state.set;
  const addEvent = state.addEvent;
  const [workspace, setWorkspace] = useState('未选择工作区');
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);
  const [modelProfiles, setModelProfiles] = useState<ModelProfile[]>([]);
  const [page, setPage] = useState<
    'task' | 'history' | 'pulls' | 'sites' | 'scheduled' | 'plugins' | 'settings' | 'about'
  >('task');
  const [inspector, setInspector] = useState<
    'changes' | 'files' | 'terminal' | 'preview' | 'trace'
  >('changes');
  const [composer, setComposer] = useState('');
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [activeSkill, setActiveSkill] = useState<LocalSkill>();
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [files, setFiles] = useState<string[]>([]);
  const [gitText, setGitText] = useState('');
  const [filePreview, setFilePreview] = useState<{ path: string; text: string } | undefined>();
  const [promptDialog, setPromptDialog] = useState<PromptRequest>();
  const promptResolver = useRef<((value: string | null) => void) | null>(null);
  const loadToken = useRef(0);

  function requestPrompt(request: PromptRequest): Promise<string | null> {
    return new Promise((resolve) => {
      promptResolver.current = resolve;
      setPromptDialog(request);
    });
  }
  function resolvePrompt(value: string | null): void {
    const resolver = promptResolver.current;
    promptResolver.current = null;
    setPromptDialog(undefined);
    resolver?.(value);
  }

  useEffect(() => {
    const unsubscribe = window.seecoder.events.subscribe(addEvent);
    const menuUnsubscribe = window.seecoder.menu.subscribe((action) => {
      if (action === 'new-session') void newSession();
      if (action === 'command-palette') window.dispatchEvent(new Event('seecoder:command'));
      if (action === 'toggle-inspector') setCollapsed((value) => !value);
      if (action === 'about') setPage('about');
      if (action === 'help') setPage('about');
    });
    void (async () => {
      const settings = await window.seecoder.settings.read();
      setWorkspace(settings.workspace);
      const workspaceList = await window.seecoder.workspace.list();
      setRecentWorkspaces(workspaceList.recent);
      set({ mode: settings.mode, model: settings.model });
      setModelProfiles(settings.modelProfiles ?? []);
      const list = (await window.seecoder.session.list()) as Session[];
      if (list.length) {
        set({ sessions: list, selectedSession: list[0] });
        await loadSession(list[0]!);
      } else {
        const created = (await window.seecoder.session.create('首个 SeeCoder 任务')) as Session;
        set({ sessions: [created], selectedSession: created });
      }
    })();
    return () => {
      unsubscribe();
      menuUnsubscribe();
    };
  }, [addEvent, set]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        window.dispatchEvent(new Event('seecoder:command'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => set({ toast: undefined }), 2600);
    return () => window.clearTimeout(timer);
  }, [toast, set]);
  useEffect(() => {
    const describe = (value: unknown): string => {
      const message = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
      if (message) return message.split(/\r?\n/)[0]!.slice(0, 240);
      return '未知错误';
    };
    const onError = (event: ErrorEvent) => set({ toast: `操作失败：${describe(event.error ?? event.message)}` });
    const onRejection = (event: PromiseRejectionEvent) => set({ toast: `操作失败：${describe(event.reason)}` });
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [set]);

  async function loadSession(session: Session): Promise<void> {
    const token = ++loadToken.current;
    set({
      events: [],
      changes: [],
      children: [],
      terminal: [],
      approvals: [],
      inputRequests: [],
      plans: [],
      reviewFindings: [],
      streamingText: '',
      running: false,
      phase: 'idle',
      currentTurnId: undefined,
    });
    await window.seecoder.session.hydrate(session.id);
    const history = (await window.seecoder.session.history(session.id)) as AgentEvent[];
    if (token !== loadToken.current || useStore.getState().selectedSession?.id !== session.id) return;
    history.forEach(addEvent);
  }
  async function selectSession(session: Session): Promise<void> {
    set({ selectedSession: session });
    setPage('task');
    await loadSession(session);
  }
  async function newSession(): Promise<Session> {
    loadToken.current += 1;
    setActiveSkill(undefined);
    const created = (await window.seecoder.session.create('新的 SeeCoder 任务')) as Session;
    const currentSessions = useStore.getState().sessions;
    set({
      sessions: [created, ...currentSessions.filter((session) => session.id !== created.id)],
      selectedSession: created,
      events: [],
      approvals: [],
      inputRequests: [],
      plans: [],
      changes: [],
      children: [],
      terminal: [],
      reviewFindings: [],
      streamingText: '',
      running: false,
      phase: 'idle',
      currentTurnId: undefined,
    });
    setPage('task');
    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-action="composer"]')?.focus());
    return created;
  }
  async function chooseWorkspace(): Promise<void> {
    const selected = (await window.seecoder.workspace.select()) as {
      cancelled: boolean;
      workspace?: string;
    };
    if (!selected.cancelled && selected.workspace) {
      await loadWorkspace(selected.workspace);
    }
  }
  async function switchRecentWorkspace(nextWorkspace: string): Promise<void> {
    if (nextWorkspace === workspace) return;
    const selected = await window.seecoder.workspace.switch(nextWorkspace);
    await loadWorkspace(selected.workspace);
  }
  async function loadWorkspace(nextWorkspace: string): Promise<void> {
    setWorkspace(nextWorkspace);
    const workspaceList = await window.seecoder.workspace.list();
    setRecentWorkspaces(workspaceList.recent);
    const workspaceSessions = (await window.seecoder.session.list()) as Session[];
    const selected = workspaceSessions[0] ?? (await window.seecoder.session.create('新工作区任务')) as Session;
    set({
      sessions: workspaceSessions.length ? workspaceSessions : [selected],
      selectedSession: selected,
      events: [], approvals: [], inputRequests: [], plans: [], changes: [], children: [], terminal: [], reviewFindings: [], streamingText: '', running: false, phase: 'idle', currentTurnId: undefined,
    });
    await loadSession(selected);
    setPage('task');
  }
  async function send(): Promise<void> {
    const text = composer.trim();
    if (!text || !selectedSession) return;
    const shouldSuggestTitle = /^新的 SeeCoder 任务$|^新工作区任务$/.test(selectedSession.title);
    const suggestedTitle = (text.split(/\r?\n/)[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 42);
    setComposer('');
    try {
      if (running && currentTurnId) {
        await window.seecoder.turn.followUp(currentTurnId, text);
        set({ toast: '已加入当前任务的追加要求' });
        return;
      }
      set({ running: true, phase: 'preparing', streamingText: '' });
      const turnId = (await window.seecoder.turn.start(
        selectedSession.id,
        text,
        attachments,
        activeSkill?.id,
      )) as string;
      set({ currentTurnId: turnId });
      if (shouldSuggestTitle && suggestedTitle) {
        void window.seecoder.session.rename(selectedSession.id, suggestedTitle).then((renamed) => {
          set({
            sessions: sessions.map((session) => session.id === renamed.id ? renamed : session),
            selectedSession: renamed,
          });
        }).catch(() => undefined);
      }
      setAttachments([]);
      setActiveSkill(undefined);
    } catch (error) {
      set({ running: false, phase: 'idle', currentTurnId: undefined, toast: `任务启动失败：${error instanceof Error ? error.message : '请检查模型配置'}` });
    }
  }
  async function setExecutionMode(next: ExecutionMode): Promise<void> {
    if (next === mode) return;
    await window.seecoder.settings.update({ mode: next });
    set({
      mode: next,
      toast: `已切换到 ${next === 'plan' ? 'Plan' : next === 'guided' ? 'Guided' : 'Auto'} 模式`,
    });
  }
  async function togglePlan(): Promise<void> {
    if (mode === 'plan') {
      await window.seecoder.plan.approve();
      set({ mode: 'guided', toast: '计划已批准，进入 Guided 执行' });
    } else {
      await window.seecoder.settings.update({ mode: 'plan' });
      set({ mode: 'plan', toast: '下一轮将只读分析并生成计划' });
    }
  }
  async function replan(): Promise<void> { if (!selectedSession) return; set({ running: true, phase: 'preparing' }); const turnId = (await window.seecoder.turn.start(selectedSession.id, '请根据当前目标和已有证据重新规划执行步骤。')) as string; set({ currentTurnId: turnId, toast: '已请求重新规划' }); }
  async function editPlanStep(id: string): Promise<void> {
    const label = await requestPrompt({ title: '编辑计划步骤', placeholder: '输入新的步骤描述…' });
    if (label?.trim()) set({ plans: plans.map((step) => step.id === id ? { ...step, label: label.trim() } : step), toast: '计划步骤已更新（将在下一轮同步给模型）' });
  }
  async function selectModel(profileId: string): Promise<void> {
    if (running) return;
    try {
      const settings = await window.seecoder.settings.update({ activeModelProfileId: profileId });
      set({ model: settings.model, toast: `已切换到 ${settings.model}` });
      setModelProfiles(settings.modelProfiles ?? []);
    } catch (error) {
      set({ toast: `模型切换失败：${error instanceof Error ? error.message : '请检查模型配置'}` });
    }
  }
  async function resolveApproval(approval: Approval, decision: 'allow' | 'deny'): Promise<void> {
    await window.seecoder.approval.resolve(
      approval.id,
      decision,
      decision === 'deny' ? '用户拒绝了此动作' : undefined,
    );
  }
  async function resolveInput(request: InputRequest, answer: string): Promise<void> {
    await window.seecoder.input.resolve(request.requestId, answer);
  }
  async function attach(): Promise<void> {
    const selected = await window.seecoder.attachment.select();
    setAttachments([...attachments, ...selected].slice(0, 4));
  }
  async function loadFiles(): Promise<void> {
    const value = (await window.seecoder.files.list('.', 3)) as { output?: unknown };
    const output = resultOutput(value);
    setFiles(
      Array.isArray(output)
        ? output.filter((item): item is string => typeof item === 'string')
        : [],
    );
  }
  async function openFile(path: string): Promise<void> {
    const value = (await window.seecoder.files.read(path)) as { output?: unknown };
    const output = resultOutput(value) as { text?: unknown } | undefined;
    setFilePreview({ path, text: typeof output?.text === 'string' ? output.text : '无法读取文本内容' });
  }
  async function loadGit(): Promise<void> {
    setGitText('正在读取 Git 状态…');
    try {
      const value = (await window.seecoder.git.status()) as { output?: unknown };
      setGitText(formatCommandOutput(value));
    } catch (error) {
      const raw = error instanceof Error ? error.message : '无法读取 Git 状态';
      const marker = 'Git 操作已禁用';
      const message = raw.includes(marker) ? raw.slice(raw.indexOf(marker)) : `Git 状态读取失败：${raw}`;
      setGitText(message);
      set({ toast: message });
    }
  }
  useEffect(() => {
    if (page === 'task' && selectedSession) void loadGit();
  }, [page, selectedSession?.id]);
  async function copyText(text: string): Promise<void> {
    await navigator.clipboard?.writeText(text);
    set({ toast: '已复制到剪贴板' });
  }
  async function renameSession(): Promise<void> {
    if (!selectedSession) return;
    const title = await requestPrompt({ title: '重命名任务', value: selectedSession.title, placeholder: '输入任务名称…' });
    if (!title?.trim()) return;
    const renamed = (await window.seecoder.session.rename(
      selectedSession.id,
      title.trim(),
    )) as Session;
    set({
      selectedSession: renamed,
      sessions: sessions.map((item) => (item.id === renamed.id ? renamed : item)),
    });
  }
  async function exportSession(format: 'markdown' | 'json'): Promise<void> {
    if (selectedSession) {
      await window.seecoder.session.export(selectedSession.id, format);
      set({ toast: '已打开导出对话框' });
    }
  }
  async function forkSession(): Promise<void> {
    const source = useStore.getState().selectedSession;
    if (!source) return;
    if (useStore.getState().running) {
      set({ toast: '任务运行中不能 Fork，请等待完成或先停止任务' });
      return;
    }
    const forked = (await window.seecoder.session.fork(source.id)) as Session | null;
    if (!forked) {
      set({ toast: 'Fork 失败：原任务不存在或不属于当前工作区' });
      return;
    }
    const currentSessions = useStore.getState().sessions;
    set({ sessions: [forked, ...currentSessions.filter((item) => item.id !== forked.id)] });
    await selectSession(forked);
    set({ toast: '已创建 Session Fork' });
  }
  async function showSessionMenu(): Promise<void> {
    if (!selectedSession) return;
    const action = await requestPrompt({
      title: '任务操作',
      description: '输入 pin 置顶、archive 归档、fork 创建副本或 export 导出对话。',
      placeholder: 'pin / archive / fork / export',
    });
    if (action === 'pin' || action === 'archive') {
      const updated = (await window.seecoder.session.flag(
        selectedSession.id,
        action === 'pin' ? 'pinned' : 'archived',
      )) as Session;
      set({
        selectedSession: updated,
        sessions: sessions.map((item) => (item.id === updated.id ? updated : item)),
        toast: action === 'pin' ? '任务已置顶' : '任务已归档',
      });
    } else if (action === 'fork') {
      await forkSession();
    } else if (action === 'export') await exportSession('markdown');
  }
  async function manageSession(session: Session, action: 'rename' | 'pin' | 'archive' | 'delete'): Promise<void> {
    if (action === 'rename') {
      const title = await requestPrompt({ title: '重命名任务', value: session.title, placeholder: '输入任务名称…' });
      if (!title?.trim()) return;
      const updated = (await window.seecoder.session.rename(session.id, title.trim())) as Session;
      set({ sessions: useStore.getState().sessions.map((item) => item.id === updated.id ? updated : item), ...(selectedSession?.id === updated.id ? { selectedSession: updated } : {}), toast: '任务已重命名' });
      return;
    }
    if (action === 'pin' || action === 'archive') {
      const flag = action === 'pin' ? 'pinned' : 'archived';
      const updated = (await window.seecoder.session.flag(session.id, flag)) as Session;
      const nextSessions = useStore.getState().sessions.map((item) => item.id === updated.id ? updated : item);
      set({ sessions: nextSessions, ...(selectedSession?.id === updated.id ? { selectedSession: updated } : {}), toast: flag === 'pinned' ? (updated.pinned ? '任务已置顶' : '已取消置顶') : '任务已归档，可在执行历史中查看' });
      if (flag === 'archived' && selectedSession?.id === updated.id) {
        const next = nextSessions.find((item) => !item.archived && item.id !== updated.id);
        if (next) await selectSession(next); else await newSession();
      }
      return;
    }
    const confirmed = await requestPrompt({ title: '删除任务', description: `将删除“${session.title}”的 SeeCoder 对话、轨迹和快照。项目文件不会被删除。此操作无法撤销。`, confirm: true, submitLabel: '删除' });
    if (confirmed !== '__confirm__') return;
    await window.seecoder.session.delete(session.id);
    const nextSessions = (await window.seecoder.session.list()) as Session[];
    set({ sessions: nextSessions, toast: '任务已删除' });
    if (useStore.getState().selectedSession?.id === session.id) {
      const next = nextSessions.find((item) => !item.archived);
      if (next) await selectSession(next); else await newSession();
    }
  }
  async function showBranches(): Promise<void> {
    try {
      const result = await window.seecoder.git.branches();
      const listing = formatCommandOutput(result) || '未找到 Git 仓库';
      const selected = await requestPrompt({
        title: '切换本地分支',
        description: `当前分支列表：\n${listing}`,
        placeholder: '输入分支名称；留空仅查看列表',
      });
      if (selected?.trim()) {
        const switched = await window.seecoder.git.checkout(selected.trim());
        set({ toast: String(resultOutput(switched) ?? `已切换到 ${selected.trim()}`) });
        await loadGit();
      } else set({ toast: listing });
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法读取本地分支';
      set({ toast: `分支操作失败：${message}` });
    }
  }
  async function stageFile(path: string): Promise<void> {
    const result = await window.seecoder.git.stage(path);
    set({ toast: resultOutput(result) ? `已暂存 ${path}` : 'Stage 未完成，请检查 Git 状态' });
  }
  async function restoreCheckpoint(id: string): Promise<void> { const result = await window.seecoder.checkpoint.restore(id); set({ toast: resultOutput(result) ? 'Checkpoint 已恢复' : 'Checkpoint 恢复失败' }); await loadGit(); }
  function retryLastTask(): void {
    const lastUserMessage = [...events]
      .reverse()
      .map((item) => item.event)
      .find((event): event is Extract<AgentEvent, { type: 'message.user' }> => event.type === 'message.user');
    if (!lastUserMessage) {
      set({ toast: '没有可重试的任务内容' });
      return;
    }
    setComposer(lastUserMessage.text);
    set({ toast: '上次任务已放回输入框，可修改后重新发送' });
  }
  function feedback(kind: 'like' | 'dislike'): void {
    set({ toast: kind === 'like' ? '感谢反馈，已记录为有帮助' : '已记录改进反馈' });
  }
  async function showCommandPalette(): Promise<void> {
    const command = await requestPrompt({
      title: '命令面板',
      description: '选择快捷命令：/plan、/review、/diff、/compact、/status、/skills。',
      placeholder: '/plan',
    });
    if (command === '/plan') await togglePlan();
    else if (command === '/review') {
      setPage('task');
      setInspector('trace');
      if (selectedSession) {
        set({ running: true, phase: 'preparing' });
        const turnId = (await window.seecoder.turn.start(selectedSession.id, '请调用 review_changes 审查当前工作区变更，并按严重度输出发现。')) as string;
        set({ currentTurnId: turnId });
      } else set({ toast: '请先选择任务' });
    } else if (command === '/diff') setInspector('changes');
    else if (command === '/status') {
      await loadGit();
      setInspector('files');
    } else if (command === '/skills') setPage('plugins');
    else if (command === '/compact') {
      setPage('task');
      setInspector('trace');
      if (selectedSession) {
        set({ running: true, phase: 'preparing' });
        try {
          const turnId = (await window.seecoder.turn.start(selectedSession.id, '请立即调用 compact_context 整理当前对话上下文；完成后只简要报告压缩结果，不执行其他工具。')) as string;
          set({ currentTurnId: turnId });
        } catch (error) {
          set({ running: false, phase: 'idle', toast: `压缩启动失败：${error instanceof Error ? error.message : '请稍后重试'}` });
        }
      } else set({ toast: '请先选择任务' });
    }
  }
  useEffect(() => {
    const listener = () => void showCommandPalette();
    window.addEventListener('seecoder:command', listener);
    return () => window.removeEventListener('seecoder:command', listener);
  });

  const visibleSessions = sessions.filter(
    (session) =>
      !session.archived && (!search || session.title.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <div className={`app-shell ${theme}`}>
      <Sidebar
        workspace={workspace}
        recentWorkspaces={recentWorkspaces}
        page={page}
        setPage={setPage}
        sessions={visibleSessions}
        selectedSession={selectedSession}
        onSession={selectSession}
        onWorkspace={chooseWorkspace}
        onWorkspaceSwitch={switchRecentWorkspace}
        onNew={newSession}
        onSearch={() => {
          void requestPrompt({ title: '搜索任务', value: search, placeholder: '输入任务标题、消息或分支…' }).then((value) => {
            if (value !== null) {
              setSearch(value);
              setPage('history');
            }
          });
        }}
        onNotify={() => set({ toast: '通知中心：当前没有新的未读活动' })}
        onTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        onManageSession={manageSession}
      />
      <main className={`main-column ${collapsed ? 'wide' : ''} ${page !== 'task' ? 'workspace-view' : ''}`}>
        {page === 'task' ? (
          <TaskPage
            selectedSession={selectedSession}
            mode={mode}
            running={running}
            phase={phase}
            streamingText={streamingText}
            events={events}
            plans={plans}
            approvals={approvals}
            inputRequests={inputRequests}
            children={children}
            reviewFindings={reviewFindings}
            expanded={expanded}
            setExpanded={setExpanded}
            onApproval={resolveApproval}
            onInput={resolveInput}
            onPlan={togglePlan}
            onReplan={replan}
            onEditPlan={editPlanStep}
            onRename={renameSession}
            onExport={exportSession}
            onCopy={copyText}
            onFeedback={feedback}
            onFork={forkSession}
            onMenu={showSessionMenu}
            onBranch={showBranches}
            onRestoreCheckpoint={restoreCheckpoint}
            onRetry={retryLastTask}
            onOpenInspector={() => { setCollapsed(false); setInspector('trace'); }}
          />
        ) : (
          <WorkspacePage
            page={page}
            workspace={workspace}
            sessions={sessions}
            gitText={gitText}
            onRefreshGit={loadGit}
            onNew={newSession}
            onOpenSession={selectSession}
            onToast={(value) => set({ toast: value })}
            onModelChange={(value, profiles) => { set({ model: value }); setModelProfiles(profiles); }}
            onUseSkill={async (skill) => { await newSession(); setActiveSkill(skill); setComposer(''); setPage('task'); set({ toast: `已启用 ${skill.name}，请输入本次任务目标` }); }}
            onRequestPrompt={requestPrompt}
          />
        )}
        {page === 'task' && (
          <Composer
            value={composer}
            setValue={setComposer}
            running={running}
            mode={mode}
            model={model}
            modelProfiles={modelProfiles}
            attachments={attachments}
            activeSkill={activeSkill}
            onAttach={attach}
            onModeSelect={setExecutionMode}
            onModelSelect={selectModel}
            onSend={send}
  onCancel={() => currentTurnId && void window.seecoder.turn.cancel(currentTurnId)}
  onSettings={() => setPage('settings')}
            onToast={(value) => set({ toast: value })}
            onClearSkill={() => setActiveSkill(undefined)}
          />
        )}
      </main>
      {!collapsed && page === 'task' && (
        <aside className="inspector">
          <div className="inspector-head">
            <div className="inspector-tabs">
              {(
                [
                  ['changes', '变更', GitBranch],
                  ['files', '文件', FolderOpen],
                  ['terminal', '终端', Terminal],
                  ['preview', '预览', ExternalLink],
                  ['trace', '轨迹', Activity],
                ] as const
              ).map(([key, label, Icon]) => (
                <button
                  key={key}
                  data-action={`inspector-${key}`}
                  className={inspector === key ? 'active' : ''}
                  title={label}
                  aria-label={label}
                  onClick={() => {
                    setInspector(key);
                    if (key === 'files') void loadFiles();
                    if (key === 'files' || key === 'changes') void loadGit();
                  }}
                >
                  <Icon size={14} />
                  <span>{label}</span>
                  {key === 'changes' && changes.length > 0 && <b>{changes.length}</b>}
                </button>
              ))}
            </div>
            <button
              className="icon-button"
              data-action="collapse-inspector"
              title="收起检查器"
              onClick={() => setCollapsed(true)}
            >
              <PanelRightClose size={16} />
            </button>
          </div>
          <InspectorContent
            type={inspector}
            changes={changes}
            terminal={terminal}
            children={children}
            workspace={workspace}
            events={events}
            files={files}
            filePreview={filePreview}
            gitText={gitText}
            onRevert={(id) => void window.seecoder.changes.revert(id)}
            onStage={stageFile}
            onOpenFile={openFile}
            onGitRefresh={loadGit}
            onToast={(value) => set({ toast: value })}
            onPrompt={(request) => requestPrompt(request)}
            onConfirm={(message) => requestPrompt({ title: '请确认操作', description: message, confirm: true }).then((value) => value === '__confirm__')}
          />
        </aside>
      )}
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          <Check size={14} />
          {toast}
        </div>
      )}
      <PromptDialog request={promptDialog} onResolve={resolvePrompt} />
    </div>
  );
}

function Sidebar({
  workspace,
  recentWorkspaces,
  page,
  setPage,
  sessions,
  selectedSession,
  onSession,
  onWorkspace,
  onWorkspaceSwitch,
  onNew,
  onSearch,
  onNotify,
  onTheme,
  onManageSession,
}: {
  workspace: string;
  recentWorkspaces: string[];
  page: string;
  setPage: (
    page: 'task' | 'history' | 'pulls' | 'sites' | 'scheduled' | 'plugins' | 'settings' | 'about',
  ) => void;
  sessions: Session[];
  selectedSession: Session | undefined;
  onSession: (session: Session) => void;
  onWorkspace: () => void;
  onWorkspaceSwitch: (workspace: string) => void;
  onNew: () => void;
  onSearch: () => void;
  onNotify: () => void;
  onTheme: () => void;
  onManageSession: (session: Session, action: 'rename' | 'pin' | 'archive' | 'delete') => void;
}): React.JSX.Element {
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [sessionMenuId, setSessionMenuId] = useState<string>();
  const nav = [
    ['pulls', '拉取请求', GitBranch],
    ['sites', '站点 / 预览', ExternalLink],
    ['scheduled', '已安排', History],
    ['plugins', '插件与 Skills', Sparkles],
  ] as const;
  return (
    <aside className="sidebar">
      <button className="brand" data-action="brand-menu" onClick={() => setPage('about')}>
        <div className="brand-mark">
          <Code2 size={18} />
        </div>
        <div>
          <div className="brand-name">SeeCoder</div>
          <div className="brand-tag">coding intelligence</div>
        </div>
        <ChevronDown size={14} />
      </button>
      <div className="sidebar-tools">
        <button
          className="icon-button"
          data-action="search"
          title="搜索任务"
          onClick={onSearch}
        >
          <Search size={16} />
        </button>
        <button
          className="icon-button"
          data-action="notifications"
          title="活动通知"
          onClick={onNotify}
        >
          <Bell size={16} />
          <span className="notification-dot" />
        </button>
      </div>
      <div className="workspace-switcher">
      <button className="workspace-button" data-action="workspace-menu" aria-expanded={workspaceMenuOpen} title={workspace} onClick={() => setWorkspaceMenuOpen((value) => !value)}>
        <FolderOpen size={16} />
        <span className="workspace-button-label"><strong className="truncate">{workspace.split(/[\\/]/).pop()}</strong><small className="truncate">{workspace}</small></span>
        <ChevronDown size={14} />
      </button>
      {workspaceMenuOpen && (
        <div className="workspace-menu" role="menu">
          <div className="workspace-menu-title">工作区</div>
          {recentWorkspaces.map((item) => (
            <button key={item} role="menuitem" data-action="switch-workspace" className={`workspace-option ${item === workspace ? 'active' : ''}`} title={item} onClick={() => { setWorkspaceMenuOpen(false); onWorkspaceSwitch(item); }}>
              <FolderOpen size={14} /><span><strong className="truncate">{item.split(/[\\/]/).pop()}</strong><small className="truncate">{item}</small></span>{item === workspace && <Check size={13} />}
            </button>
          ))}
          <button className="workspace-option browse" role="menuitem" data-action="choose-workspace" onClick={() => { setWorkspaceMenuOpen(false); onWorkspace(); }}>
            <Plus size={14} /><span><strong>添加工作区…</strong><small>选择本地项目文件夹</small></span>
          </button>
        </div>
      )}
      </div>
      <button className="new-task" data-action="new-task" onClick={onNew}>
        <Plus size={16} />
        新建任务<span className="shortcut">Ctrl N</span>
      </button>
      <div className="nav-list">
        {nav.map(([key, label, Icon]) => (
          <button
            key={key}
            data-action={`nav-${key}`}
            className={`sidebar-link ${page === key ? 'active' : ''}`}
            onClick={() => setPage(key)}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>
      <div className="section-label">
        <span>最近任务</span>
        <span className="count">{sessions.length}</span>
      </div>
      <div className="session-list">
        {sessions.slice(0, 18).map((session) => (
          <div className="session-row" key={session.id}>
            <button
              data-action="open-session"
              className={`session ${selectedSession?.id === session.id && page === 'task' ? 'selected' : ''}`}
              onClick={() => onSession(session)}
            >
              <MessageSquare size={15} />
              <span className="truncate">{session.title}</span>
              {session.pinned && <Pin size={12} />}
            </button>
            <button className="session-more icon-button" data-action="session-row-menu" aria-label={`管理任务：${session.title}`} aria-expanded={sessionMenuId === session.id} onClick={() => setSessionMenuId((current) => current === session.id ? undefined : session.id)}><MoreHorizontal size={14} /></button>
            {sessionMenuId === session.id && (
              <div className="session-menu" role="menu">
                <button role="menuitem" data-action="session-rename" onClick={() => { setSessionMenuId(undefined); onManageSession(session, 'rename'); }}>重命名</button>
                <button role="menuitem" data-action="session-pin" onClick={() => { setSessionMenuId(undefined); onManageSession(session, 'pin'); }}>{session.pinned ? '取消置顶' : '置顶'}</button>
                <button role="menuitem" data-action="session-archive" onClick={() => { setSessionMenuId(undefined); onManageSession(session, 'archive'); }}>归档</button>
                <button role="menuitem" data-action="session-delete" className="danger" onClick={() => { setSessionMenuId(undefined); onManageSession(session, 'delete'); }}>删除</button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="sidebar-bottom">
        <button className="sidebar-link" data-action="history" onClick={() => setPage('history')}>
          <History size={15} />
          执行历史
        </button>
        <button className="sidebar-link" data-action="settings" onClick={() => setPage('settings')}>
          <Settings2 size={15} />
          设置
        </button>
        <button className="sidebar-link" data-action="theme" onClick={onTheme}>
          <Sparkles size={15} />
          切换主题
        </button>
        <div className="profile" data-action="profile" onClick={() => setPage('settings')}>
          <div className="avatar">S</div>
          <div>
            <div className="profile-name">本地工作区</div>
            <div className="profile-sub">应用层安全策略</div>
          </div>
          <ShieldCheck size={15} className="shield" />
        </div>
      </div>
    </aside>
  );
}

function TaskPage({
  selectedSession,
  mode,
  running,
  phase,
  streamingText,
  events,
  plans,
  approvals,
  inputRequests,
  children,
  reviewFindings,
  expanded,
  setExpanded,
  onApproval,
  onInput,
  onPlan,
  onReplan,
  onEditPlan,
  onRename,
  onExport,
  onCopy,
  onFeedback,
  onFork,
  onMenu,
  onBranch,
  onRestoreCheckpoint,
  onRetry,
  onOpenInspector,
}: {
  selectedSession: Session | undefined;
  mode: ExecutionMode;
  running: boolean;
  phase: RunPhase;
  streamingText: string;
  events: TimelineItem[];
  plans: PlanStep[];
  approvals: Approval[];
  inputRequests: InputRequest[];
  children: SubagentState[];
  reviewFindings: Array<{
    severity: string;
    title: string;
    path: string;
    line?: number;
    explanation: string;
  }>;
  expanded: Record<string, boolean>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onApproval: (approval: Approval, decision: 'allow' | 'deny') => void;
  onInput: (request: InputRequest, answer: string) => void;
  onPlan: () => void;
  onReplan: () => void;
  onEditPlan: (id: string) => void;
  onRename: () => void;
  onExport: (format: 'markdown' | 'json') => void;
  onCopy: (text: string) => void;
  onFeedback: (kind: 'like' | 'dislike') => void;
  onFork: () => void;
  onMenu: () => void;
  onBranch: () => void;
  onRestoreCheckpoint: (id: string) => void;
  onRetry: () => void;
  onOpenInspector: () => void;
}): React.JSX.Element {
  const conversationRecords = useMemo(() => {
    const records: ConversationRecord[] = [];
    const activityByCallId = new Map<string, ActivityRecord>();
    events.forEach(({ id, event }) => {
      if (event.type === 'message.user' || event.type === 'message.completed') {
        records.push({ id, kind: 'message', message: event });
      } else if (event.type === 'tool.requested') {
        const activity = activityByCallId.get(event.call.id) ?? { id: `tool-${event.call.id}` };
        activity.requested = event;
        activityByCallId.set(event.call.id, activity);
        if (!records.some((record) => record.kind === 'activity' && record.activity === activity)) {
          records.push({ id: activity.id, kind: 'activity', activity });
        }
      } else if (event.type === 'tool.completed') {
        const activity = activityByCallId.get(event.callId) ?? { id: `tool-${event.callId}` };
        activity.completed = event;
        activityByCallId.set(event.callId, activity);
        if (!records.some((record) => record.kind === 'activity' && record.activity === activity)) {
          records.push({ id: activity.id, kind: 'activity', activity });
        }
      } else if (event.type === 'context.compacted' || event.type === 'checkpoint.created') {
        const activity: ActivityRecord = { id, auxiliary: event };
        records.push({ id, kind: 'activity', activity });
      }
    });
    const grouped: ConversationRecord[] = [];
    let exploration: ActivityRecord[] = [];
    const flushExploration = () => {
      if (exploration.length === 1) grouped.push({ id: exploration[0]!.id, kind: 'activity', activity: exploration[0]! });
      else if (exploration.length > 1) grouped.push({ id: `group-${exploration[0]!.id}`, kind: 'activity-group', activities: exploration });
      exploration = [];
    };
    for (const record of records) {
      const name = record.kind === 'activity' ? record.activity.requested?.call.name : undefined;
      const canGroup = record.kind === 'activity'
        && Boolean(record.activity.completed)
        && ['list_files', 'read_file', 'read_files', 'search_text', 'git_diff'].includes(name ?? '');
      if (canGroup) exploration.push(record.activity);
      else { flushExploration(); grouped.push(record); }
    }
    flushExploration();
    return grouped;
  }, [events]);
  const latestTurnResult = useMemo(() => {
    const terminal = latestTurnTerminal(events.map(({ event }) => event));
    return terminal ? { id: `terminal-${terminal.turn.id}`, event: terminal } : undefined;
  }, [events]);
  const hasConversation = conversationRecords.length > 0 || streamingText.length > 0 || plans.length > 0;
  const failure = latestTurnResult?.event.type === 'turn.failed'
    ? friendlyAgentError(latestTurnResult.event.error.message)
    : undefined;
  const planActionsEnabled = latestTurnResult?.event.type !== 'turn.cancelled'
    && latestTurnResult?.event.type !== 'turn.failed';
  const phaseText: Record<RunPhase, string> = {
    idle: '就绪', preparing: '准备下一步', model: '调用模型', tool: '执行工具', approval: '等待确认', input: '等待输入', review: '审查变更',
  };
  const conversationRef = useRef<HTMLElement>(null);
  const autoFollowRef = useRef(true);
  useEffect(() => {
    const container = conversationRef.current;
    if (!container || !autoFollowRef.current) return;
    const frame = window.requestAnimationFrame(() => container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' }));
    return () => window.cancelAnimationFrame(frame);
  }, [conversationRecords.length, streamingText, approvals.length, inputRequests.length, running]);
  return (
    <>
      <header className="topbar">
        <div className="crumb">
          <FolderOpen size={15} />
          <button data-action="rename-session" className="crumb-title" onClick={onRename}>
            {selectedSession?.title ?? 'SeeCoder'}
          </button>
          {selectedSession?.workspacePath && (
            <span
              className="workspace-context"
              title={selectedSession.workspacePath}
              aria-label={`当前工作区：${selectedSession.workspacePath}`}
            >
              <FolderOpen size={12} />
              {selectedSession.workspacePath.split(/[\\/]/).pop()}
            </span>
          )}
          <button data-action="session-menu" className="icon-button" onClick={onMenu}>
            <MoreHorizontal size={16} />
          </button>
        </div>
        <div className="top-actions">
          <span className={`run-status ${running ? 'running' : ''} phase-${phase}`}><span className="status-dot" />{phaseText[phase]}</span>
          <button data-action="branch" className="ghost-button" onClick={onBranch}>
            <GitBranch size={14} />
            {selectedSession?.branch ?? 'main'}
            <ChevronDown size={13} />
          </button>
          <button data-action="share" className="ghost-button" onClick={() => onExport('markdown')}>
            <Upload size={14} />
            分享
          </button>
          <button
            data-action="export-json"
            className="icon-button"
            title="导出 JSON"
            onClick={() => onExport('json')}
          >
            <Download size={16} />
          </button>
          <button
            data-action="toggle-inspector"
            className="icon-button"
            title="切换检查器"
            onClick={onOpenInspector}
          >
            <PanelRight size={16} />
          </button>
        </div>
      </header>
      <section
        ref={conversationRef}
        className="conversation"
        onScroll={(event) => {
          const element = event.currentTarget;
          autoFollowRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 140;
        }}
      >
        {!hasConversation && <div className="welcome">
          <div className="welcome-orb">
            <Sparkles size={23} />
          </div>
          <div>
            <h1>让代码，自己找到答案。</h1>
            <p>描述一个目标，SeeCoder 会探索、修改并验证你的工作区。</p>
          </div>
        </div>}
        {plans.length > 0 && <PlanCard plans={plans} mode={mode} actionsEnabled={planActionsEnabled} onApprove={onPlan} onReplan={onReplan} onEdit={onEditPlan} />}
        {reviewFindings.length > 0 && (
          <div className="review-summary">
            <div className="card-heading">
              <ShieldCheck size={15} />
              Review 发现 <span className="card-meta">{reviewFindings.length} 项</span>
            </div>
            {reviewFindings.map((finding) => (
              <div
                className={`finding ${finding.severity}`}
                key={`${finding.path}-${finding.line}-${finding.title}`}
              >
                <strong>{finding.title}</strong>
                <span>
                  {finding.path}
                  {finding.line ? `:${finding.line}` : ''} · {finding.explanation}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="message-stack">
          {conversationRecords.map((record) => record.kind === 'message' ? (
            <MessageCard key={record.id} message={record.message} onCopy={onCopy} onFeedback={onFeedback} onFork={onFork} forkDisabled={running} />
          ) : record.kind === 'activity-group' ? (
            <ActivityGroupCard
              key={record.id}
              records={record.activities}
              expanded={Boolean(expanded[record.id])}
              onToggle={() => setExpanded((value) => ({ ...value, [record.id]: !value[record.id] }))}
            />
          ) : (
            <ActivityCard
              key={record.id}
              record={record.activity}
              expanded={Boolean(expanded[record.id])}
              onRestoreCheckpoint={onRestoreCheckpoint}
              onToggle={() => setExpanded((value) => ({ ...value, [record.id]: !value[record.id] }))}
            />
          ))}
          {streamingText && (
            <div className="message assistant">
              <div className="message-avatar live">
                <Bot size={15} />
              </div>
              <div className="message-body">
                <div className="message-meta">
                  <span>SeeCoder</span>
                  <span className="live-label">正在思考</span>
                </div>
                <div className="message-text">
                  {streamingText}
                  <span className="cursor" />
                </div>
              </div>
            </div>
          )}
          {approvals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              onResolve={(decision) => onApproval(approval, decision)}
            />
          ))}
          {inputRequests.map((request) => (
            <InputCard
              key={request.requestId}
              request={request}
              onAnswer={(answer) => onInput(request, answer)}
            />
          ))}
        </div>
        {children.length > 0 && (
          <div className="subagent-strip">
            <div className="card-heading">
              <Users size={15} />
              协作 Agent{' '}
              <span className="card-meta">
                {children.filter((child) => child.status === 'completed').length} 完成
                {children.some((child) => child.status === 'failed') && ` · ${children.filter((child) => child.status === 'failed').length} 失败`}
                {children.some((child) => child.status === 'running') && ` · ${children.filter((child) => child.status === 'running').length} 运行中`}
              </span>
            </div>
            {children.map((child) => (
              <div className="child-pill" key={child.id}>
                <span className={`child-status ${child.status}`} />
                <strong>{child.role === 'explore' ? 'Explore' : 'Review'}</strong>
                <span className="truncate">{child.task}</span>
                <span className="child-result">
                  {child.status === 'completed'
                    ? `完成 · ${child.iteration ?? 0} 轮`
                    : child.status === 'running'
                      ? `${child.currentAction ?? '运行中'} · 第 ${child.iteration ?? 1} 轮`
                      : child.status === 'failed'
                        ? `失败${child.errorCode ? ` · ${child.errorCode}` : ''}`
                        : child.status === 'cancelled' ? '已取消' : '排队中'}
                </span>
              </div>
            ))}
          </div>
        )}
        {latestTurnResult?.event.type === 'turn.completed' && (
          <div className="complete-banner">
            <div className="complete-icon">
              <Check size={15} />
            </div>
            <div>
              <strong>任务完成</strong>
              <span>对话与执行轨迹已保存。</span>
            </div>
            <button data-action="view-result" onClick={onOpenInspector}>
              <PanelRight size={14} />
              查看轨迹
            </button>
          </div>
        )}
        {latestTurnResult?.event.type === 'turn.failed' && failure && (
          <div className="complete-banner failure-banner" role="alert">
            <div className="complete-icon"><AlertTriangle size={15} /></div>
            <div>
              <strong>{failure.title}</strong>
              <span>{failure.summary}</span>
            </div>
            <div className="failure-actions">
              <button data-action="retry-turn" onClick={onRetry}>
                <RefreshCw size={14} />
                重新尝试
              </button>
              <button data-action="view-failure" onClick={onOpenInspector}>
              <PanelRight size={14} />
                查看详情
              </button>
            </div>
          </div>
        )}
        {latestTurnResult?.event.type === 'turn.cancelled' && (
          <div className="complete-banner cancelled-banner" role="status">
            <div className="complete-icon"><Square size={13} /></div>
            <div>
              <strong>任务已取消</strong>
              <span>模型请求、工具和子 Agent 已停止，不会在后台继续执行。</span>
            </div>
            <button data-action="view-cancelled" onClick={onOpenInspector}>
              <PanelRight size={14} />
              查看轨迹
            </button>
          </div>
        )}
      </section>
    </>
  );
}

function PlanCard({
  plans,
  mode,
  actionsEnabled,
  onApprove,
  onReplan,
  onEdit,
}: {
  plans: PlanStep[];
  mode: ExecutionMode;
  actionsEnabled: boolean;
  onApprove: () => void;
  onReplan: () => void;
  onEdit: (id: string) => void;
}): React.JSX.Element {
  return (
    <div className="plan-card">
      <div className="card-heading">
        <ListChecks size={15} />
        <span>执行计划</span>
        <span className="card-meta">
          {plans.filter((step) => step.status === 'completed').length}/{plans.length}
        </span>
        {mode === 'plan' && actionsEnabled && (
          <><button className="small-button" data-action="replan" onClick={onReplan}>重新规划</button><button className="small-button primary" data-action="approve-plan" onClick={onApprove}><Play size={12} />批准实施</button></>
        )}
      </div>
      <div className="plan-steps">
        {plans.map((step) => (
          <div key={step.id} className={`plan-step ${step.status}`}>
            <span className="step-icon">
              {step.status === 'completed' ? (
                <Check size={12} />
              ) : step.status === 'running' ? (
                <Loader2 size={12} className="spin" />
              ) : (
                <CircleDot size={10} />
              )}
            </span>
            <span>{step.label}</span>
            <button className="icon-button plan-edit" data-action="edit-plan" title="编辑步骤" onClick={() => onEdit(step.id)}>编辑</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function MessageCard({
  message,
  onCopy,
  onFeedback,
  onFork,
  forkDisabled,
}: {
  message: Extract<AgentEvent, { type: 'message.completed' | 'message.user' }>;
  onCopy: (text: string) => void;
  onFeedback: (kind: 'like' | 'dislike') => void;
  onFork: () => void;
  forkDisabled: boolean;
}): React.JSX.Element {
  return (
    <div className={`message ${message.type === 'message.user' ? 'user' : 'assistant'}`}>
      <div className="message-avatar">
        {message.type === 'message.user' ? <span>你</span> : <Bot size={15} />}
      </div>
      <div className="message-body">
        <div className="message-meta">
          <span>{message.type === 'message.user' ? '你' : 'SeeCoder'}</span>
          <span>{timeLabel(message.timestamp)}</span>
        </div>
        <div className="message-text"><MarkdownMessage text={message.text} /></div>
        <div className="message-actions">
          <button data-action="copy-message" title="复制" onClick={() => onCopy(message.text)}>
            <Copy size={13} />
          </button>
          {message.type === 'message.completed' && (
            <>
              <button data-action="like" title="有帮助" onClick={() => onFeedback('like')}>
                <ThumbsUp size={13} />
              </button>
              <button data-action="dislike" title="需要改进" onClick={() => onFeedback('dislike')}>
                <ThumbsDown size={13} />
              </button>
              <button data-action="fork-message" title={forkDisabled ? '任务运行中不能 Fork' : 'Fork 当前 Session'} disabled={forkDisabled} onClick={onFork}>
                <GitFork size={13} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ActivityCard({
  record,
  expanded,
  onToggle,
  onRestoreCheckpoint,
}: {
  record: ActivityRecord;
  expanded: boolean;
  onToggle: () => void;
  onRestoreCheckpoint: (id: string) => void;
}): React.JSX.Element {
  const event = record.completed ?? record.requested ?? record.auxiliary;
  if (!event) return <></>;
  const checkpoint = record.auxiliary?.type === 'checkpoint.created' ? record.auxiliary : undefined;
  const isSuccess = record.completed?.result.ok ?? false;
  const isControlled = isToolControlSignal(record.completed?.result);
  const isError = Boolean(record.completed && !record.completed.result.ok && !isControlled);
  const toolName = record.requested?.call.name;
  const finishOutput = toolName === 'finish' && record.completed?.result.output && typeof record.completed.result.output === 'object'
    ? record.completed.result.output as { verificationStatus?: string; warning?: string }
    : undefined;
  const verificationWarning = finishOutput?.verificationStatus === 'warning' ? finishOutput.warning : undefined;
  if (toolName === 'finish' && !verificationWarning) return <></>;
  const compactedMetrics = record.auxiliary?.type === 'context.compacted' ? record.auxiliary.metrics : undefined;
  const view = formatToolActivity({
    name: toolName ?? (record.auxiliary?.type === 'context.compacted' && !compactedMetrics ? 'compact_context' : undefined),
    args: record.requested?.call.args,
    result: record.completed?.result,
    contextMetrics: compactedMetrics,
    checkpointFiles: checkpoint?.checkpoint.files.map((file) => file.path),
  });
  const status = isControlled ? '探索已按预算停止，将使用现有证据继续' : view.summary;
  const canExpand = view.details.length > 0 || Boolean(checkpoint);
  return (
    <div
      className={`activity ${isError ? 'error' : verificationWarning ? 'warning' : record.auxiliary?.type === 'checkpoint.created' ? 'checkpoint' : 'success'}`}
    >
      <button className="activity-head" data-action="toggle-activity" aria-expanded={expanded} onClick={onToggle}>
        <div className="activity-icon">
          {verificationWarning ? (
            <AlertTriangle size={14} />
          ) : record.auxiliary?.type === 'checkpoint.created' ? (
            <RotateCcw size={14} />
          ) : isSuccess ? (
            <Check size={14} />
          ) : isControlled ? (
            <Zap size={14} />
          ) : isError ? (
            <X size={14} />
          ) : (
            <Zap size={14} />
          )}
        </div>
        <div className="activity-title">
          <strong>{view.title}</strong>
          <span>{status}</span>
        </div>
        <span className="activity-time">{timeLabel(record.completed?.timestamp ?? record.requested?.timestamp ?? event.timestamp)}</span>
        {canExpand && (expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
      </button>
      {expanded && canExpand && (
        <div className="activity-detail">
          {view.details.length > 0 && (
            <div className="activity-detail-list">
              {view.details.map((detail, index) => (
                <div className={`activity-detail-row ${detail.kind ?? 'text'}`} key={`${detail.label ?? 'detail'}-${index}`}>
                  {detail.label && <span>{detail.label}</span>}
                  {detail.kind === 'code' ? <code>{detail.value}</code> : <strong title={detail.value}>{detail.value}</strong>}
                </div>
              ))}
            </div>
          )}
          {checkpoint && (
            <button
              className="small-button"
              data-action="restore-checkpoint"
              onClick={() => onRestoreCheckpoint(checkpoint.checkpoint.id)}
              disabled={!checkpoint.checkpoint.id}
            >
              恢复到此恢复点
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityGroupCard({ records, expanded, onToggle }: { records: ActivityRecord[]; expanded: boolean; onToggle: () => void }): React.JSX.Element {
  const counts = records.reduce<Record<string, number>>((result, record) => {
    const name = record.requested?.call.name ?? 'tool';
    result[name] = (result[name] ?? 0) + 1;
    return result;
  }, {});
  const summary = Object.entries(counts).map(([name, count]) => `${toolPresentation[name]?.label ?? name} ${count}`).join(' · ');
  const limited = records.filter((record) => isToolControlSignal(record.completed?.result)).length;
  const failed = records.filter((record) => record.completed && !record.completed.result.ok && !isToolControlSignal(record.completed.result)).length;
  const latest = records[records.length - 1];
  return (
    <div className={`activity activity-group ${failed ? 'error' : 'success'}`}>
      <button className="activity-head" data-action="toggle-activity-group" aria-expanded={expanded} onClick={onToggle}>
        <div className="activity-icon">{failed ? <X size={14} /> : <Check size={14} />}</div>
        <div className="activity-title">
          <strong>探索项目 · {records.length} 次操作</strong>
          <span>{failed ? `${failed} 项失败 · ${summary}` : limited ? `${limited} 次已按预算停止 · ${summary}` : summary}</span>
        </div>
        <span className="activity-time">{latest ? timeLabel(latest.completed?.timestamp ?? latest.requested?.timestamp ?? new Date().toISOString()) : ''}</span>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {expanded && (
        <div className="activity-group-detail">
          {records.map((record) => {
            const name = record.requested?.call.name ?? 'tool';
            const ok = record.completed?.result.ok ?? false;
            const controlled = isToolControlSignal(record.completed?.result);
            const view = formatToolActivity({ name, args: record.requested?.call.args, result: record.completed?.result });
            return (
              <div className="activity-group-row" key={record.id}>
                {ok ? <Check size={12} /> : controlled ? <Zap size={12} /> : <X size={12} />}
                <span>{view.title}</span>
                <strong title={view.summary}>{view.summary}</strong>
                <time>{timeLabel(record.completed?.timestamp ?? record.requested?.timestamp ?? new Date().toISOString())}</time>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function approvalPresentation(approval: Approval): { title: string; summary: string; preview?: string; previewLabel?: string } {
  const args = approval.call.args && typeof approval.call.args === 'object' ? approval.call.args as Record<string, unknown> : {};
  if (approval.call.name === 'run_command') return { title: '批准运行命令', summary: String(args.cwd ?? '工作区根目录'), preview: String(args.command ?? '') };
  if (approval.call.name === 'write_file') {
    const content = String(args.content ?? '');
    return { title: '批准写入文件', summary: `${String(args.path ?? '未知文件')} · ${content.length} 个字符` };
  }
  if (approval.call.name === 'apply_patch') {
    const patch = String(args.patch ?? '');
    const files = [...new Set([
      ...[...patch.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)].map((match) => match[1]),
      ...[...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)].map((match) => match[1]),
    ].filter((value): value is string => Boolean(value) && value !== '/dev/null'))];
    return { title: '批准修改文件', summary: files.length ? files.join('、') : '修改工作区文件', preview: patch, previewLabel: '查看代码差异' };
  }
  const presentation = toolPresentation[approval.call.name];
  return { title: `批准${presentation?.label ?? '操作'}`, summary: approval.reason };
}

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: Approval;
  onResolve: (decision: 'allow' | 'deny') => void;
}): React.JSX.Element {
  const presentation = approvalPresentation(approval);
  return (
    <div className="approval-card">
      <div className="approval-top">
        <div className="approval-icon">
          <ShieldCheck size={16} />
        </div>
        <div>
          <strong>{presentation.title}</strong>
          <span>{presentation.summary}</span>
        </div>
        <span className={`risk ${approval.risk}`}>
          {approval.risk === 'high' ? '高风险' : approval.risk === 'medium' ? '中风险' : '低风险'}
        </span>
      </div>
      {approval.call.name === 'apply_patch' && presentation.preview ? (
        <PatchDiffPreview patch={presentation.preview} />
      ) : presentation.preview ? <pre className="approval-code command-preview">{presentation.preview}</pre> : null}
      <div className="approval-actions">
        <button className="deny" data-action="deny-approval" onClick={() => onResolve('deny')}>
          <X size={14} />
          拒绝
        </button>
        <button className="allow" data-action="allow-approval" onClick={() => onResolve('allow')}>
          <Check size={14} />
          允许一次
        </button>
      </div>
    </div>
  );
}
function InputCard({
  request,
  onAnswer,
}: {
  request: InputRequest;
  onAnswer: (answer: string) => void;
}): React.JSX.Element {
  const [value, setValue] = useState('');
  return (
    <div className="input-card">
      <div className="card-heading">
        <MessageSquare size={15} />
        SeeCoder 需要你的输入
      </div>
      <p>{request.question}</p>
      {request.choices?.length ? (
        <div className="choice-list">
          {request.choices.map((choice) => (
            <button key={choice} className="choice" data-action="answer-choice" onClick={() => onAnswer(choice)}>
              {choice}
            </button>
          ))}
        </div>
      ) : (
        <div className="input-row">
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="输入回答…"
          />
          <button
            className="small-button primary"
            data-action="submit-input"
            disabled={!value.trim()}
            onClick={() => onAnswer(value.trim())}
          >
            提交
          </button>
        </div>
      )}
    </div>
  );
}

function Composer({
  value,
  setValue,
  running,
  mode,
  model,
  modelProfiles,
  attachments,
  activeSkill,
  onAttach,
  onModeSelect,
  onModelSelect,
  onSend,
  onCancel,
  onSettings,
  onToast,
  onClearSkill,
}: {
  value: string;
  setValue: (value: string) => void;
  running: boolean;
  mode: ExecutionMode;
  model: string;
  modelProfiles: ModelProfile[];
  attachments: AttachmentRef[];
  activeSkill: LocalSkill | undefined;
  onAttach: () => void;
  onModeSelect: (mode: ExecutionMode) => void;
  onModelSelect: (profileId: string) => Promise<void>;
  onSend: () => void;
  onCancel: () => void;
  onSettings: () => void;
  onToast: (value: string) => void;
  onClearSkill: () => void;
}): React.JSX.Element {
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelOptions = modelProfiles.filter((profile) => profile.enabled);
  const selectedProfile = modelOptions.find((profile) => profile.model === model) ?? modelOptions[0];
  const modeLabel = mode === 'plan' ? 'Plan' : mode === 'guided' ? 'Guided' : 'Auto';
  const modeDescription = mode === 'plan' ? '只读分析与计划' : mode === 'guided' ? '写入和命令逐次确认' : '低风险动作自动执行';
  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          data-action="composer"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="描述你想完成的编程任务…"
          rows={2}
        />
        {(attachments.length > 0 || activeSkill) && (
          <div className="attachment-row">
            {activeSkill && <span className="attachment-chip skill-chip"><Sparkles size={12} />Skill：{activeSkill.name}<button data-action="clear-skill" aria-label="取消使用 Skill" onClick={onClearSkill}><X size={11} /></button></span>}
            {attachments.map((item) => (
              <span className="attachment-chip" key={item.id}>
                {item.kind === 'image' ? <ImagePlus size={12} /> : <FilePlus2 size={12} />}
                {item.name}
              </span>
            ))}
          </div>
        )}
        <div className="composer-footer">
          <div className="composer-tools">
            <button
              data-action="attach"
              className="composer-tool"
              title="添加上下文"
              onClick={onAttach}
            >
              <Plus size={16} />
            </button>
            <button
              data-action="permission-mode"
              className="composer-tool mode-tool"
              title={`当前 ${modeLabel}：${modeDescription}。点击选择执行模式`}
              aria-haspopup="menu"
              aria-expanded={modeMenuOpen}
              onClick={() => { setModelMenuOpen(false); setModeMenuOpen((value) => !value); }}
            >
              <ShieldCheck size={13} />
              <span>{modeLabel}</span>
              <ChevronDown size={12} />
            </button>
            {modeMenuOpen && (
              <div className="mode-menu" role="menu">
                {([
                  ['plan', 'Plan', '只读分析与计划，不修改工作区'],
                  ['guided', 'Guided', '每次写入和命令都请求确认'],
                  ['auto', 'Auto', '工作区内低风险动作自动执行'],
                ] as const).map(([value, label, description]) => (
                  <button
                    key={value}
                    data-action={`mode-${value}`}
                    className={mode === value ? 'selected' : ''}
                    role="menuitemradio"
                    aria-checked={mode === value}
                    onClick={() => { onModeSelect(value); setModeMenuOpen(false); }}
                  >
                    <strong>{label}</strong><span>{description}</span>
                  </button>
                ))}
              </div>
            )}
            <button
              data-action="model-settings"
              className="composer-tool model-tool"
              title={running ? '任务运行中不能切换模型' : `当前模型：${model}`}
              aria-haspopup="menu"
              aria-expanded={modelMenuOpen}
              disabled={running}
              onClick={() => { setModeMenuOpen(false); setModelMenuOpen((value) => !value); }}
            >
              <span>{selectedProfile?.name ?? model}</span>
              <ChevronDown size={12} />
            </button>
            {modelMenuOpen && (
              <div className="model-menu" role="menu">
                <div className="model-menu-title">选择模型</div>
                {modelOptions.map((profile) => (
                  <button
                    key={profile.id}
                    data-action="model-option"
                    className={model === profile.model ? 'selected' : ''}
                    role="menuitemradio"
                    aria-checked={model === profile.model}
                    onClick={() => { setModelMenuOpen(false); void onModelSelect(profile.id); }}
                  >
                    <span><strong>{profile.name}</strong><small>{profile.model}</small></span>
                    {model === profile.model && <Check size={13} />}
                  </button>
                ))}
                <button data-action="manage-models" className="model-manage" onClick={() => { setModelMenuOpen(false); onSettings(); }}>
                  <Settings2 size={13} />管理模型
                </button>
              </div>
            )}
          </div>
          <div className="composer-hints">
            <span>
              <Command size={12} />K 命令
            </span>
            <span>Ctrl ↵ 发送</span>
            <button
              data-action="voice"
              className="icon-button"
              title="语音输入"
              onClick={() => {
                const Speech = (
                  window as unknown as {
                    SpeechRecognition?: new () => {
                      start: () => void;
                      onresult?: (event: {
                        results: ArrayLike<ArrayLike<{ transcript: string }>>;
                      }) => void;
                      onstart?: () => void;
                      onerror?: () => void;
                    };
                  }
                ).SpeechRecognition;
                if (!Speech) onToast('当前 Electron 环境未提供语音识别，请直接输入文字。');
                else {
                  const recognition = new Speech();
                  recognition.onstart = () => onToast('正在监听，请开始说话。');
                  recognition.onerror = () => onToast('语音输入失败，请检查麦克风权限后重试。');
                  recognition.onresult = (event) =>
                    setValue(`${value} ${event.results[0]?.[0]?.transcript ?? ''}`.trim());
                  recognition.start();
                }
              }}
            >
              <Zap size={14} />
            </button>
          </div>
          <button
            data-action={running ? 'stop-turn' : 'send-turn'}
            className={`send-button ${running ? 'stop' : ''}`}
            disabled={!value.trim() && !running}
            onClick={running ? onCancel : onSend}
          >
            {running ? <Square size={15} /> : <Send size={15} />}
          </button>
        </div>
      </div>
      <div className="composer-note">
        <ShieldCheck size={12} />
        {mode === 'plan'
          ? 'Plan 模式只读分析，不会修改工作区'
          : 'SeeCoder 会在高风险操作前请求你的确认'}
      </div>
    </div>
  );
}

function InspectorContent({
  type,
  changes,
  terminal,
  children,
  workspace,
  events,
  files,
  filePreview,
  gitText,
  onRevert,
  onStage,
  onOpenFile,
  onGitRefresh,
  onToast,
  onPrompt,
  onConfirm,
}: {
  type: 'changes' | 'files' | 'terminal' | 'preview' | 'trace';
  changes: ChangeSet[];
  terminal: string[];
  children: SubagentState[];
  workspace: string;
  events: TimelineItem[];
  files: string[];
  filePreview: { path: string; text: string } | undefined;
  gitText: string;
  onRevert: (id: string) => void;
  onStage: (path: string) => void;
  onOpenFile: (path: string) => Promise<void>;
  onGitRefresh: () => Promise<void>;
  onToast: (value: string) => void;
  onPrompt: (request: PromptRequest) => Promise<string | null>;
  onConfirm: (message: string) => Promise<boolean>;
}): React.JSX.Element {
  const gitBlocked = gitText.startsWith('Git 操作已禁用') || gitText.startsWith('Git 状态读取失败');
  const gitLines = gitText.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  const gitReady = !gitBlocked && gitLines[0]?.startsWith('##');
  const gitBranch = gitReady ? gitLines[0]!.replace(/^##\s*/, '') : '';
  const gitChanges = gitReady ? gitLines.slice(1) : [];
  const hasStagedChanges = gitChanges.some((line) => line[0] !== ' ' && line[0] !== '?');
  if (type === 'files')
    return (
      <div className="inspector-body">
        <div className="panel-title">
          工作区文件<span className="panel-sub">{files.length === 200 ? '200+ 个条目' : `${files.length} 个条目`}</span>
        </div>
        <div className="workspace-card">
          <FolderOpen size={18} />
          <div>
            <strong>{workspace.split(/[\\/]/).pop()}</strong>
            <span className="truncate">{workspace}</span>
          </div>
        </div>
        <div className="file-tree">
          {files.map((file) => (
            <button
              data-action="open-file"
              key={file}
              onClick={() => void onOpenFile(file)}
            >
              <FileCode2 size={13} />
              {file}
            </button>
          ))}
        </div>
        {filePreview && <div className="file-preview"><div className="panel-title"><span>{filePreview.path}</span><button className="small-button" data-action="readonly-file" onClick={() => onToast('文件以只读方式打开')}>只读</button></div><Editor height="280px" language={languageFor(filePreview.path)} value={filePreview.text} theme="vs" options={{ readOnly: true, minimap: { enabled: false }, wordWrap: 'on', lineNumbers: 'on' }} /></div>}
        {!files.length && (
          <div className="empty-panel">
            <div className="empty-icon">
              <FolderOpen size={18} />
            </div>
            <strong>点击 Files 标签加载文件树</strong>
            <span>读取操作始终限制在工作区内。</span>
          </div>
        )}
      </div>
    );
  if (type === 'terminal') return <TerminalPanel lines={terminal} onToast={onToast} />;
  if (type === 'preview') return <PreviewPanel onToast={onToast} />;
  if (type === 'trace')
    return <TracePanel events={events} children={children} />;
  if (type === 'changes')
    return (
      <div className="inspector-body">
        <div className="panel-title">
          <span>变更</span>
          <button
            className="small-button"
            data-action="refresh-git"
            onClick={() => void onGitRefresh()}
          >
            刷新 Git
          </button>
        </div>
        <section className="change-section" aria-label="工作区 Git 变更">
          <div className="change-section-heading">
            <span><GitBranch size={13} /><strong>工作区 Git</strong><b>{gitReady ? `${gitChanges.length} 项` : '未就绪'}</b></span>
            {gitBranch && <code title={gitBranch}>{gitBranch}</code>}
          </div>
          <div className={`git-status ${gitReady && gitChanges.length === 0 ? 'clean' : ''}`}>
            {gitBlocked || !gitReady
              ? gitText || '正在读取 Git 状态…'
              : gitChanges.length
                ? gitChanges.join('\n')
                : '工作区干净，没有未提交变更。'}
          </div>
          <div className="git-actions">
            <button className="small-button" data-action="stage-all" disabled={gitBlocked || !gitReady || gitChanges.length === 0} title={gitBlocked ? '请先切换到 Git 仓库根目录' : gitChanges.length === 0 ? '没有可暂存的变更' : '暂存当前工作区的全部变更'} onClick={async () => { await window.seecoder.git.stage(); onToast('已暂存全部工作区改动'); await onGitRefresh(); }}>全部暂存</button>
            <button className="small-button" data-action="commit" disabled={gitBlocked || !gitReady || !hasStagedChanges} title={!hasStagedChanges ? '请先暂存要提交的文件' : '提交已暂存的变更'} onClick={async () => { const message = await onPrompt({ title: '提交说明', value: 'chore: update from SeeCoder', placeholder: '输入 Git commit message…' }); if (message) { const result = await window.seecoder.git.commit(message); onToast(String(resultOutput(result) ?? '提交已执行')); await onGitRefresh(); } }}>提交</button>
            <button className="small-button" data-action="push" disabled={gitBlocked || !gitReady} title={gitBlocked ? '请先切换到 Git 仓库根目录' : '推送当前分支'} onClick={async () => { const confirmed = await onConfirm('确认推送当前分支？'); if (confirmed) { const result = await window.seecoder.git.push(); onToast(String(resultOutput(result) ?? '推送已执行')); } }}>推送</button>
          </div>
        </section>
        <section className="change-section task-changes" aria-label="当前任务改动">
          <div className="change-section-heading">
            <span><Code2 size={13} /><strong>当前任务</strong><b>{changes.length} 个 ChangeSet</b></span>
          </div>
        {changes.length === 0 ? (
          <div className="empty-panel change-empty">
            <div className="empty-icon">
              <GitBranch size={18} />
            </div>
            <strong>本任务没有修改文件</strong>
            <span>工作区现有 Git 变更仍显示在上方，两者互不混淆。</span>
          </div>
        ) : (
          changes.map((change) => (
            <div className="change-card" key={change.id}>
              <div className="change-heading">
                <span className="change-dot" />
                ChangeSet <code>{change.id.slice(0, 8)}</code>
                <span className="change-time">{timeLabel(change.createdAt)}</span>
                <button
                  className="revert-button"
                  data-action="revert-changes"
                  title="撤销本轮修改"
                  onClick={() => onRevert(change.id)}
                >
                  <RotateCcw size={12} />
                </button>
              </div>
              {change.files.map((file) => (
                <div className="diff-file" key={file.path}>
                  <div className="diff-file-name">
                    <Code2 size={13} />
                    {file.path}
                    <button className="small-button" data-action="stage-file" onClick={() => onStage(file.path)}>
                      Stage
                    </button>
                  </div>
                  <ChangeDiffViewer
                    id={change.id}
                    path={file.path}
                    language={languageFor(file.path)}
                    before={file.before ?? ''}
                    after={file.after ?? ''}
                  />
                </div>
              ))}
            </div>
          ))
        )}
        </section>
      </div>
    );
  return <div />;
}

function TracePanel({ events, children }: { events: TimelineItem[]; children: SubagentState[] }): React.JSX.Element {
  const rows = useMemo(() => {
    const result: Array<{ id: string; event: AgentEvent; count?: number }> = [];
    for (const item of events.slice(-240)) {
      const previous = result[result.length - 1];
      if (item.event.type === 'message.delta' && previous?.event.type === 'message.delta' && previous.event.turnId === item.event.turnId) {
        previous.count = (previous.count ?? 1) + 1;
        previous.event = item.event;
      } else {
        result.push(item.event.type === 'message.delta'
          ? { id: item.id, event: item.event, count: 1 }
          : { id: item.id, event: item.event });
      }
    }
    return result.slice(-160);
  }, [events]);

  function label(row: { event: AgentEvent; count?: number }): string {
    const event = row.event;
    if (event.type === 'message.delta') return `流式消息 ×${row.count ?? 1}`;
    if (event.type === 'model.completed') return `模型完成 · 第 ${event.iteration} 轮 · ${event.durationMs}ms · 重试 ${event.retries}`;
    if (event.type === 'model.requested') return `模型请求 · 第 ${event.iteration} 轮`;
    if (event.type === 'tool.requested') return `调用工具 · ${event.call.name}`;
    if (event.type === 'tool.completed') return `工具完成 · ${event.callId.slice(0, 8)} · ${event.result.ok ? '成功' : isToolControlSignal(event.result) ? '已限制' : '失败'}`;
    if (event.type === 'usage.updated') return `Token · ${event.inputTokens} 输入 / ${event.outputTokens} 输出`;
    if (event.type === 'context.summary.requested') return '上下文摘要 · 正在请求模型';
    if (event.type === 'context.summary.completed') return `上下文摘要 · ${event.durationMs}ms · ${event.inputTokens ?? 0}/${event.outputTokens ?? 0} tokens`;
    if (event.type === 'context.summary.failed') return `上下文摘要降级 · ${event.code}`;
    if (event.type === 'context.retrieved') return `历史召回 · ${event.count} 条 · ${event.kinds.join('、')}`;
    if (event.type === 'skill.activated') return `已激活 Skill · ${event.skill.name}`;
    if (event.type === 'context.compacted') return event.metrics
      ? `上下文压缩 · ${event.metrics.beforeTokens} → ${event.metrics.afterTokens} tokens`
      : '上下文压缩完成';
    if (event.type === 'turn.completed') return '任务完成';
    if (event.type === 'turn.failed') return `任务失败 · ${event.error.code}`;
    if (event.type === 'subagent.updated') return `子 Agent · ${event.child.role} · ${event.child.status}`;
    return event.type;
  }

  const groups = useMemo(() => {
    type TraceRow = { id: string; event: AgentEvent; count?: number };
    type TraceGroup = {
      id: string;
      iteration?: number;
      rows: TraceRow[];
      tools: Map<string, number>;
      failures: number;
      durationMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      terminal?: 'completed' | 'failed' | 'cancelled';
    };
    const result: TraceGroup[] = [];
    let current: TraceGroup | undefined;
    for (const row of rows) {
      const event = row.event;
      if (event.type === 'model.requested') {
        current = { id: row.id, iteration: event.iteration, rows: [], tools: new Map(), failures: 0 };
        result.push(current);
      }
      if (!current) {
        current = { id: `setup-${row.id}`, rows: [], tools: new Map(), failures: 0 };
        result.push(current);
      }
      current.rows.push(row);
      if (event.type === 'tool.requested') {
        current.tools.set(event.call.name, (current.tools.get(event.call.name) ?? 0) + 1);
      } else if (event.type === 'tool.completed' && !event.result.ok && !isToolControlSignal(event.result)) {
        current.failures += 1;
      } else if (event.type === 'usage.updated') {
        current.inputTokens = event.inputTokens;
        current.outputTokens = event.outputTokens;
      } else if (event.type === 'model.completed') {
        current.durationMs = event.durationMs;
        if (typeof event.inputTokens === 'number') current.inputTokens = event.inputTokens;
        if (typeof event.outputTokens === 'number') current.outputTokens = event.outputTokens;
      } else if (event.type === 'turn.completed') current.terminal = 'completed';
      else if (event.type === 'turn.failed') current.terminal = 'failed';
      else if (event.type === 'turn.cancelled') current.terminal = 'cancelled';
    }
    return result.slice(-16);
  }, [rows]);

  function groupSummary(group: (typeof groups)[number]): string {
    const tools = [...group.tools.entries()]
      .map(([name, count]) => `${toolPresentation[name]?.label ?? name}${count > 1 ? ` ×${count}` : ''}`)
      .join(' · ');
    if (tools) return tools;
    if (group.terminal === 'completed') return '任务已完成并保存轨迹';
    if (group.terminal === 'failed') return '任务以失败状态结束';
    if (group.terminal === 'cancelled') return '任务已取消';
    return group.iteration ? '模型分析与生成' : '准备任务与上下文';
  }

  return (
    <div className="inspector-body">
      <div className="panel-title">
        执行轨迹
        <span className="panel-sub">{groups.length} 个阶段 · {events.length} 个原始事件</span>
      </div>
      <div className="trace-list">
        {groups.map((group) => {
          const details = group.rows.filter(({ event }) => event.type !== 'tool.output' && event.type !== 'message.delta');
          const hidden = group.rows.length - details.length;
          return (
            <details className={`trace-group ${group.failures ? 'error' : ''}`} key={group.id}>
              <summary>
                <span className={`trace-dot ${group.terminal === 'completed' ? 'success' : group.terminal === 'failed' ? 'danger' : ''}`} />
                <span className="trace-group-copy">
                  <strong>{group.iteration ? `第 ${group.iteration} 轮` : '任务准备'}</strong>
                  <small>{groupSummary(group)}</small>
                </span>
                <span className="trace-metrics">
                  {group.failures > 0 && <b>{group.failures} 失败</b>}
                  {typeof group.inputTokens === 'number' && <span>{Math.round(group.inputTokens / 100) / 10}k token</span>}
                  {typeof group.durationMs === 'number' && <span>{Math.round(group.durationMs / 100) / 10}s</span>}
                </span>
              </summary>
              <div className="trace-group-detail">
                {details.map((row) => (
                  <div className="trace-row" key={row.id}>
                    <span className={`trace-dot ${row.event.type.includes('failed') ? 'danger' : row.event.type.includes('completed') ? 'success' : ''}`} />
                    <span className="truncate">{label(row)}</span>
                    <time>{timeLabel(row.event.timestamp)}</time>
                  </div>
                ))}
                {hidden > 0 && <div className="trace-hidden">已收起 {hidden} 条流式输出；完整内容仍保留在会话记录中。</div>}
              </div>
            </details>
          );
        })}
        {children.map((child) => (
          <div className="trace-child" key={child.id}>
            <Users size={13} />
            <span>{child.role} · {child.status} · {child.iteration ?? 0} 轮 · {Math.round((child.durationMs ?? 0) / 100) / 10}s</span>
          </div>
        ))}
        {!groups.length && <div className="empty-panel"><strong>暂无轨迹</strong><span>启动任务后会显示模型、工具和验证节点。</span></div>}
      </div>
    </div>
  );
}

function TerminalPanel({
  lines,
  onToast,
}: {
  lines: string[];
  onToast: (value: string) => void;
}): React.JSX.Element {
  const [command, setCommand] = useState('');
  const [localLines, setLocalLines] = useState<string[]>([]);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return undefined;
    const terminal = new XTerm({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      fontSize: 11,
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      theme: { background: '#17121c', foreground: '#d9d0e2', cursor: '#8247d6' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current);
    const fitTerminal = () => {
      const element = container.current;
      if (!element || element.clientWidth === 0 || element.clientHeight === 0) return;
      try { fit.fit(); } catch { /* Electron 首次布局时尺寸可能尚未稳定，下一次 resize 会重试。 */ }
    };
    const frame = window.requestAnimationFrame(fitTerminal);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fitTerminal);
    if (observer && container.current) observer.observe(container.current);
    terminal.write([...lines, ...localLines].join(''));
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      terminal.dispose();
    };
  }, [lines, localLines]);
  return (
    <div className="inspector-body terminal-body">
      <div className="panel-title">
        <span>受控终端</span>
        <span className="live-dot">● LIVE</span>
      </div>
      <div className="terminal-output" ref={container} />{' '}
      <div className="terminal-input">
        <span>›</span>
        <input
          data-action="terminal-input"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={async (event) => {
            if (event.key !== 'Enter' || !command.trim()) return;
            const current = command.trim();
            setCommand('');
            try {
              const value = await window.seecoder.terminal.run(current);
              const formatted = formatCommandOutput(value);
              setLocalLines((previous) => [...previous, `> ${current}\n${formatted}\n`].slice(-200));
              onToast(formatted || '命令已执行');
            } catch (error) {
              const message = error instanceof Error ? error.message : '命令执行失败';
              setLocalLines((previous) => [...previous, `> ${current}\n[未执行] ${message}\n`].slice(-200));
              onToast(message);
            }
          }}
          placeholder="输入命令并回车…"
        />
      </div>
    </div>
  );
}
function PreviewPanel({ onToast }: { onToast: (value: string) => void }): React.JSX.Element {
  const [url, setUrl] = useState('http://localhost:3000');
  return (
    <div className="inspector-body">
      <div className="panel-title">
        本地 Preview<span className="panel-sub">不提供云部署</span>
      </div>
      <div className="preview-card">
        <ExternalLink size={22} />
        <strong>打开本地运行结果</strong>
        <span>先在 Terminal 启动开发服务器，再输入 localhost 地址。</span>
        <div className="input-row">
          <input value={url} onChange={(event) => setUrl(event.target.value)} />
          <button
            className="small-button primary"
            onClick={async () => {
              try {
                await window.seecoder.preview.open(url);
                onToast('已在默认浏览器打开 Preview');
              } catch (error) {
                onToast(error instanceof Error ? error.message : 'Preview 地址无效');
              }
            }}
          >
            打开
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkspacePage({
  page,
  workspace,
  sessions,
  gitText,
  onRefreshGit,
  onNew,
  onOpenSession,
  onToast,
  onModelChange,
  onUseSkill,
  onRequestPrompt,
}: {
  page: string;
  workspace: string;
  sessions: Session[];
  gitText: string;
  onRefreshGit: () => Promise<void>;
  onNew: () => void;
  onOpenSession: (session: Session) => Promise<void>;
  onToast: (value: string) => void;
  onModelChange: (value: string, profiles: ModelProfile[]) => void;
  onUseSkill: (skill: LocalSkill) => void;
  onRequestPrompt: (request: PromptRequest) => Promise<string | null>;
}): React.JSX.Element {
  void onRefreshGit;
  const [schedules, setSchedules] = useState<ScheduleDefinition[]>([]);
  const [extensions, setExtensions] = useState<
    Array<LocalSkill & { path: string; kind: string; hookStatus?: 'trusted' | 'untrusted' | 'invalid'; hookError?: string }>
  >([]);
  const [url, setUrl] = useState('http://localhost:3000');
  const [settings, setSettings] = useState<SettingsView>();
  const reloadExtensions = async (): Promise<void> => setExtensions(await window.seecoder.extension.list());
  useEffect(() => {
    if (page === 'scheduled') void window.seecoder.schedule.list().then(setSchedules);
    if (page === 'plugins') void window.seecoder.extension.list().then(setExtensions);
    if (page === 'settings') void window.seecoder.settings.read().then(setSettings);
  }, [page]);
  if (page === 'history')
    return (
      <div className="workspace-page">
        <PageHeader
          icon={History}
          title="执行历史"
          subtitle="搜索、恢复和继续过去的 SeeCoder 任务"
        />
        <div className="history-grid">
          {sessions.map((session) => (
            <button className="history-card" data-action="open-history-session" key={session.id} onClick={() => void onOpenSession(session)}>
              <MessageSquare size={16} />
              <div>
                <strong>{session.title}</strong>
                <span>{session.workspacePath}</span>
              </div>
              <ChevronRight size={15} />
            </button>
          ))}
        </div>
      </div>
    );
  if (page === 'pulls')
    return (
      <div className="workspace-page">
        <PageHeader
          icon={GitBranch}
          title="拉取请求"
          subtitle="连接本机 gh CLI，查看真实 PR 状态"
        />
        <div className="feature-card">
          <GitBranch size={24} />
          <h2>Pull Request 工作区</h2>
          <p>SeeCoder 不伪造远程数据。点击检查会调用本机 gh；未安装或未登录时会显示配置指引。</p>
          <button
            className="primary-button"
            data-action="check-pr-status"
            onClick={async () => {
              try {
                const result = await window.seecoder.git.prStatus();
                onToast(
                  resultOutput(result)
                    ? JSON.stringify(resultOutput(result))
                    : '请安装 gh 并执行 gh auth login',
                );
              } catch (error) {
                onToast(error instanceof Error ? error.message : '无法读取 PR 状态，请检查 gh 配置');
              }
            }}
          >
            检查 PR 状态
          </button>
        </div>
      </div>
    );
  if (page === 'sites')
    return (
      <div className="workspace-page">
        <PageHeader icon={ExternalLink} title="站点 / Preview" subtitle="本地开发服务器预览" />
        <div className="feature-card">
          <ExternalLink size={24} />
          <h2>打开本地 Preview</h2>
          <p>云端部署不在本 Demo 范围内，Preview 仅允许 localhost。</p>
          <div className="input-row">
            <input value={url} onChange={(event) => setUrl(event.target.value)} />
            <button
              className="primary-button"
              data-action="open-preview"
              onClick={async () => {
                try {
                  await window.seecoder.preview.open(url);
                  onToast('已打开 Preview');
                } catch (error) {
                  onToast(error instanceof Error ? error.message : '地址无效');
                }
              }}
            >
              打开
            </button>
          </div>
        </div>
      </div>
    );
  if (page === 'scheduled')
    return (
      <div className="workspace-page">
        <PageHeader
          icon={History}
          title="已安排"
          subtitle="只读 Plan 任务，仅在 SeeCoder 运行时执行"
        />
        <div className="feature-card">
          <div className="page-toolbar">
            <strong>本地计划任务</strong>
            <button
              className="primary-button"
              data-action="new-schedule"
              onClick={async () => {
                try {
                  const value: ScheduleDefinition = {
                    id: crypto.randomUUID(),
                    projectPath: workspace,
                    prompt: '检查当前项目是否存在未解决的测试失败，并给出报告。',
                    cadence: 'daily',
                    enabled: true,
                  };
                  const next = await window.seecoder.schedule.save(value);
                  setSchedules(next);
                  onToast('计划已保存');
                } catch (error) {
                  onToast(error instanceof Error ? error.message : '计划保存失败，请重试');
                }
              }}
            >
              新建计划
            </button>
          </div>
          {schedules.map((item) => (
            <div className="schedule-row" key={item.id}>
              <div>
                <strong>{item.prompt}</strong>
                <span>
                  {item.cadence} · {item.enabled ? '启用' : '暂停'}
                </span>
              </div>
              <button
                className="small-button"
                data-action="toggle-schedule"
                onClick={async () => {
                  try {
                    await window.seecoder.schedule.toggle(item.id, !item.enabled);
                    setSchedules((values) =>
                      values.map((value) =>
                        value.id === item.id ? { ...value, enabled: !value.enabled } : value,
                      ),
                    );
                    onToast(item.enabled ? '计划已暂停' : '计划已启用');
                  } catch (error) {
                    onToast(error instanceof Error ? error.message : '计划状态更新失败');
                  }
                }}
              >
                切换
              </button>
              <button
                className="small-button"
                data-action="run-schedule"
                onClick={async () => {
                  try {
                    await window.seecoder.schedule.run(item.id);
                    onToast('计划已启动');
                  } catch (error) {
                    onToast(error instanceof Error ? error.message : '计划启动失败，请检查模型配置');
                  }
                }}
              >
                <Play size={12} />
                立即运行
              </button>
            </div>
          ))}
          {!schedules.length && (
            <div className="empty-panel">
              <strong>尚无计划</strong>
              <span>新建计划会固定以 Plan 模式进行只读检查。</span>
            </div>
          )}
        </div>
      </div>
    );
  if (page === 'plugins')
    return (
      <div className="workspace-page">
        <PageHeader
          icon={Sparkles}
          title="插件与 Skills"
          subtitle="本地可复用能力、Hooks 和只读子 Agent"
        />
        <div className="feature-card">
          <div className="page-toolbar">
            <strong>已发现扩展</strong>
            <div className="extension-toolbar-actions">
              <button className="small-button primary" data-action="import-skill" onClick={async () => {
                try {
                  const result = await window.seecoder.extension.import();
                  if (result.cancelled) return;
                  await reloadExtensions();
                  onToast(`已导入 ${result.skill?.name ?? 'Skill'}`);
                } catch (error) { onToast(error instanceof Error ? error.message : 'Skill 导入失败'); }
              }}><Upload size={12} />导入本地 Skill</button>
              <button className="small-button" data-action="rescan-extensions" onClick={() => void reloadExtensions()}><RefreshCw size={12} />重新扫描</button>
            </div>
          </div>
          {extensions.map((item) => (
            <div className="extension-row" key={`${item.kind}-${item.path}`}>
              <Sparkles size={15} />
              <div>
                <strong>{item.name}</strong>
                <span>{item.description}</span>
                <small>{item.scope === 'managed' ? `本机导入 · ${item.sourcePath ?? item.relativePath}` : `项目 · ${item.relativePath}`}</small>
              </div>
              <code>{item.scope === 'managed' ? '本机' : item.kind}</code>
              {item.kind === 'skill' && <button className="small-button" data-action="use-skill" onClick={() => onUseSkill(item)}>用于新任务</button>}
              {item.kind === 'hook' && item.hookStatus !== 'invalid' && <button className={`small-button ${item.hookStatus === 'trusted' ? '' : 'primary'}`} data-action="toggle-hooks" onClick={async () => {
                const enable = item.hookStatus !== 'trusted';
                if (enable) {
                  const confirmed = await onRequestPrompt({ title: '信任项目 Hooks', description: 'Hooks 会在工具、文件修改和任务结束时运行本地命令。请先审查 .seecoder/hooks.json；配置变化后信任会自动失效。', confirm: true, submitLabel: '信任并启用' });
                  if (confirmed !== '__confirm__') return;
                }
                try { setExtensions(await window.seecoder.extension.trustHooks(enable)); onToast(enable ? 'Hooks 已信任并启用' : 'Hooks 已停用'); }
                catch (error) { onToast(error instanceof Error ? error.message : 'Hooks 状态更新失败'); }
              }}>{item.hookStatus === 'trusted' ? '停用' : '信任并启用'}</button>}
              {item.kind === 'hook' && item.hookStatus === 'invalid' && <span className="extension-error" title={item.hookError}>配置无效</span>}
              {item.kind === 'skill' && item.scope === 'managed' && <div className="extension-actions">
                <button className="icon-button" title="从原始目录更新" aria-label={`更新 ${item.name}`} data-action="refresh-skill" onClick={async () => { try { setExtensions(await window.seecoder.extension.refresh(item.id)); onToast(`${item.name} 已更新`); } catch (error) { onToast(error instanceof Error ? error.message : 'Skill 更新失败'); } }}><RefreshCw size={13} /></button>
                <button className="icon-button" title="重命名" aria-label={`重命名 ${item.name}`} data-action="rename-skill" onClick={async () => { const name = await onRequestPrompt({ title: '重命名 Skill', value: item.name, placeholder: '输入 Skill 名称…' }); if (!name?.trim()) return; setExtensions(await window.seecoder.extension.rename(item.id, name.trim())); onToast('Skill 已重命名'); }}><MoreHorizontal size={13} /></button>
                <button className="icon-button" title="打开来源" aria-label={`打开 ${item.name} 来源`} data-action="open-skill-source" onClick={() => void window.seecoder.extension.openSource(item.id)}><FolderOpen size={13} /></button>
                <button className="icon-button danger" title="删除" aria-label={`删除 ${item.name}`} data-action="delete-skill" onClick={async () => { const confirmed = await onRequestPrompt({ title: '删除 Skill', description: `将从 SeeCoder 本机库删除“${item.name}”，不会删除原始来源目录。`, confirm: true, submitLabel: '删除' }); if (confirmed !== '__confirm__') return; setExtensions(await window.seecoder.extension.delete(item.id)); onToast('Skill 已删除'); }}><X size={13} /></button>
              </div>}
            </div>
          ))}
          {!extensions.length && (
            <div className="empty-panel">
              <strong>未发现本地扩展</strong>
              <span>点击“导入本地 Skill”并选择 SKILL.md，SeeCoder 会安全复制并管理它。</span>
            </div>
          )}
          <div className="notice-box">
            <ShieldCheck size={15} />
            远程插件市场和 MCP 未启用，避免突破考核规定的最小权限边界。
          </div>
        </div>
      </div>
    );
  if (page === 'settings')
    return (
      <SettingsPage
        settings={settings}
        onUpdate={async (next) => {
          const value = await window.seecoder.settings.update(next);
          setSettings(value);
          onModelChange(value.model, value.modelProfiles ?? []);
          return value;
        }}
        onToast={onToast}
        onConfirm={onRequestPrompt}
      />
    );
  return (
    <div className="workspace-page">
      <PageHeader icon={Code2} title="关于 SeeCoder" subtitle="自研本地编程智能体 Demo" />
      <div className="feature-card about-card">
        <div className="brand-mark large">
          <Code2 size={28} />
        </div>
        <h2>SeeCoder</h2>
        <p>核心循环、工具协议、权限、上下文、SSE 解析、事件轨迹和本地执行均由项目自行实现。</p>
        <div className="about-grid">
          <span>工作区</span>
          <strong>{workspace}</strong>
          <span>任务数</span>
          <strong>{sessions.length}</strong>
          <span>Git 状态</span>
          <strong>{gitText || '点击 Changes 刷新'}</strong>
        </div>
        <button className="primary-button" data-action="about-new-task" onClick={onNew}>
          开始新任务
        </button>
      </div>
    </div>
  );
}
function SettingsPage({
  settings,
  onUpdate,
  onToast,
  onConfirm,
}: {
  settings: SettingsView | undefined;
  onUpdate: (next: SettingsUpdate) => Promise<SettingsView>;
  onToast: (value: string) => void;
  onConfirm: (request: PromptRequest) => Promise<string | null>;
}): React.JSX.Element {
  const [editing, setEditing] = useState<ModelProfile | 'new'>();
  const [busy, setBusy] = useState<string>();
  async function update(next: SettingsUpdate, success: string): Promise<void> {
    setBusy(success);
    try {
      await onUpdate(next);
      onToast(success);
    } catch (error) {
      onToast(error instanceof Error ? error.message : '模型配置更新失败');
    } finally {
      setBusy(undefined);
    }
  }
  const profiles = settings?.modelProfiles ?? [];
  return (
    <div className="workspace-page">
      <PageHeader icon={Settings2} title="模型" subtitle="管理 SeeCoder 可使用的模型与凭据" />
      <section className="model-management">
        <div className="model-management-head">
          <div><h2>模型管理</h2><p>添加 OpenAI 兼容模型，并选择任务默认使用的配置。</p></div>
          <button className="primary-button compact" data-action="add-model" onClick={() => setEditing('new')}><Plus size={14} />添加模型</button>
        </div>
        <div className="model-table" role="table" aria-label="模型配置">
          <div className="model-table-head" role="row"><span>模型</span><span>服务商</span><span>凭据</span><span>操作</span></div>
          {profiles.map((profile) => {
            const active = profile.id === settings?.activeModelProfileId;
            return <div className={`model-row ${active ? 'active' : ''}`} role="row" key={profile.id} data-action="model-row">
              <div className="model-identity"><span className="model-logo"><Code2 size={15} /></span><span><strong>{profile.name}</strong><code>{profile.model}</code></span>{active && <b>当前</b>}</div>
              <div className="model-provider"><strong>{profile.provider}</strong><span title={profile.baseUrl}>{profile.baseUrl}</span></div>
              <div className="model-credential" data-action="api-key-status"><ShieldCheck size={14} /><span>{profile.hasApiKey ? (profile.keyStorage === 'environment' ? '环境变量' : profile.apiKeyHint) : '未配置'}</span></div>
              <div className="model-actions">
                {!active && profile.enabled && <button className="small-button" data-action="set-active-model" disabled={Boolean(busy)} onClick={() => void update({ activeModelProfileId: profile.id }, `已切换到 ${profile.name}`)}>使用</button>}
                <button className="icon-button" data-action="edit-model" title="编辑模型" aria-label={`编辑 ${profile.name}`} onClick={() => setEditing(profile)}><Settings2 size={14} /></button>
                <button className="icon-button danger" data-action="delete-model" title="删除模型" aria-label={`删除 ${profile.name}`} disabled={profiles.length <= 1 || Boolean(busy)} onClick={async () => {
                  const confirmed = await onConfirm({ title: '删除模型', description: `删除“${profile.name}”及其加密凭据。此操作不会影响已有会话记录。`, confirm: true, submitLabel: '删除' });
                  if (confirmed === '__confirm__') void update({ deleteModelId: profile.id }, '模型已删除');
                }}><X size={14} /></button>
                <button className={`toggle-switch ${profile.enabled ? 'on' : ''}`} data-action="toggle-model" role="switch" aria-checked={profile.enabled} aria-label={`${profile.enabled ? '停用' : '启用'} ${profile.name}`} disabled={Boolean(busy)} onClick={() => void update({ toggleModel: { id: profile.id, enabled: !profile.enabled } }, profile.enabled ? '模型已停用' : '模型已启用')}><span /></button>
              </div>
            </div>;
          })}
        </div>
        {settings?.logPath && <details className="diagnostics"><summary>本地数据与诊断</summary><div><strong>后台日志</strong><code title={settings.logPath}>{settings.logPath}</code><span>日志不记录 API Key 或完整文件内容。</span></div></details>}
      </section>
      {editing && <ModelEditorDialog profile={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} onSave={async (value) => { await onUpdate({ upsertModel: value }); setEditing(undefined); onToast(editing === 'new' ? '模型已添加' : '模型已更新'); }} />}
    </div>
  );
}

function ModelEditorDialog({ profile, onClose, onSave }: { profile?: ModelProfile | undefined; onClose: () => void; onSave: (value: ModelProfileInput) => Promise<void> }): React.JSX.Element {
  const [name, setName] = useState(profile?.name ?? '');
  const [provider, setProvider] = useState(profile?.provider ?? 'DeepSeek');
  const [model, setModel] = useState(profile?.model ?? '');
  const [baseUrl, setBaseUrl] = useState(profile?.baseUrl ?? 'https://api.deepseek.com');
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(): Promise<void> {
    setSaving(true); setError(undefined);
    try { await onSave({ ...(profile ? { id: profile.id } : {}), name, provider, model, baseUrl, enabled: profile?.enabled ?? true, ...(apiKey ? { apiKey } : {}), ...(clearApiKey ? { clearApiKey: true } : {}) }); }
    catch (value) { setError(value instanceof Error ? value.message : '模型保存失败'); setSaving(false); }
  }
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="prompt-dialog model-editor" role="dialog" aria-modal="true" aria-labelledby="model-editor-title">
      <div className="prompt-dialog-head"><strong id="model-editor-title">{profile ? '编辑模型' : '添加模型'}</strong><button className="icon-button" data-action="model-dialog-close" aria-label="关闭" onClick={onClose}><X size={15} /></button></div>
      <p>模型配置只保存在本机。API Key 使用操作系统安全存储加密。</p>
      <div className="model-form">
        <label>显示名称<input data-action="model-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 DeepSeek Chat" /></label>
        <label>服务商<select data-action="model-provider" value={provider} onChange={(event) => { const next = event.target.value; setProvider(next); if (!profile) setBaseUrl(next === 'DeepSeek' ? 'https://api.deepseek.com' : next === 'OpenAI' ? 'https://api.openai.com/v1' : ''); }}><option>DeepSeek</option><option>OpenAI</option><option>OpenAI 兼容</option><option>自定义</option></select></label>
        <label>模型标识<input data-action="settings-model" value={model} onChange={(event) => setModel(event.target.value)} placeholder="例如 deepseek-chat" /></label>
        <label>Base URL<input data-action="model-base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" /></label>
        <label>API Key{profile?.hasApiKey && <span className="saved-key"><ShieldCheck size={13} />{profile.keyStorage === 'environment' ? '来自环境变量' : `已保存 ${profile.apiKeyHint ?? ''}`}</span>}<div className="input-with-icon"><KeyRound size={15} /><input data-action="api-key-input" type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setClearApiKey(false); }} placeholder={profile?.hasApiKey ? '留空保持不变' : '输入 API Key'} /></div></label>
        {profile?.hasApiKey && profile.keyStorage === 'os' && <label className="clear-key-option"><input type="checkbox" checked={clearApiKey} onChange={(event) => { setClearApiKey(event.target.checked); if (event.target.checked) setApiKey(''); }} />清除当前配置已保存的 API Key</label>}
      </div>
      {error && <div className="settings-error">{error}</div>}
      <div className="prompt-dialog-actions"><button className="small-button" onClick={onClose}>取消</button><button className="small-button primary" data-action="save-model" disabled={saving || !name.trim() || !model.trim() || !baseUrl.trim()} onClick={() => void submit()}>{saving ? '保存中…' : '保存模型'}</button></div>
    </div>
  </div>;
}
function PageHeader({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
}): React.JSX.Element {
  return (
    <header className="page-header">
      <div className="page-icon">
        <Icon size={20} />
      </div>
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
    </header>
  );
}
function languageFor(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  return extension === 'ts' || extension === 'tsx'
    ? 'typescript'
    : extension === 'js' || extension === 'jsx'
      ? 'javascript'
      : extension === 'json'
        ? 'json'
        : extension === 'css'
          ? 'css'
          : extension === 'md'
            ? 'markdown'
            : 'plaintext';
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
