import React, { useState } from 'react';
import { Bot, Check, ChevronDown, ChevronRight, CircleDot, Copy, FileText, GitFork, ListChecks, Loader2, MessageSquare, Play, RotateCcw, ShieldCheck, X, Zap } from 'lucide-react';
import type { AgentEvent, Approval, ExecutionMode, PlanStep } from '@seecoder/protocol';
import { PatchDiffPreview } from '../diff-viewer';
import { formatToolActivity } from '../tool-activity';
import { MarkdownMessage } from '../app/markdown';
import { isToolControlSignal, timeLabel, toolPresentation } from '../app/presentation';
import type { ActivityRecord, ConversationRecord, InputRequest } from '../app/ui-store';

export function PlanCard({
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

export function MessageCard({
  message,
  checkpointId,
  onCopy,
  onRestoreCheckpoint,
}: {
  message: Extract<AgentEvent, { type: 'message.completed' | 'message.user' }>;
  checkpointId?: string;
  onCopy: (text: string) => void;
  onRestoreCheckpoint: (id: string) => void;
}): React.JSX.Element {
  // 只有用户消息代表一个 Turn 的起点，因此复制和整轮回退按钮只显示在用户侧。
  const isUser = message.type === 'message.user';
  return (
    <div className={`message ${isUser ? 'user' : 'assistant'}`}>
      <div className="message-avatar">
        {isUser ? <span>你</span> : <Bot size={15} />}
      </div>
      <div className="message-body">
        <div className="message-meta">
          <span>{isUser ? '你' : 'SeeCoder'}</span>
          <span>{timeLabel(message.timestamp)}</span>
        </div>
        <div className="message-text"><MarkdownMessage text={message.text} /></div>
        {isUser && (
          <div className="message-actions user-turn-actions" aria-label="本轮操作">
            <button data-action="copy-user-message" title="复制这条消息" aria-label="复制这条消息" onClick={() => onCopy(message.text)}>
              <Copy size={14} />
            </button>
            {checkpointId && (
              <button
                data-action="restore-turn"
                title="回退到本轮对话发起前"
                aria-label="回退到本轮对话发起前"
                onClick={() => onRestoreCheckpoint(checkpointId)}
              >
                <RotateCcw size={14} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// TurnActionsCard 只出现在一个 Turn 的终态之后，避免每次模型迭代都出现重复操作按钮。
export function TurnActionsCard({
  record,
  forkDisabled,
  onCopy,
  onFork,
  onShowChanges,
}: {
  record: Extract<ConversationRecord, { kind: 'turn-actions' }>;
  forkDisabled: boolean;
  onCopy: (text: string) => void;
  onFork: () => void;
  onShowChanges: () => void;
}): React.JSX.Element {
  // 没有最终正文时禁用复制，但仍允许查看文件或从 Turn 终点创建分支。
  const copyDisabled = !record.finalText.trim();
  // 文件数量用于右侧变更面板入口的按钮标题。
  const fileCount = record.editedFiles.length;
  return (
    <div className="turn-actions" data-turn-id={record.turnId}>
      <div className="turn-action-row">
        <button data-action="copy-turn" title="复制本 Turn 的最终答案" disabled={copyDisabled} onClick={() => onCopy(record.finalText)}>
          <Copy size={13} />
          <span>复制</span>
        </button>
        <button data-action="fork-turn" title={forkDisabled ? '任务运行中不能创建分支' : '从这个 Turn 结束位置创建分支'} disabled={forkDisabled} onClick={onFork}>
          <GitFork size={13} />
          <span>分支</span>
        </button>
      </div>
      {fileCount > 0 && (
        <button className="turn-change-summary" data-action="show-turn-files" title="在右侧变更面板查看本 Turn 的修改" onClick={onShowChanges}>
          <span className="turn-change-icon"><FileText size={17} /></span>
          <strong>已编辑 {fileCount} 个文件</strong>
          <ChevronRight size={16} />
        </button>
      )}
    </div>
  );
}

export function ActivityCard({
  record,
  expanded,
  onToggle,
}: {
  record: ActivityRecord;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const event = record.completed ?? record.requested ?? record.auxiliary;
  if (!event) return <></>;
  const isSuccess = record.completed?.result.ok ?? false;
  const isControlled = isToolControlSignal(record.completed?.result);
  const isError = Boolean(record.completed && !record.completed.result.ok && !isControlled);
  const toolName = record.requested?.call.name;
  // finish 和 checkpoint 都是内部控制动作；对应结果已由 Turn 终态和用户消息回退按钮表达。
  if (toolName === 'finish' || toolName === 'checkpoint') return <></>;
  const compactedMetrics = record.auxiliary?.type === 'context.compacted' ? record.auxiliary.metrics : undefined;
  const view = formatToolActivity({
    name: toolName ?? (record.auxiliary?.type === 'context.compacted' && !compactedMetrics ? 'compact_context' : undefined),
    args: record.requested?.call.args,
    result: record.completed?.result,
    contextMetrics: compactedMetrics,
  });
  const status = isControlled ? '探索已按预算停止，将使用现有证据继续' : view.summary;
  const canExpand = view.details.length > 0;
  return (
    <div className={`activity ${isError ? 'error' : 'success'}`}>
      <button className="activity-head" data-action="toggle-activity" aria-expanded={expanded} onClick={onToggle}>
        <div className="activity-icon">
          {isSuccess ? (
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
        </div>
      )}
    </div>
  );
}

export function ActivityGroupCard({ records, expanded, onToggle }: { records: ActivityRecord[]; expanded: boolean; onToggle: () => void }): React.JSX.Element {
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

export function ApprovalCard({
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
export function InputCard({
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
