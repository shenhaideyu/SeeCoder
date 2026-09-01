import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, ChevronRight, Code2, FolderOpen, GitBranch, History, KeyRound, Loader2, MessageSquare, MoreHorizontal, Play, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, Upload, X } from 'lucide-react';
import type { ExecutionMode, LocalSkill, ModelProfile, ModelProfileInput, PullRequestStatus, ScheduleDefinition, Session } from '@seecoder/protocol';
import type { SeeCoderApi } from '../../preload/preload';
import { PageHeader } from '../components/page-header';
import type { PromptRequest } from '../app/prompt-dialog';

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

export function WorkspacePage({
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
  const [settings, setSettings] = useState<SettingsView>();
  const [pullRequestStatus, setPullRequestStatus] = useState<PullRequestStatus>();
  const [pullRequestsLoading, setPullRequestsLoading] = useState(false);
  const loadPullRequests = async (): Promise<void> => {
    setPullRequestsLoading(true);
    try { setPullRequestStatus(await window.seecoder.git.prStatus()); }
    catch { setPullRequestStatus({ status: 'error', message: '无法读取拉取请求。' }); }
    finally { setPullRequestsLoading(false); }
  };
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
          subtitle="查看当前仓库的开放拉取请求"
        />
        <div className="feature-card pr-card">
          <div className="pr-toolbar">
            <div className="pr-repository"><GitBranch size={18} /><div><strong>{workspace.split(/[\\/]/).pop() || '当前仓库'}</strong><span>开放 Pull Request</span></div></div>
          <button
            className="small-button"
            data-action="check-pr-status"
            disabled={pullRequestsLoading}
            onClick={() => void loadPullRequests()}
          >
            {pullRequestsLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
            {pullRequestStatus ? '刷新' : '检查'}
          </button>
          </div>
          {!pullRequestStatus && !pullRequestsLoading && <div className="pr-empty"><span>尚未检查当前仓库</span></div>}
          {pullRequestsLoading && <div className="pr-empty"><span>正在读取拉取请求…</span></div>}
          {pullRequestStatus?.status === 'setup_required' && (
            <div className="pr-setup" role="status">
              <AlertTriangle size={18} />
              <div><strong>{pullRequestStatus.message}</strong><span>在终端运行 <code>{pullRequestStatus.command}</code>，完成后点击刷新。</span></div>
            </div>
          )}
          {pullRequestStatus?.status === 'error' && <div className="pr-setup error" role="alert"><AlertTriangle size={18} /><div><strong>读取失败</strong><span>{pullRequestStatus.message}</span></div></div>}
          {pullRequestStatus?.status === 'ready' && pullRequestStatus.pullRequests.length === 0 && <div className="pr-empty"><Check size={18} /><span>当前仓库没有开放的拉取请求</span></div>}
          {pullRequestStatus?.status === 'ready' && pullRequestStatus.pullRequests.length > 0 && (
            <div className="pr-list" aria-label="开放拉取请求">
              {pullRequestStatus.pullRequests.map((item) => <div className="pr-row" key={item.number}><span className="pr-number">#{item.number}</span><div><strong>{item.title}</strong><span>{item.headRefName || '远程分支'}{item.isDraft ? ' · 草稿' : ''}</span></div><span className="pr-state">{item.state === 'OPEN' ? '开放' : item.state}</span></div>)}
            </div>
          )}
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
