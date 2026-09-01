import React, { useState } from 'react';
import { Bell, Check, ChevronDown, Code2, FolderOpen, History, MessageSquare, MoreHorizontal, Pin, Plus, Search, Settings2, ShieldCheck, Sparkles } from 'lucide-react';
import type { Session } from '@seecoder/protocol';

export function Sidebar({
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
    page: 'task' | 'history' | 'pulls' | 'scheduled' | 'plugins' | 'settings' | 'about',
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
