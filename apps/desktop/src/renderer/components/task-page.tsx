import React, { useEffect, useMemo, useRef } from 'react';
import { AlertTriangle, Blocks, Bot, ChevronDown, CodeXml, FolderOpen, GitBranch, MoreHorizontal, PanelRight, RefreshCw, ScanSearch, ShieldCheck, Square, Users, Workflow, Wrench } from 'lucide-react';
import type { Approval, ExecutionMode, PlanStep, SubagentState, Session } from '@seecoder/protocol';
import { latestTurnTerminal } from '../turn-view';
import { friendlyAgentError } from '../app/presentation';
import type { ActivityRecord, ConversationRecord, InputRequest, RunPhase, TimelineItem } from '../app/ui-store';
import { ActivityCard, ActivityGroupCard, ApprovalCard, InputCard, MessageCard, PlanCard, TurnActionsCard } from './conversation-cards';

// 把扁平事件流整理成对话记录，并在每个 Turn 的终态位置追加唯一操作区。
export function buildConversationRecords(events: TimelineItem[]): ConversationRecord[] {
  // records 先保持原始事件顺序，后面只合并相邻探索工具。
  const records: ConversationRecord[] = [];
  // activityByCallId 把 tool.requested 与对应 tool.completed 合成一张工具卡片。
  const activityByCallId = new Map<string, ActivityRecord>();
  // finalTextByTurn 始终保存该 Turn 最近一条助手正文，供底部复制按钮使用。
  const finalTextByTurn = new Map<string, string>();
  // editedFilesByTurn 按 Turn 去重保存 ChangeSet 涉及的文件路径。
  const editedFilesByTurn = new Map<string, Set<string>>();
  // checkpointByTurn 预先扫描整条事件流，使终态前到达的恢复点可以挂到开头的用户消息。
  const checkpointByTurn = new Map<string, string>();
  // restoredCheckpointIds 防止已经回退成功的历史仍显示一个再次点击必然冲突的按钮。
  const restoredCheckpointIds = new Set<string>();
  // 同一 Turn 的新版历史只有一个恢复点；旧版历史可能有多个，这里使用最后一条兼容记录。
  events.forEach(({ event }) => {
    // 只收集创建事件，恢复完成事件不再提供可重复回退入口。
    if (event.type === 'checkpoint.created') checkpointByTurn.set(event.turnId, event.checkpoint.id);
    // 保存已经成功恢复的 Checkpoint id。
    if (event.type === 'checkpoint.restored') restoredCheckpointIds.add(event.checkpointId);
  });
  // 删除已恢复入口；复制用户消息仍然保留。
  for (const [turnId, checkpointId] of checkpointByTurn) if (restoredCheckpointIds.has(checkpointId)) checkpointByTurn.delete(turnId);
  // 按持久化或实时到达顺序处理全部事件。
  events.forEach(({ id, seq, event }) => {
    // 用户消息和助手正文仍按原位置进入时间线。
    if (event.type === 'message.user' || event.type === 'message.completed') {
      records.push({
        id,
        kind: 'message',
        message: event,
        // 恢复是整轮语义，所以只把 checkpointId 交给发起该 Turn 的用户消息。
        ...(event.type === 'message.user' && checkpointByTurn.has(event.turnId)
          ? { checkpointId: checkpointByTurn.get(event.turnId)! }
          : {}),
      });
      // 中间迭代也可能产生正文；终态到达前最后一条就是本 Turn 的可复制结果。
      if (event.type === 'message.completed') finalTextByTurn.set(event.turnId, event.text);
    // 工具请求先创建或复用以 callId 为键的活动记录。
    } else if (event.type === 'tool.requested') {
      const activity = activityByCallId.get(event.call.id) ?? { id: `tool-${event.call.id}` };
      activity.requested = event;
      activityByCallId.set(event.call.id, activity);
      if (!records.some((record) => record.kind === 'activity' && record.activity === activity)) {
        records.push({ id: activity.id, kind: 'activity', activity });
      }
    // 工具完成事件补齐同一活动记录。
    } else if (event.type === 'tool.completed') {
      const activity = activityByCallId.get(event.callId) ?? { id: `tool-${event.callId}` };
      activity.completed = event;
      activityByCallId.set(event.callId, activity);
      if (!records.some((record) => record.kind === 'activity' && record.activity === activity)) {
        records.push({ id: activity.id, kind: 'activity', activity });
      }
    // 上下文压缩仍作为活动卡展示；恢复点已经合并到用户消息，不再产生独立白条。
    } else if (event.type === 'context.compacted') {
      const activity: ActivityRecord = { id, auxiliary: event };
      records.push({ id, kind: 'activity', activity });
    // ChangeSet 不单独插入消息流，只归入所属 Turn 底部的“已编辑文件”。
    } else if (event.type === 'changes.created') {
      const files = editedFilesByTurn.get(event.changeSet.turnId) ?? new Set<string>();
      event.changeSet.files.forEach((file) => files.add(file.path));
      editedFilesByTurn.set(event.changeSet.turnId, files);
    // 终态事件为每个 Turn 创建且只创建一个统一操作区。
    } else if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled') {
      const turnId = event.turn.id;
      records.push({
        id: `turn-actions-${turnId}`,
        kind: 'turn-actions',
        turnId,
        // 历史 seq 让分支准确停在本 Turn 终点；实时事件暂时没有 seq 时退回 Session 头。
        ...(seq === undefined ? {} : { eventSeq: seq }),
        finalText: finalTextByTurn.get(turnId) ?? '',
        editedFiles: [...(editedFilesByTurn.get(turnId) ?? [])],
      });
    }
  });
  // grouped 是最终交给 React 渲染的记录数组。
  const grouped: ConversationRecord[] = [];
  // exploration 暂存连续出现的只读探索工具。
  let exploration: ActivityRecord[] = [];
  // flushExploration 把一条探索显示为普通卡，多条显示为折叠组。
  const flushExploration = () => {
    if (exploration.length === 1) grouped.push({ id: exploration[0]!.id, kind: 'activity', activity: exploration[0]! });
    else if (exploration.length > 1) grouped.push({ id: `group-${exploration[0]!.id}`, kind: 'activity-group', activities: exploration });
    exploration = [];
  };
  // 非探索记录会结束当前工具组，Turn 操作区因此自然位于所有本轮内容之后。
  for (const record of records) {
    const name = record.kind === 'activity' ? record.activity.requested?.call.name : undefined;
    const canGroup = record.kind === 'activity'
      && Boolean(record.activity.completed)
      && ['list_files', 'read_file', 'read_files', 'search_text', 'git_diff'].includes(name ?? '');
    if (canGroup) exploration.push(record.activity);
    else { flushExploration(); grouped.push(record); }
  }
  // 处理事件流结尾仍未遇到其他记录的探索工具。
  flushExploration();
  // 返回保持 Turn 顺序的最终视图模型。
  return grouped;
}

export function TaskPage({
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
  onCopy,
  onFork,
  onShowTurnChanges,
  onMenu,
  onBranch,
  onRestoreCheckpoint,
  onRetry,
  onToggleInspector,
  onPromptSelect,
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
  onCopy: (text: string) => void;
  onFork: (turnId: string, eventSeq?: number) => void;
  onShowTurnChanges: (turnId: string) => void;
  onMenu: () => void;
  onBranch: () => void;
  onRestoreCheckpoint: (id: string) => void;
  onRetry: () => void;
  onToggleInspector: () => void;
  onPromptSelect: (prompt: string) => void;
}): React.JSX.Element {
  // 事件发生变化时重建轻量视图模型，中间消息不再各自生成操作按钮。
  const conversationRecords = useMemo(() => buildConversationRecords(events), [events]);
  const latestTurnResult = useMemo(() => {
    const terminal = latestTurnTerminal(events.map(({ event }) => event));
    return terminal ? { id: `terminal-${terminal.turn.id}`, event: terminal } : undefined;
  }, [events]);
  const hasConversation = conversationRecords.length > 0 || streamingText.length > 0 || plans.length > 0;
  const projectName = selectedSession?.workspacePath
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() ?? 'SeeCoder';
  const promptSuggestions = [
    {
      label: '探索并理解代码',
      description: '了解结构、入口和核心流程',
      prompt: '请分析当前项目结构，说明核心模块、运行入口和主要数据流。',
      icon: Workflow,
      tone: 'explore',
    },
    {
      label: '构建新功能',
      description: '在现有项目中实现需求',
      prompt: '请先了解当前项目，然后帮我实现一个新功能。请先询问我具体需求。',
      icon: Blocks,
      tone: 'build',
    },
    {
      label: '审查代码',
      description: '发现问题并提出修改建议',
      prompt: '请审查当前项目代码，找出重要问题并给出可执行的修改建议。',
      icon: ScanSearch,
      tone: 'review',
    },
    {
      label: '修复问题',
      description: '定位错误、修复并验证结果',
      prompt: '请帮助我定位并修复当前项目中的问题。请先询问我错误现象和复现方式。',
      icon: Wrench,
      tone: 'fix',
    },
  ] as const;
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
          <button
            data-action="toggle-inspector"
            className="icon-button"
            title="切换检查器"
            onClick={onToggleInspector}
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
            <CodeXml size={24} />
          </div>
          <div className="welcome-copy">
            <h1>你想在 <strong title={selectedSession?.workspacePath}>{projectName}</strong> 中做什么？</h1>
            <p>选择一个常用任务，或直接在下方描述你的目标。</p>
          </div>
          <div className="prompt-suggestions" aria-label="常用任务">
            {promptSuggestions.map(({ label, description, prompt, icon: Icon, tone }) => (
              <button
                key={label}
                type="button"
                className={`prompt-suggestion ${tone}`}
                data-action={`suggest-${tone}`}
                onClick={() => onPromptSelect(prompt)}
              >
                <Icon size={18} />
                <span><strong>{label}</strong><small>{description}</small></span>
              </button>
            ))}
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
          {conversationRecords.map((record) => {
            // 用户消息显示复制与整轮回退；助手消息只展示正文。
            if (record.kind === 'message') return (
              <MessageCard
                key={record.id}
                message={record.message}
                {...(record.checkpointId ? { checkpointId: record.checkpointId } : {})}
                onCopy={onCopy}
                onRestoreCheckpoint={onRestoreCheckpoint}
              />
            );
            // TurnActionsCard 负责复制、准确分支，以及打开本轮对应的右侧变更面板。
            if (record.kind === 'turn-actions') return (
              <TurnActionsCard
                key={record.id}
                record={record}
                forkDisabled={running}
                onCopy={onCopy}
                onFork={() => onFork(record.turnId, record.eventSeq)}
                onShowChanges={() => onShowTurnChanges(record.turnId)}
              />
            );
            // 多个连续探索工具使用折叠组。
            if (record.kind === 'activity-group') return (
              <ActivityGroupCard
                key={record.id}
                records={record.activities}
                expanded={Boolean(expanded[record.id])}
                onToggle={() => setExpanded((value) => ({ ...value, [record.id]: !value[record.id] }))}
              />
            );
            // 其余单个工具和上下文压缩使用普通活动卡。
            return (
              <ActivityCard
                key={record.id}
                record={record.activity}
                expanded={Boolean(expanded[record.id])}
                onToggle={() => setExpanded((value) => ({ ...value, [record.id]: !value[record.id] }))}
              />
            );
          })}
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
          </div>
        )}
      </section>
    </>
  );
}
