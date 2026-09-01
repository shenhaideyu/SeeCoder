import React from 'react';
import { Code2, GitBranch, RotateCcw } from 'lucide-react';
import type { ChangeSet } from '@seecoder/protocol';
import { ChangeDiffViewer } from '../diff-viewer';
import type { PromptRequest } from '../app/prompt-dialog';
import { resultOutput, timeLabel } from '../app/presentation';

export function InspectorContent({
  changes,
  gitText,
  onRevert,
  onStage,
  onGitRefresh,
  onToast,
  onPrompt,
  onConfirm,
}: {
  changes: ChangeSet[];
  gitText: string;
  onRevert: (id: string) => void;
  onStage: (path: string) => void;
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
