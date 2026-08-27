import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { Activity, AlertTriangle, Bot, Check, ChevronDown, ChevronRight, CircleDot, Code2, Command, FolderOpen, GitBranch, History, ListChecks, Loader2, MessageSquare, PanelRight, Plus, RotateCcw, Search, Send, Settings2, ShieldCheck, Sparkles, Square, Terminal, Users, X, Zap } from 'lucide-react';
import type { AgentEvent, Approval, ChangeSet, PlanStep, SubagentState, Thread } from '@seecoder/protocol';
import type { SeeCoderApi } from '../preload/preload';
import './styles.css';

const previewThread: Thread = { id: 'preview-thread', title: '界面预览任务', workspacePath: 'Preview', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const previewApi: SeeCoderApi = {
  workspace: { select: async () => ({ cancelled: true }) },
  thread: { create: async (title?: string) => ({ ...previewThread, id: `preview-${Date.now()}`, title: title ?? previewThread.title }), list: async () => [previewThread], hydrate: async () => previewThread, history: async () => [] },
  turn: { start: async () => 'preview-turn', cancel: async () => undefined },
  approval: { resolve: async () => undefined },
  changes: { revert: async () => ({ ok: true }) },
  settings: { read: async () => ({ workspace: 'Preview / Browser', mode: 'guided' as const, model: 'preview', baseUrl: '', hasApiKey: false }), update: async () => ({ workspace: 'Preview / Browser', mode: 'guided' as const, model: 'preview', baseUrl: '', hasApiKey: false }) },
  events: { subscribe: () => () => undefined },
};
const runtimeWindow = window as Window & { seecoder?: SeeCoderApi };
if (!runtimeWindow.seecoder) runtimeWindow.seecoder = previewApi;

interface TimelineItem { id: string; type: string; event: AgentEvent; }
interface StoreState {
  threads: Thread[];
  selectedThread?: Thread;
  events: TimelineItem[];
  streamingText: string;
  approvals: Approval[];
  plans: PlanStep[];
  changes: ChangeSet[];
  children: SubagentState[];
  terminal: string[];
  running: boolean;
  set: (patch: Partial<StoreState>) => void;
  addEvent: (event: AgentEvent) => void;
}

const useStore = create<StoreState>((set) => ({
  threads: [], events: [], streamingText: '', approvals: [], plans: [], changes: [], children: [], terminal: [], running: false,
  set: (patch) => set(patch),
  addEvent: (event) => set((state) => {
    const next: TimelineItem = { id: `${Date.now()}-${Math.random()}`, type: event.type, event };
    const events = [...state.events, next].slice(-500);
    if (event.type === 'message.delta') return { events, streamingText: `${state.streamingText}${event.text}`, running: true };
    if (event.type === 'message.completed') return { events, streamingText: '', running: true };
    if (event.type === 'approval.requested') return { events, approvals: [...state.approvals, event.approval], running: true };
    if (event.type === 'approval.resolved') return { events, approvals: state.approvals.filter((item) => item.id !== event.approvalId) };
    if (event.type === 'plan.updated') return { events, plans: event.steps };
    if (event.type === 'changes.created') return { events, changes: [...state.changes, event.changeSet] };
    if (event.type === 'changes.reverted') return { events, changes: state.changes.filter((item) => item.id !== event.changeSetId) };
    if (event.type === 'subagent.updated') return { events, children: [...state.children.filter((item) => item.id !== event.child.id), event.child] };
    if (event.type === 'tool.output') return { events, terminal: [...state.terminal, `[${event.stream}] ${event.text}`].slice(-500) };
    if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled') return { events, running: false, streamingText: '' };
    return { events };
  }),
}));

const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

function App(): React.JSX.Element {
  const { threads, selectedThread, events, streamingText, approvals, plans, changes, children, terminal, running, set, addEvent } = useStore();
  const [workspace, setWorkspace] = useState('未选择工作区');
  const [mode, setMode] = useState<'guided' | 'auto'>('guided');
  const [composer, setComposer] = useState('');
  const [inspector, setInspector] = useState<'changes' | 'files' | 'terminal' | 'trace'>('changes');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.seecoder.events.subscribe(addEvent);
    void (async () => {
      const settings = await window.seecoder.settings.read();
      if (disposed) return;
      setWorkspace(settings.workspace); setMode(settings.mode);
      const loaded = await window.seecoder.thread.list();
      const list = loaded as Thread[];
      const first = list.at(0);
      if (first) { set({ threads: list, selectedThread: first }); await window.seecoder.thread.hydrate(first.id); const history = await window.seecoder.thread.history(first.id) as AgentEvent[]; history.forEach(addEvent); }
      else { const created = await window.seecoder.thread.create('首个 SeeCoder 任务') as Thread; set({ threads: [created], selectedThread: created }); }
    })();
    return () => { disposed = true; unsubscribe(); };
  }, [addEvent, set]);

  const currentMessages = useMemo(() => events.filter((item) => item.type === 'message.completed' || item.type === 'message.user').map((item) => item.event).filter((item): item is Extract<AgentEvent, { type: 'message.completed' | 'message.user' }> => item.type === 'message.completed' || item.type === 'message.user'), [events]);

  const selectThread = async (thread: Thread) => {
    set({ selectedThread: thread, events: [], changes: [], children: [], terminal: [], approvals: [], plans: [], streamingText: '' });
    await window.seecoder.thread.hydrate(thread.id);
    const history = await window.seecoder.thread.history(thread.id) as AgentEvent[];
    history.forEach(addEvent);
  };

  const selectWorkspace = async () => {
    const selected = await window.seecoder.workspace.select() as { cancelled: boolean; workspace?: string };
    if (!selected.cancelled && selected.workspace) { setWorkspace(selected.workspace); const created = await window.seecoder.thread.create('新工作区任务') as Thread; set({ threads: [created, ...threads], selectedThread: created, events: [], changes: [], children: [], terminal: [] }); }
  };

  const send = async () => {
    const text = composer.trim(); if (!text || !selectedThread || running) return;
    setComposer(''); set({ running: true, streamingText: '' }); await window.seecoder.turn.start(selectedThread.id, text);
  };

  const newThread = async () => { const created = await window.seecoder.thread.create('新的 SeeCoder 任务') as Thread; set({ threads: [created, ...threads], selectedThread: created, events: [], approvals: [], plans: [], changes: [], children: [], terminal: [], streamingText: '' }); };

  const resolve = async (approval: Approval, decision: 'allow' | 'deny') => { await window.seecoder.approval.resolve(approval.id, decision, decision === 'deny' ? '用户在 SeeCoder 中拒绝此动作' : undefined); };
  const revert = async (changeSetId: string) => { await window.seecoder.changes.revert(changeSetId); };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Code2 size={18} /></div><div><div className="brand-name">SeeCoder</div><div className="brand-tag">coding intelligence</div></div></div>
      <button className="workspace-button" onClick={() => void selectWorkspace()}><FolderOpen size={16} /><span className="truncate">{workspace.split(/[\\/]/).pop()}</span><ChevronDown size={14} /></button>
      <button className="new-task" onClick={() => void newThread()}><Plus size={16} />新建任务<span className="shortcut">Ctrl N</span></button>
      <div className="section-label"><span>最近任务</span><span className="count">{threads.length}</span></div>
      <div className="thread-list">{threads.map((thread) => <button key={thread.id} className={`thread ${selectedThread?.id === thread.id ? 'selected' : ''}`} onClick={() => void selectThread(thread)}><MessageSquare size={15} /><span className="truncate">{thread.title}</span><span className="thread-dot" /></button>)}</div>
      <div className="sidebar-bottom"><button className="sidebar-link"><History size={15} />执行历史</button><button className="sidebar-link"><Settings2 size={15} />设置</button><div className="profile"><div className="avatar">S</div><div><div className="profile-name">本地工作区</div><div className="profile-sub">安全模式已启用</div></div><ShieldCheck size={15} className="shield" /></div></div>
    </aside>
    <main className="main-column">
      <header className="topbar"><div className="crumb"><span className="online-dot" />{selectedThread?.title ?? 'SeeCoder'}</div><div className="top-actions"><button className="ghost-button"><GitBranch size={14} />main</button><button className="mode-button" onClick={() => { const next = mode === 'guided' ? 'auto' : 'guided'; setMode(next); void window.seecoder.settings.update({ mode: next }); }}><span className={`mode-indicator ${mode}`} />{mode === 'guided' ? 'Guided' : 'Auto'}<ChevronDown size={13} /></button><button className="icon-button"><Command size={16} /></button></div></header>
      <section className="conversation">
        <div className="welcome"><div className="welcome-orb"><Sparkles size={23} /></div><div><h1>让代码，自己找到答案。</h1><p>描述一个目标，SeeCoder 会探索、修改并验证你的工作区。</p></div></div>
        {plans.length > 0 && <div className="plan-card"><div className="card-heading"><ListChecks size={15} /><span>执行计划</span><span className="card-meta">{plans.filter((step) => step.status === 'completed').length}/{plans.length}</span></div><div className="plan-steps">{plans.map((step) => <div key={step.id} className={`plan-step ${step.status}`}><span className="step-icon">{step.status === 'completed' ? <Check size={12} /> : step.status === 'running' ? <Loader2 size={12} className="spin" /> : <CircleDot size={10} />}</span><span>{step.label}</span></div>)}</div></div>}
        <div className="message-stack">{currentMessages.map((message) => <div className={`message ${message.type === 'message.user' ? 'user' : 'assistant'}`} key={`${message.turnId}-${message.timestamp}`}><div className="message-avatar">{message.type === 'message.user' ? <span>你</span> : <Bot size={15} />}</div><div className="message-body"><div className="message-meta"><span>{message.type === 'message.user' ? '你' : 'SeeCoder'}</span><span>{timeLabel(message.timestamp)}</span></div><div className="message-text">{message.text}</div></div></div>)}{streamingText && <div className="message assistant"><div className="message-avatar live"><Bot size={15} /></div><div className="message-body"><div className="message-meta"><span>SeeCoder</span><span className="live-label">正在思考</span></div><div className="message-text">{streamingText}<span className="cursor" /></div></div></div>}
          {events.filter((item) => ['tool.requested', 'tool.completed', 'context.compacted'].includes(item.type)).map((item) => <ActivityCard key={item.id} item={item} expanded={Boolean(expanded[item.id])} onToggle={() => setExpanded((value) => ({ ...value, [item.id]: !value[item.id] }))} />)}
          {approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onResolve={(decision) => void resolve(approval, decision)} />)}
        </div>
        {children.length > 0 && <div className="subagent-strip"><div className="card-heading"><Users size={15} /><span>协作 Agent</span><span className="card-meta">{children.filter((child) => child.status === 'completed').length}/{children.length} 已完成</span></div><div className="child-list">{children.map((child) => <div className="child-pill" key={child.id}><span className={`child-status ${child.status}`} /><span>{child.role === 'explore' ? 'Explore' : 'Review'}</span><span className="truncate">{child.task}</span><span className="child-result">{child.status === 'completed' ? '完成' : child.status === 'running' ? '运行中' : child.status}</span></div>)}</div></div>}
        {events.some((item) => item.type === 'turn.completed') && <div className="complete-banner"><div className="complete-icon"><Check size={15} /></div><div><strong>任务完成</strong><span>变更已写入工作区，验证证据可在右侧查看。</span></div><button onClick={() => setInspector('changes')}><PanelRight size={14} />查看结果</button></div>}
      </section>
      <div className="composer-wrap"><div className="composer"><textarea value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); } }} placeholder="描述你想完成的编程任务…" rows={2} /><div className="composer-footer"><div className="composer-hints"><span><Command size={12} />K 命令</span><span>Ctrl ↵ 发送</span></div><button className="send-button" disabled={!composer.trim() || running} onClick={() => void send()}>{running ? <Square size={15} /> : <Send size={15} />}</button></div></div><div className="composer-note"><ShieldCheck size={12} />SeeCoder 会在修改文件和运行命令前请求你的确认</div></div>
    </main>
    <aside className="inspector"><div className="inspector-tabs">{([['changes', 'Changes', <GitBranch size={14} />], ['files', 'Files', <FolderOpen size={14} />], ['terminal', 'Terminal', <Terminal size={14} />], ['trace', 'Trace', <Activity size={14} />] ] as const).map(([key, label, icon]) => <button key={key} className={inspector === key ? 'active' : ''} onClick={() => setInspector(key)}>{icon}<span>{label}</span>{key === 'changes' && changes.length > 0 && <b>{changes.length}</b>}</button>)}</div><InspectorContent type={inspector} changes={changes} terminal={terminal} children={children} workspace={workspace} events={events} onRevert={revert} /></aside>
  </div>;
}

function ActivityCard({ item, expanded, onToggle }: { item: TimelineItem; expanded: boolean; onToggle: () => void }): React.JSX.Element {
  const event = item.event;
  if (event.type === 'context.compacted') return <div className="activity compacted"><div className="activity-icon"><RotateCcw size={14} /></div><div><strong>上下文已压缩</strong><span>保留任务目标与最近行动，继续执行</span></div></div>;
  const requested = event.type === 'tool.requested' ? event.call : undefined;
  const completed = event.type === 'tool.completed' ? event : undefined;
  const name = requested?.name ?? completed?.callId ?? '工具';
  return <div className={`activity ${completed ? (completed.result.ok ? 'success' : 'error') : 'running'}`}><button className="activity-head" onClick={onToggle}><div className="activity-icon">{completed?.result.ok ? <Check size={14} /> : requested ? <Zap size={14} /> : <AlertTriangle size={14} />}</div><div className="activity-title"><strong>{name}</strong><span>{completed ? (completed.result.ok ? '已完成' : completed.result.error?.message ?? '失败') : '正在执行'}</span></div><span className="activity-time">{timeLabel(event.timestamp)}</span>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>{expanded && <div className="activity-detail"><pre>{requested ? JSON.stringify(requested.args, null, 2) : completed ? JSON.stringify(completed.result.output ?? completed.result.error, null, 2) : ''}</pre></div>}</div>;
}

function ApprovalCard({ approval, onResolve }: { approval: Approval; onResolve: (decision: 'allow' | 'deny') => void }): React.JSX.Element { return <div className="approval-card"><div className="approval-top"><div className="approval-icon"><ShieldCheck size={16} /></div><div><strong>需要你的确认</strong><span>{approval.call.name} · {approval.reason}</span></div><span className={`risk ${approval.risk}`}>{approval.risk === 'high' ? '高风险' : approval.risk === 'medium' ? '中风险' : '低风险'}</span></div><div className="approval-code"><code>{approval.call.name}({JSON.stringify(approval.call.args)})</code></div><div className="approval-actions"><button className="deny" onClick={() => onResolve('deny')}><X size={14} />拒绝</button><button className="allow" onClick={() => onResolve('allow')}><Check size={14} />允许一次</button></div></div>; }

function InspectorContent({ type, changes, terminal, children, workspace, events, onRevert }: { type: string; changes: ChangeSet[]; terminal: string[]; children: SubagentState[]; workspace: string; events: TimelineItem[]; onRevert: (changeSetId: string) => void }): React.JSX.Element {
  if (type === 'terminal') return <div className="inspector-body terminal-body"><div className="panel-title"><span>执行输出</span><span className="live-dot">● LIVE</span></div><pre className="terminal-output">{terminal.length ? terminal.join('') : '等待命令执行…'}</pre></div>;
  if (type === 'files') return <div className="inspector-body"><div className="panel-title">工作区上下文</div><div className="workspace-card"><FolderOpen size={18} /><div><strong>{workspace.split(/[\\/]/).pop()}</strong><span className="truncate">{workspace}</span></div></div><div className="file-stat"><span>工具事件</span><strong>{events.filter((item) => item.type.startsWith('tool.')).length}</strong></div><div className="file-stat"><span>变更文件</span><strong>{changes.reduce((sum, item) => sum + item.files.length, 0)}</strong></div><div className="hint-box"><Search size={15} /><span>SeeCoder 会优先搜索相关文件，再逐步加载上下文。</span></div></div>;
  if (type === 'trace') return <div className="inspector-body"><div className="panel-title">执行轨迹<span className="panel-sub">事件流</span></div><div className="trace-list">{events.slice(-30).map((item) => <div className="trace-row" key={item.id}><span className={`trace-dot ${item.type.includes('failed') ? 'danger' : item.type.includes('completed') ? 'success' : ''}`} /><span className="truncate">{item.type}</span><time>{timeLabel(item.event.timestamp)}</time></div>)}{children.map((child) => <div className="trace-child" key={child.id}><Users size={13} /><span>{child.role} · {child.status}</span></div>)}</div></div>;
  return <div className="inspector-body"><div className="panel-title">变更预览<span className="panel-sub">{changes.length} 个 ChangeSet</span></div>{changes.length === 0 ? <div className="empty-panel"><div className="empty-icon"><GitBranch size={18} /></div><strong>还没有变更</strong><span>Agent 修改文件后，Diff 会出现在这里。</span></div> : changes.map((change) => <div className="change-card" key={change.id}><div className="change-heading"><span className="change-dot" />ChangeSet <code>{change.id.slice(0, 8)}</code><span className="change-time">{timeLabel(change.createdAt)}</span><button className="revert-button" title="撤销本轮修改" onClick={() => onRevert(change.id)}><RotateCcw size={12} /></button></div>{change.files.map((file) => <div className="diff-file" key={file.path}><div className="diff-file-name"><Code2 size={13} />{file.path}</div><div className="diff-lines">{(file.after ?? '').split('\n').slice(0, 12).map((line, index) => <div className="diff-line add" key={`${index}-${line}`}><span>+</span>{line || ' '}</div>)}</div></div>)}</div>)}</div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
