import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { DiffEditor, Editor } from '@monaco-editor/react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  Activity,
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
  PlanStep,
  ScheduleDefinition,
  SubagentState,
  Thread,
} from '@seecoder/protocol';
import type { SeeCoderApi } from '../preload/preload';
import './styles.css';

const previewThread: Thread = {
  id: 'preview-thread',
  title: '界面预览任务',
  workspacePath: 'Preview',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const previewResult = (output: unknown) => Promise.resolve({ ok: true, output, durationMs: 0 });
const previewApi: SeeCoderApi = {
  workspace: { select: async () => ({ cancelled: true }), open: async () => 'Preview' },
  thread: {
    create: async (title?: string) => ({
      ...previewThread,
      id: `preview-${Date.now()}`,
      title: title ?? previewThread.title,
    }),
    list: async () => [previewThread],
    hydrate: async () => previewThread,
    history: async () => [],
    rename: async (_id, title) => ({ ...previewThread, title }),
    flag: async () => previewThread,
    fork: async () => previewThread,
    search: async () => [previewThread],
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
  extension: { list: async () => [] },
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
interface InputRequest {
  requestId: string;
  question: string;
  choices?: string[];
  turnId: string;
}
interface UiState {
  threads: Thread[];
  selectedThread: Thread | undefined;
  events: TimelineItem[];
  streamingText: string;
  approvals: Approval[];
  inputRequests: InputRequest[];
  plans: PlanStep[];
  changes: ChangeSet[];
  children: SubagentState[];
  terminal: string[];
  running: boolean;
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
  threads: [],
  selectedThread: undefined,
  events: [],
  streamingText: '',
  approvals: [],
  inputRequests: [],
  plans: [],
  changes: [],
  children: [],
  terminal: [],
  running: false,
  currentTurnId: undefined,
  mode: 'guided',
  model: 'gpt-4o-mini',
  toast: undefined,
  reviewFindings: [],
  set: (patch) => set(patch),
  addEvent: (event) =>
    set((state) => {
      if (state.selectedThread && event.threadId && event.threadId !== state.selectedThread.id) return state;
      const next = [...state.events, { id: `${Date.now()}-${Math.random()}`, event }].slice(-800);
      if (event.type === 'message.delta')
        return {
          events: next,
          streamingText: `${state.streamingText}${event.text}`,
          running: true,
          currentTurnId: event.turnId,
        };
      if (event.type === 'message.completed')
        return { events: next, streamingText: '', running: true, currentTurnId: event.turnId };
      if (event.type === 'turn.started')
        return { events: next, running: true, currentTurnId: event.turn.id };
      if (event.type === 'approval.requested')
        return {
          events: next,
          approvals: [...state.approvals, event.approval],
          running: true,
          currentTurnId: event.approval.turnId,
        };
      if (event.type === 'approval.resolved')
        return {
          events: next,
          approvals: state.approvals.filter((item) => item.id !== event.approvalId),
        };
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
          currentTurnId: event.turnId,
        };
      if (event.type === 'user.input.resolved')
        return {
          events: next,
          inputRequests: state.inputRequests.filter((item) => item.requestId !== event.requestId),
        };
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
        return { events: next, running: false, streamingText: '', currentTurnId: undefined };
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

function App(): React.JSX.Element {
  const state = useStore();
  const {
    threads,
    selectedThread,
    events,
    streamingText,
    approvals,
    inputRequests,
    plans,
    changes,
    children,
    terminal,
    running,
    currentTurnId,
    mode,
    model,
    toast,
    reviewFindings,
  } = state;
  const set = state.set;
  const addEvent = state.addEvent;
  const [workspace, setWorkspace] = useState('未选择工作区');
  const [page, setPage] = useState<
    'task' | 'history' | 'pulls' | 'sites' | 'scheduled' | 'plugins' | 'settings' | 'about'
  >('task');
  const [inspector, setInspector] = useState<
    'changes' | 'files' | 'terminal' | 'preview' | 'trace'
  >('changes');
  const [composer, setComposer] = useState('');
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [files, setFiles] = useState<string[]>([]);
  const [gitText, setGitText] = useState('');
  const [filePreview, setFilePreview] = useState<{ path: string; text: string } | undefined>();

  useEffect(() => {
    const unsubscribe = window.seecoder.events.subscribe(addEvent);
    const menuUnsubscribe = window.seecoder.menu.subscribe((action) => {
      if (action === 'new-thread') void newThread();
      if (action === 'command-palette') window.dispatchEvent(new Event('seecoder:command'));
      if (action === 'toggle-inspector') setCollapsed((value) => !value);
      if (action === 'about') setPage('about');
      if (action === 'help') setPage('about');
    });
    void (async () => {
      const settings = await window.seecoder.settings.read();
      setWorkspace(settings.workspace);
      set({ mode: settings.mode, model: settings.model });
      const list = (await window.seecoder.thread.list()) as Thread[];
      if (list.length) {
        set({ threads: list, selectedThread: list[0] });
        await loadThread(list[0]!);
      } else {
        const created = (await window.seecoder.thread.create('首个 SeeCoder 任务')) as Thread;
        set({ threads: [created], selectedThread: created });
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
      if (value instanceof Error) return value.message;
      if (typeof value === 'string') return value;
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

  async function loadThread(thread: Thread): Promise<void> {
    await window.seecoder.thread.hydrate(thread.id);
    const history = (await window.seecoder.thread.history(thread.id)) as AgentEvent[];
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
    });
    history.forEach(addEvent);
  }
  async function selectThread(thread: Thread): Promise<void> {
    set({ selectedThread: thread });
    await loadThread(thread);
    setPage('task');
  }
  async function newThread(): Promise<void> {
    const created = (await window.seecoder.thread.create('新的 SeeCoder 任务')) as Thread;
    set({
      threads: [created, ...threads],
      selectedThread: created,
      events: [],
      approvals: [],
      inputRequests: [],
      plans: [],
      changes: [],
      children: [],
      terminal: [],
      reviewFindings: [],
      streamingText: '',
    });
    setPage('task');
  }
  async function chooseWorkspace(): Promise<void> {
    const selected = (await window.seecoder.workspace.select()) as {
      cancelled: boolean;
      workspace?: string;
    };
    if (!selected.cancelled && selected.workspace) {
      setWorkspace(selected.workspace);
      const workspaceThreads = (await window.seecoder.thread.list()) as Thread[];
      const created = (await window.seecoder.thread.create('新工作区任务')) as Thread;
      set({
        threads: [created, ...workspaceThreads.filter((thread) => thread.id !== created.id)],
        selectedThread: created,
        events: [],
        approvals: [],
        inputRequests: [],
        plans: [],
        changes: [],
        children: [],
        terminal: [],
        reviewFindings: [],
      });
      setPage('task');
    }
  }
  async function send(): Promise<void> {
    const text = composer.trim();
    if (!text || !selectedThread) return;
    const shouldSuggestTitle = /^新的 SeeCoder 任务$|^新工作区任务$/.test(selectedThread.title);
    const suggestedTitle = (text.split(/\r?\n/)[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 42);
    setComposer('');
    try {
      if (running && currentTurnId) {
        await window.seecoder.turn.followUp(currentTurnId, text);
        set({ toast: '已加入当前任务的追加要求' });
        return;
      }
      set({ running: true, streamingText: '' });
      const turnId = (await window.seecoder.turn.start(
        selectedThread.id,
        text,
        attachments,
      )) as string;
      set({ currentTurnId: turnId });
      if (shouldSuggestTitle && suggestedTitle) {
        void window.seecoder.thread.rename(selectedThread.id, suggestedTitle).then((renamed) => {
          set({
            threads: threads.map((thread) => thread.id === renamed.id ? renamed : thread),
            selectedThread: renamed,
          });
        }).catch(() => undefined);
      }
      setAttachments([]);
    } catch (error) {
      set({ running: false, currentTurnId: undefined, toast: `任务启动失败：${error instanceof Error ? error.message : '请检查模型配置'}` });
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
  async function replan(): Promise<void> { if (!selectedThread) return; set({ running: true }); const turnId = (await window.seecoder.turn.start(selectedThread.id, '请根据当前目标和已有证据重新规划执行步骤。')) as string; set({ currentTurnId: turnId, toast: '已请求重新规划' }); }
  function editPlanStep(id: string): void { const label = window.prompt('编辑计划步骤'); if (label?.trim()) set({ plans: plans.map((step) => step.id === id ? { ...step, label: label.trim() } : step), toast: '计划步骤已更新（将在下一轮同步给模型）' }); }
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
      const message = error instanceof Error ? error.message : '无法读取 Git 状态';
      setGitText(`Git 状态读取失败：${message}`);
      set({ toast: message });
    }
  }
  useEffect(() => {
    if (page === 'task' && selectedThread) void loadGit();
  }, [page, selectedThread?.id]);
  async function copyText(text: string): Promise<void> {
    await navigator.clipboard?.writeText(text);
    set({ toast: '已复制到剪贴板' });
  }
  async function renameThread(): Promise<void> {
    if (!selectedThread) return;
    const title = window.prompt('任务名称', selectedThread.title);
    if (!title?.trim()) return;
    const renamed = (await window.seecoder.thread.rename(
      selectedThread.id,
      title.trim(),
    )) as Thread;
    set({
      selectedThread: renamed,
      threads: threads.map((item) => (item.id === renamed.id ? renamed : item)),
    });
  }
  async function exportThread(format: 'markdown' | 'json'): Promise<void> {
    if (selectedThread) {
      await window.seecoder.thread.export(selectedThread.id, format);
      set({ toast: '已打开导出对话框' });
    }
  }
  async function showThreadMenu(): Promise<void> {
    if (!selectedThread) return;
    const action = window.prompt('输入操作：pin / archive / fork / export');
    if (action === 'pin' || action === 'archive') {
      const updated = (await window.seecoder.thread.flag(
        selectedThread.id,
        action === 'pin' ? 'pinned' : 'archived',
      )) as Thread;
      set({
        selectedThread: updated,
        threads: threads.map((item) => (item.id === updated.id ? updated : item)),
        toast: action === 'pin' ? '任务已置顶' : '任务已归档',
      });
    } else if (action === 'fork') {
      const forked = (await window.seecoder.thread.fork(selectedThread.id)) as Thread;
      set({ threads: [forked, ...threads], selectedThread: forked, toast: '已创建任务 Fork' });
    } else if (action === 'export') await exportThread('markdown');
  }
  async function showBranches(): Promise<void> {
    const result = await window.seecoder.git.branches();
    const listing = String(resultOutput(result) ?? '未找到 Git 仓库');
    const selected = window.prompt(`本地分支：\n${listing}\n\n输入要切换的分支（取消仅查看）`);
    if (selected?.trim()) {
      const switched = await window.seecoder.git.checkout(selected.trim());
      set({ toast: String(resultOutput(switched) ?? `已切换到 ${selected.trim()}`) });
      await loadGit();
    } else set({ toast: listing });
  }
  async function stageFile(path: string): Promise<void> {
    const result = await window.seecoder.git.stage(path);
    set({ toast: resultOutput(result) ? `已暂存 ${path}` : 'Stage 未完成，请检查 Git 状态' });
  }
  async function restoreCheckpoint(id: string): Promise<void> { const result = await window.seecoder.checkpoint.restore(id); set({ toast: resultOutput(result) ? 'Checkpoint 已恢复' : 'Checkpoint 恢复失败' }); await loadGit(); }
  function feedback(kind: 'like' | 'dislike'): void {
    set({ toast: kind === 'like' ? '感谢反馈，已记录为有帮助' : '已记录改进反馈' });
  }
  async function showCommandPalette(): Promise<void> {
    const command = window.prompt('命令：/plan /review /diff /compact /status /skills');
    if (command === '/plan') await togglePlan();
    else if (command === '/review') {
      setPage('task');
      setInspector('trace');
      if (selectedThread) {
        set({ running: true });
        const turnId = (await window.seecoder.turn.start(selectedThread.id, '请调用 review_changes 审查当前工作区变更，并按严重度输出发现。')) as string;
        set({ currentTurnId: turnId });
      } else set({ toast: '请先选择任务' });
    } else if (command === '/diff') setInspector('changes');
    else if (command === '/status') {
      await loadGit();
      setInspector('files');
    } else if (command === '/skills') setPage('plugins');
    else if (command === '/compact') set({ toast: '下一轮将根据上下文预算自动压缩历史' });
  }
  useEffect(() => {
    const listener = () => void showCommandPalette();
    window.addEventListener('seecoder:command', listener);
    return () => window.removeEventListener('seecoder:command', listener);
  });

  const currentMessages = useMemo(
    () =>
      events
        .map((item) => item.event)
        .filter(
          (event): event is Extract<AgentEvent, { type: 'message.completed' | 'message.user' }> =>
            event.type === 'message.completed' || event.type === 'message.user',
        ),
    [events],
  );
  const visibleThreads = threads.filter(
    (thread) =>
      !thread.archived && (!search || thread.title.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <div className={`app-shell ${theme}`}>
      <Sidebar
        workspace={workspace}
        page={page}
        setPage={setPage}
        threads={visibleThreads}
        selectedThread={selectedThread}
        onThread={selectThread}
        onWorkspace={chooseWorkspace}
        onNew={newThread}
        search={search}
        setSearch={setSearch}
        onNotify={() => setPage('history')}
        onTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')}
      />
      <main className={`main-column ${collapsed ? 'wide' : ''}`}>
        {page === 'task' ? (
          <TaskPage
            selectedThread={selectedThread}
            mode={mode}
            running={running}
            currentMessages={currentMessages}
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
            onRename={renameThread}
            onExport={exportThread}
            onCopy={copyText}
            onFeedback={feedback}
            onMenu={showThreadMenu}
            onBranch={showBranches}
            onRestoreCheckpoint={restoreCheckpoint}
            onOpenInspector={() => { setCollapsed(false); setInspector('changes'); }}
          />
        ) : (
          <WorkspacePage
            page={page}
            workspace={workspace}
            threads={threads}
            gitText={gitText}
            onRefreshGit={loadGit}
            onNew={newThread}
            onOpenThread={selectThread}
            onToast={(value) => set({ toast: value })}
            onModelChange={(value) => set({ model: value })}
          />
        )}
        {page === 'task' && (
          <Composer
            value={composer}
            setValue={setComposer}
            running={running}
            mode={mode}
            model={model}
            attachments={attachments}
            onAttach={attach}
            onModeSelect={setExecutionMode}
            onPlan={togglePlan}
            onSend={send}
            onCancel={() => currentTurnId && void window.seecoder.turn.cancel(currentTurnId)}
            onSettings={() => setPage('settings')}
          />
        )}
      </main>
      {!collapsed && page === 'task' && (
        <aside className="inspector">
          <div className="inspector-head">
            <div className="inspector-tabs">
              {(
                [
                  ['changes', 'Changes', GitBranch],
                  ['files', 'Files', FolderOpen],
                  ['terminal', 'Terminal', Terminal],
                  ['preview', 'Preview', ExternalLink],
                  ['trace', 'Trace', Activity],
                ] as const
              ).map(([key, label, Icon]) => (
                <button
                  key={key}
                  data-action={`inspector-${key}`}
                  className={inspector === key ? 'active' : ''}
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
          />
        </aside>
      )}
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          <Check size={14} />
          {toast}
        </div>
      )}
    </div>
  );
}

function Sidebar({
  workspace,
  page,
  setPage,
  threads,
  selectedThread,
  onThread,
  onWorkspace,
  onNew,
  search,
  setSearch,
  onNotify,
  onTheme,
}: {
  workspace: string;
  page: string;
  setPage: (
    page: 'task' | 'history' | 'pulls' | 'sites' | 'scheduled' | 'plugins' | 'settings' | 'about',
  ) => void;
  threads: Thread[];
  selectedThread: Thread | undefined;
  onThread: (thread: Thread) => void;
  onWorkspace: () => void;
  onNew: () => void;
  search: string;
  setSearch: (value: string) => void;
  onNotify: () => void;
  onTheme: () => void;
}): React.JSX.Element {
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
          onClick={() => {
            const value = window.prompt('搜索任务、消息或分支', search);
            if (value !== null) setSearch(value);
            setPage('history');
          }}
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
      <button className="workspace-button" data-action="choose-workspace" onClick={onWorkspace}>
        <FolderOpen size={16} />
        <span className="truncate">{workspace.split(/[\\/]/).pop()}</span>
        <ChevronDown size={14} />
      </button>
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
        <span className="count">{threads.length}</span>
      </div>
      <div className="thread-list">
        {threads.slice(0, 18).map((thread) => (
          <button
            key={thread.id}
            data-action="open-thread"
            className={`thread ${selectedThread?.id === thread.id && page === 'task' ? 'selected' : ''}`}
            onClick={() => onThread(thread)}
          >
            <MessageSquare size={15} />
            <span className="truncate">{thread.title}</span>
            {thread.pinned && <Pin size={12} />}
          </button>
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
  selectedThread,
  mode,
  running,
  currentMessages,
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
  onMenu,
  onBranch,
  onRestoreCheckpoint,
  onOpenInspector,
}: {
  selectedThread: Thread | undefined;
  mode: ExecutionMode;
  running: boolean;
  currentMessages: Array<Extract<AgentEvent, { type: 'message.completed' | 'message.user' }>>;
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
  onMenu: () => void;
  onBranch: () => void;
  onRestoreCheckpoint: (id: string) => void;
  onOpenInspector: () => void;
}): React.JSX.Element {
  const activityRecords = useMemo(() => {
    const records: ActivityRecord[] = [];
    const byCallId = new Map<string, ActivityRecord>();
    events.forEach(({ event }) => {
      if (event.type === 'tool.requested') {
        const record = byCallId.get(event.call.id) ?? { id: `tool-${event.call.id}` };
        record.requested = event;
        byCallId.set(event.call.id, record);
        if (!records.includes(record)) records.push(record);
      } else if (event.type === 'tool.completed') {
        const record = byCallId.get(event.callId) ?? { id: `tool-${event.callId}` };
        record.completed = event;
        byCallId.set(event.callId, record);
        if (!records.includes(record)) records.push(record);
      } else if (event.type === 'context.compacted' || event.type === 'checkpoint.created') {
        records.push({ id: `${event.type}-${event.type === 'checkpoint.created' ? event.checkpoint.id : event.timestamp}`, auxiliary: event });
      }
    });
    return records;
  }, [events]);
  const latestTurnResult = useMemo(
    () => [...events].reverse().find(({ event }) => event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled'),
    [events],
  );
  return (
    <>
      <header className="topbar">
        <div className="crumb">
          <FolderOpen size={15} />
          <button data-action="rename-thread" className="crumb-title" onClick={onRename}>
            {selectedThread?.title ?? 'SeeCoder'}
          </button>
          {selectedThread?.workspacePath && (
            <span
              className="workspace-context"
              title={selectedThread.workspacePath}
              aria-label={`当前工作区：${selectedThread.workspacePath}`}
            >
              <FolderOpen size={12} />
              {selectedThread.workspacePath.split(/[\\/]/).pop()}
            </span>
          )}
          <button data-action="thread-menu" className="icon-button" onClick={onMenu}>
            <MoreHorizontal size={16} />
          </button>
        </div>
        <div className="top-actions">
          <span className={`run-status ${running ? 'running' : ''}`}><span className="status-dot" />{running ? '运行中' : '就绪'}</span>
          <button data-action="branch" className="ghost-button" onClick={onBranch}>
            <GitBranch size={14} />
            {selectedThread?.branch ?? 'main'}
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
      <section className="conversation">
        <div className="welcome">
          <div className="welcome-orb">
            <Sparkles size={23} />
          </div>
          <div>
            <h1>让代码，自己找到答案。</h1>
            <p>描述一个目标，SeeCoder 会探索、修改并验证你的工作区。</p>
          </div>
        </div>
        {plans.length > 0 && <PlanCard plans={plans} mode={mode} onApprove={onPlan} onReplan={onReplan} onEdit={onEditPlan} />}
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
          {currentMessages.map((message) => (
            <MessageCard
              key={`${message.type}-${message.turnId}-${message.timestamp}`}
              message={message}
              onCopy={onCopy}
              onFeedback={onFeedback}
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
          {activityRecords.map((record) => (
              <ActivityCard
                key={record.id}
                record={record}
                expanded={Boolean(expanded[record.id])}
                onRestoreCheckpoint={onRestoreCheckpoint}
                onToggle={() => setExpanded((value) => ({ ...value, [record.id]: !value[record.id] }))}
              />
            ))}
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
                {children.filter((child) => child.status === 'completed').length}/{children.length}{' '}
                已完成
              </span>
            </div>
            {children.map((child) => (
              <div className="child-pill" key={child.id}>
                <span className={`child-status ${child.status}`} />
                <strong>{child.role === 'explore' ? 'Explore' : 'Review'}</strong>
                <span className="truncate">{child.task}</span>
                <span className="child-result">
                  {child.status === 'completed'
                    ? '完成'
                    : child.status === 'running'
                      ? '运行中'
                      : child.status}
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
              <span>变更、测试和轨迹证据已保存。</span>
            </div>
            <button data-action="view-result" onClick={onOpenInspector}>
              <PanelRight size={14} />
              查看结果
            </button>
          </div>
        )}
        {latestTurnResult?.event.type === 'turn.failed' && (
          <div className="complete-banner failure-banner">
            <div className="complete-icon"><X size={15} /></div>
            <div>
              <strong>任务失败</strong>
              <span>{latestTurnResult.event.error.message}</span>
            </div>
            <button data-action="view-failure" onClick={onOpenInspector}>
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
  onApprove,
  onReplan,
  onEdit,
}: {
  plans: PlanStep[];
  mode: ExecutionMode;
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
        {mode === 'plan' && (
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
}: {
  message: Extract<AgentEvent, { type: 'message.completed' | 'message.user' }>;
  onCopy: (text: string) => void;
  onFeedback: (kind: 'like' | 'dislike') => void;
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
        <div className="message-text">{message.text}</div>
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
  const detail = JSON.stringify({ requested: record.requested, completed: record.completed, auxiliary: record.auxiliary }, null, 2);
  const displayDetail = detail.length > 12000
    ? `${detail.slice(0, 8000)}\n…详情已截断，完整内容仍保存在事件轨迹中…\n${detail.slice(-2000)}`
    : detail;
  const isTool = Boolean(record.requested || record.completed);
  const isSuccess = record.completed?.result.ok ?? false;
  const isError = Boolean(record.completed && !record.completed.result.ok);
  const label = record.requested?.call.name
    ?? (record.completed ? `工具 ${record.completed.callId.slice(0, 8)}` : record.auxiliary?.type === 'checkpoint.created' ? 'Checkpoint 已创建' : '上下文已压缩');
  const status = record.completed
    ? record.completed.result.ok ? '已完成' : (record.completed.result.error?.message ?? '执行失败')
    : record.auxiliary?.type === 'checkpoint.created' ? '可恢复' : isTool ? '执行中' : '已记录';
  return (
    <div
      className={`activity ${isError ? 'error' : record.auxiliary?.type === 'checkpoint.created' ? 'checkpoint' : 'success'}`}
    >
      <button className="activity-head" data-action="toggle-activity" onClick={onToggle}>
        <div className="activity-icon">
          {record.auxiliary?.type === 'checkpoint.created' ? (
            <RotateCcw size={14} />
          ) : isSuccess ? (
            <Check size={14} />
          ) : isError ? (
            <X size={14} />
          ) : (
            <Zap size={14} />
          )}
        </div>
        <div className="activity-title">
          <strong>{label}</strong>
          <span>{status}</span>
        </div>
        <span className="activity-time">{timeLabel(record.completed?.timestamp ?? record.requested?.timestamp ?? event.timestamp)}</span>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {expanded && (
        <div className="activity-detail">
          <pre>{displayDetail}</pre>
          {checkpoint && (
            <button
              className="small-button"
              data-action="restore-checkpoint"
              onClick={() => onRestoreCheckpoint(checkpoint.checkpoint.id)}
              disabled={!checkpoint.checkpoint.id}
            >
              恢复到此 Checkpoint
            </button>
          )}
        </div>
      )}
    </div>
  );
}
function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: Approval;
  onResolve: (decision: 'allow' | 'deny') => void;
}): React.JSX.Element {
  return (
    <div className="approval-card">
      <div className="approval-top">
        <div className="approval-icon">
          <ShieldCheck size={16} />
        </div>
        <div>
          <strong>需要你的确认</strong>
          <span>
            {approval.call.name} · {approval.reason}
          </span>
        </div>
        <span className={`risk ${approval.risk}`}>
          {approval.risk === 'high' ? '高风险' : approval.risk === 'medium' ? '中风险' : '低风险'}
        </span>
      </div>
      <div className="approval-code">
        <code>
          {approval.call.name}({JSON.stringify(approval.call.args)})
        </code>
      </div>
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
  attachments,
  onAttach,
  onModeSelect,
  onPlan,
  onSend,
  onCancel,
  onSettings,
}: {
  value: string;
  setValue: (value: string) => void;
  running: boolean;
  mode: ExecutionMode;
  model: string;
  attachments: AttachmentRef[];
  onAttach: () => void;
  onModeSelect: (mode: ExecutionMode) => void;
  onPlan: () => void;
  onSend: () => void;
  onCancel: () => void;
  onSettings: () => void;
}): React.JSX.Element {
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
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
        {attachments.length > 0 && (
          <div className="attachment-row">
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
              onClick={() => setModeMenuOpen((value) => !value)}
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
              data-action="plan-toggle"
              className={`composer-tool ${mode === 'plan' ? 'selected' : ''}`}
              onClick={onPlan}
            >
              <ListChecks size={14} />
              计划
            </button>
            <button data-action="model-settings" className="composer-tool" onClick={onSettings}>
              {model}
              <ChevronDown size={12} />
            </button>
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
                    };
                  }
                ).SpeechRecognition;
                if (!Speech) window.alert('当前 Electron 环境未提供语音识别，请直接输入文字。');
                else {
                  const recognition = new Speech();
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
}): React.JSX.Element {
  if (type === 'files')
    return (
      <div className="inspector-body">
        <div className="panel-title">
          工作区文件<span className="panel-sub">{files.length} 个条目</span>
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
          变更预览<span className="panel-sub">{changes.length} 个 ChangeSet</span>
          <button
            className="small-button"
            data-action="refresh-git"
            onClick={() => void onGitRefresh()}
          >
            刷新 Git
          </button>
        </div>
        <div className="git-status">{gitText || '等待 git status…'}</div>
        <div className="page-toolbar git-actions">
          <button className="small-button" data-action="stage-all" onClick={async () => { await window.seecoder.git.stage(); onToast('已暂存全部工作区改动'); await onGitRefresh(); }}>Stage All</button>
          <button className="small-button" data-action="commit" onClick={async () => { const message = window.prompt('Commit message', 'chore: update from SeeCoder'); if (message) { const result = await window.seecoder.git.commit(message); onToast(String(resultOutput(result) ?? 'Commit 已执行')); await onGitRefresh(); } }}>Commit</button>
          <button className="small-button" data-action="push" onClick={async () => { if (window.confirm('确认推送当前分支？')) { const result = await window.seecoder.git.push(); onToast(String(resultOutput(result) ?? 'Push 已执行')); } }}>Push</button>
        </div>
        {changes.length === 0 ? (
          <div className="empty-panel">
            <div className="empty-icon">
              <GitBranch size={18} />
            </div>
            <strong>还没有 ChangeSet</strong>
            <span>Agent 修改文件后，Diff 会出现在这里。</span>
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
                  <DiffEditor
                    height="180px"
                    language={languageFor(file.path)}
                    theme="vs-dark"
                    original={file.before ?? ''}
                    modified={file.after ?? ''}
                    options={{
                      readOnly: true,
                      minimap: { enabled: false },
                      renderSideBySide: false,
                      lineNumbers: 'on',
                      padding: { top: 8, bottom: 8 },
                      scrollbar: { vertical: 'auto' },
                    }}
                  />
                </div>
              ))}
            </div>
          ))
        )}
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
    return result.slice(-80);
  }, [events]);

  function label(row: { event: AgentEvent; count?: number }): string {
    const event = row.event;
    if (event.type === 'message.delta') return `流式消息 ×${row.count ?? 1}`;
    if (event.type === 'model.completed') return `模型完成 · 第 ${event.iteration} 轮 · ${event.durationMs}ms · 重试 ${event.retries}`;
    if (event.type === 'model.requested') return `模型请求 · 第 ${event.iteration} 轮`;
    if (event.type === 'tool.requested') return `调用工具 · ${event.call.name}`;
    if (event.type === 'tool.completed') return `工具完成 · ${event.callId.slice(0, 8)} · ${event.result.ok ? '成功' : '失败'}`;
    if (event.type === 'usage.updated') return `Token · ${event.inputTokens} 输入 / ${event.outputTokens} 输出`;
    if (event.type === 'turn.completed') return '任务完成';
    if (event.type === 'turn.failed') return `任务失败 · ${event.error.code}`;
    if (event.type === 'subagent.updated') return `子 Agent · ${event.child.role} · ${event.child.status}`;
    return event.type;
  }

  return (
    <div className="inspector-body">
      <div className="panel-title">
        执行轨迹
        <span className="panel-sub">{events.length} 个原始事件 · {rows.length} 条记录</span>
      </div>
      <div className="trace-list">
        {rows.map((row) => (
          <div className="trace-row" key={row.id}>
            <span className={`trace-dot ${row.event.type.includes('failed') ? 'danger' : row.event.type.includes('completed') ? 'success' : ''}`} />
            <span className="truncate">{label(row)}</span>
            <time>{timeLabel(row.event.timestamp)}</time>
          </div>
        ))}
        {children.map((child) => (
          <div className="trace-child" key={child.id}>
            <Users size={13} />
            <span>{child.role} · {child.status}</span>
          </div>
        ))}
        {!rows.length && <div className="empty-panel"><strong>暂无轨迹</strong><span>启动任务后会显示模型、工具和验证节点。</span></div>}
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
    fit.fit();
    terminal.write([...lines, ...localLines].join(''));
    return () => terminal.dispose();
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
  threads,
  gitText,
  onRefreshGit,
  onNew,
  onOpenThread,
  onToast,
  onModelChange,
}: {
  page: string;
  workspace: string;
  threads: Thread[];
  gitText: string;
  onRefreshGit: () => Promise<void>;
  onNew: () => void;
  onOpenThread: (thread: Thread) => Promise<void>;
  onToast: (value: string) => void;
  onModelChange: (value: string) => void;
}): React.JSX.Element {
  void onRefreshGit;
  const [schedules, setSchedules] = useState<ScheduleDefinition[]>([]);
  const [extensions, setExtensions] = useState<
    Array<{ name: string; description: string; path: string; kind: string }>
  >([]);
  const [url, setUrl] = useState('http://localhost:3000');
  const [settings, setSettings] = useState<{
    model: string;
    baseUrl: string;
    contextWindow: number;
    maxOutputTokens: number;
    hasApiKey: boolean;
    logPath?: string;
  }>();
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
          {threads.map((thread) => (
            <button className="history-card" data-action="open-history-thread" key={thread.id} onClick={() => void onOpenThread(thread)}>
              <MessageSquare size={16} />
              <div>
                <strong>{thread.title}</strong>
                <span>{thread.workspacePath}</span>
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
            <button
              className="small-button"
              data-action="rescan-extensions"
              onClick={() => void window.seecoder.extension.list().then(setExtensions)}
            >
              重新扫描
            </button>
          </div>
          {extensions.map((item) => (
            <div className="extension-row" key={`${item.kind}-${item.path}`}>
              <Sparkles size={15} />
              <div>
                <strong>{item.name}</strong>
                <span>{item.description}</span>
              </div>
              <code>{item.kind}</code>
            </div>
          ))}
          {!extensions.length && (
            <div className="empty-panel">
              <strong>未发现本地扩展</strong>
              <span>在 .seecoder/skills 或 .agents/skills 放置 SKILL.md 即可加载。</span>
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
        onSave={async (next) => {
          const value = await window.seecoder.settings.update(next);
          setSettings(value);
          onModelChange(value.model);
          onToast(value.hasApiKey ? '设置已保存，API Key 已加密持久化' : '设置已保存');
        }}
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
          <strong>{threads.length}</strong>
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
  onSave,
}: {
  settings:
    | {
        model: string;
        baseUrl: string;
        contextWindow: number;
        maxOutputTokens: number;
        hasApiKey: boolean;
        keyStorage?: 'environment' | 'os' | 'none';
        logPath?: string;
      }
    | undefined;
  onSave: (next: {
    model?: string;
    baseUrl?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    apiKey?: string;
    clearApiKey?: boolean;
  }) => Promise<void>;
}): React.JSX.Element {
  const [model, setModel] = useState(settings?.model ?? 'gpt-4o-mini');
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? '');
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  useEffect(() => {
    if (settings) {
      setModel(settings.model);
      setBaseUrl(settings.baseUrl);
    }
  }, [settings]);
  async function save(): Promise<void> {
    setSaving(true);
    setSaveError(undefined);
    try {
      await onSave({ model, baseUrl, ...(key ? { apiKey: key } : {}) });
      setKey('');
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '保存失败，请检查配置');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="workspace-page">
      <PageHeader icon={Settings2} title="设置" subtitle="模型、权限和本地数据" />
      <div className="settings-card">
        <label>
          模型
          <input value={model} onChange={(event) => setModel(event.target.value)} />
        </label>
        <label>
          OpenAI 兼容 Base URL
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
        </label>
        <label>
          API Key（加密持久保存）
          <div className="input-with-icon">
            <KeyRound size={15} />
            <input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={settings?.hasApiKey ? '已保存，留空保持不变' : '输入 API Key'}
            />
          </div>
        </label>
        <button
          data-action="save-settings"
          className="primary-button"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '保存设置'}
        </button>
        {settings?.hasApiKey && (
          <button
            data-action="clear-api-key"
            className="small-button"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              setSaveError(undefined);
              void onSave({ clearApiKey: true })
                .then(() => setKey(''))
                .catch((error) => setSaveError(error instanceof Error ? error.message : '清除失败，请重试'))
                .finally(() => setSaving(false));
            }}
          >
            清除已保存 API Key
          </button>
        )}
        {saveError && <div className="settings-error">{saveError}</div>}
        {settings?.logPath && (
          <div className="settings-note">
            <strong>后台日志</strong>
            <code title={settings.logPath}>{settings.logPath}</code>
            <span>API Key 使用操作系统安全存储加密，日志仅记录事件类型、耗时和错误码，不记录 Key 或完整文件内容。</span>
          </div>
        )}
      </div>
    </div>
  );
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
