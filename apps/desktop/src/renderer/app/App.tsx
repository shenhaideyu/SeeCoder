import React, { useEffect, useRef, useState } from 'react';
import { Check, GitBranch, PanelRightClose } from 'lucide-react';
import type {
  AgentEvent,
  Approval,
  AttachmentRef,
  ExecutionMode,
  LocalSkill,
  ModelProfile,
  Session,
  SessionEvent,
} from '@seecoder/protocol';
import type { SeeCoderApi } from '../../preload/preload';
import { TaskPage } from '../components/task-page';
import { Composer } from '../components/composer';
import { Sidebar } from '../components/sidebar';
import { InspectorContent } from '../components/inspector';
import { WorkspacePage } from '../pages/workspace-page';
import { PromptDialog, type PromptRequest } from './prompt-dialog';
import { formatCommandOutput, resultOutput } from './presentation';
import { changesForTurn, useStore, type InputRequest } from './ui-store';


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
    rewind: async () => previewSession,
    switchBranch: async () => previewSession,
    search: async () => [previewSession],
    export: async () => ({ cancelled: true }),
  },
  turn: {
    start: async () => 'preview-turn',
    steer: async () => undefined,
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
    prStatus: async () => ({ status: 'ready', pullRequests: [] }),
  },
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


export function App(): React.JSX.Element {
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
    'task' | 'history' | 'pulls' | 'scheduled' | 'plugins' | 'settings' | 'about'
  >('task');
  const [composer, setComposer] = useState('');
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [activeSkill, setActiveSkill] = useState<LocalSkill>();
  const [search, setSearch] = useState('');
  // 右侧检查器默认收起，只有用户主动打开或点击“已编辑文件”时才展开。
  const [collapsed, setCollapsed] = useState(true);
  // 指定后右侧面板只显示该 Turn 的 ChangeSet；undefined 表示显示当前 Session 全部变更。
  const [inspectorTurnId, setInspectorTurnId] = useState<string>();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [gitText, setGitText] = useState('');
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
  // 切换 Session 时恢复默认收起状态，防止上一个任务的变更面板继续占用空间。
  useEffect(() => {
    setCollapsed(true);
    setInspectorTurnId(undefined);
  }, [selectedSession?.id]);
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
    // 历史接口返回带 seq 的持久化记录，旧 Turn 的分支按钮需要这个准确位置。
    const history = (await window.seecoder.session.history(session.id)) as SessionEvent[];
    if (token !== loadToken.current || useStore.getState().selectedSession?.id !== session.id) return;
    // 实时 store 仍保存统一的 AgentEvent，同时把历史 seq 附在 TimelineItem 上。
    history.forEach((record) => addEvent(record.event, record.seq));
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
      events: [], approvals: [], inputRequests: [], plans: [], changes: [], children: [], reviewFindings: [], streamingText: '', running: false, phase: 'idle', currentTurnId: undefined,
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
        await window.seecoder.turn.steer(currentTurnId, text);
        set({ toast: '已加入当前任务的动态调整' });
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
  async function forkSession(turnId?: string, eventSeq?: number): Promise<void> {
    const source = useStore.getState().selectedSession;
    if (!source) return;
    if (useStore.getState().running) {
      set({ toast: '任务运行中不能 Fork，请等待完成或先停止任务' });
      return;
    }
    // 历史加载时已有 seq；实时 Turn 尚未重载历史时，需要在点击瞬间查找它的持久化终态位置。
    let targetSeq = eventSeq;
    if (turnId && targetSeq === undefined) {
      // session.history 返回带 seq 的记录，找到这个 Turn 的 completed/failed/cancelled 终态。
      const history = (await window.seecoder.session.history(source.id)) as SessionEvent[];
      const terminal = history.find((record) => {
        const event = record.event;
        return (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled')
          && event.turn.id === turnId;
      });
      // 找到真实位置后从该位置分叉；找不到时不猜测，避免错误地从 Session 最新头分叉。
      if (terminal?.seq === undefined) {
        set({ toast: '分支失败：尚未找到这个 Turn 的持久化结束位置' });
        return;
      }
      targetSeq = terminal.seq;
    }
    // 顶部菜单不传 turnId 时仍从当前 Session 最新位置创建分支。
    const forked = (await window.seecoder.session.fork(source.id, targetSeq)) as Session | null;
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
  async function restoreCheckpoint(id: string): Promise<void> {
    // 回退会恢复文件并从会话与模型上下文删除整个 Turn，必须先让用户明确确认。
    const confirmed = await requestPrompt({
      title: '确认回退本轮操作？',
      description: '确认后将恢复本轮修改前的文件，并从当前对话和后续模型上下文中删除这一整轮内容。',
      confirm: true,
      cancelLabel: '否',
      submitLabel: '是，回退',
    });
    // 关闭弹窗或选择“否”时不调用后端，不改变任何文件与会话状态。
    if (confirmed !== '__confirm__') return;
    // 保存点击时的 Session；异步恢复期间用户可能切换任务。
    const targetSession = useStore.getState().selectedSession;
    // 没有选中 Session 时不存在可安全重载的上下文。
    if (!targetSession) return;
    // 后端以文件恢复、撤销事件和派生状态重建组成完整操作。
    const result = await window.seecoder.checkpoint.restore(id);
    // ToolResult.ok 是唯一成功判断，不能用 output 是否为空代替。
    const succeeded = (result as { ok?: boolean }).ok === true;
    // 成功后从过滤后的持久化历史重载，确保右侧 ChangeSet 和对话同时消失。
    if (succeeded && useStore.getState().selectedSession?.id === targetSession.id) await loadSession(targetSession);
    // Git 区显示整个工作区状态，也需要在文件恢复后刷新。
    await loadGit();
    // 给出简短结果；冲突等具体错误仍保留在后端 ToolResult 和日志中。
    set({ toast: succeeded ? '本轮操作已回退并从对话中删除' : '回退失败：文件可能已被再次修改' });
  }
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
  // 从 Turn 底部的文件按钮打开右侧面板，并把内容限制到该 Turn 的 ChangeSet。
  function showTurnChanges(turnId: string): void {
    setInspectorTurnId(turnId);
    setCollapsed(false);
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
      setCollapsed(false);
      if (selectedSession) {
        set({ running: true, phase: 'preparing' });
        const turnId = (await window.seecoder.turn.start(selectedSession.id, '请调用 review_changes 审查当前工作区变更，并按严重度输出发现。')) as string;
        set({ currentTurnId: turnId });
      } else set({ toast: '请先选择任务' });
    } else if (command === '/diff') {
      // /diff 与手动打开变更页签语义相同：展示当前 Session 全部变更。
      setInspectorTurnId(undefined);
      setCollapsed(false);
    }
    else if (command === '/status') {
      await loadGit();
      setCollapsed(false);
    } else if (command === '/skills') setPage('plugins');
    else if (command === '/compact') {
      setPage('task');
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
            onCopy={copyText}
            onFork={forkSession}
            onShowTurnChanges={showTurnChanges}
            onMenu={showSessionMenu}
            onBranch={showBranches}
            onRestoreCheckpoint={restoreCheckpoint}
            onRetry={retryLastTask}
            onToggleInspector={() => {
              // 顶部按钮重新打开检查器时展示全部变更，不沿用某个历史 Turn 的过滤条件。
              if (collapsed) setInspectorTurnId(undefined);
              setCollapsed((current) => !current);
            }}
            onPromptSelect={(prompt) => {
              setComposer(prompt);
              window.requestAnimationFrame(() => {
                document.querySelector<HTMLTextAreaElement>('[data-action="composer"]')?.focus();
              });
            }}
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
            <div className="inspector-title" data-action="inspector-changes">
              <GitBranch size={14} />
              <span>变更</span>
              {changes.length > 0 && <b>{changes.length}</b>}
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
            // 从 Turn 文件按钮进入时只显示该轮修改；普通打开检查器时显示全部修改。
            changes={changesForTurn(changes, inspectorTurnId)}
            gitText={gitText}
            onRevert={(id) => void window.seecoder.changes.revert(id)}
            onStage={stageFile}
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
