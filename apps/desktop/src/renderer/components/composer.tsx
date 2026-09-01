import React, { useState } from 'react';
import { Check, ChevronDown, Command, FilePlus2, ImagePlus, Plus, Send, Settings2, ShieldCheck, Sparkles, Square, X, Zap } from 'lucide-react';
import type { AttachmentRef, ExecutionMode, LocalSkill, ModelProfile } from '@seecoder/protocol';

export function Composer({
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
