import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent, AttachmentRef, ExecutionMode, ModelProfileInput, PullRequestStatus, ScheduleDefinition } from '@seecoder/protocol';

const api = {
  workspace: {
    select: () => ipcRenderer.invoke('workspace:select'),
    list: () => ipcRenderer.invoke('workspace:list'),
    switch: (workspace: string) => ipcRenderer.invoke('workspace:switch', workspace),
    open: () => ipcRenderer.invoke('workspace:open'),
  },
  session: {
    create: (title?: string) => ipcRenderer.invoke('session:create', title), list: () => ipcRenderer.invoke('session:list'), hydrate: (sessionId: string) => ipcRenderer.invoke('session:hydrate', sessionId), history: (sessionId: string) => ipcRenderer.invoke('session:history', sessionId),
    rename: (sessionId: string, title: string) => ipcRenderer.invoke('session:rename', sessionId, title), flag: (sessionId: string, flag: 'pinned' | 'archived') => ipcRenderer.invoke('session:flag', sessionId, flag), delete: (sessionId: string) => ipcRenderer.invoke('session:delete', sessionId), fork: (sessionId: string) => ipcRenderer.invoke('session:fork', sessionId), search: (query: string) => ipcRenderer.invoke('session:search', query), export: (sessionId: string, format: 'markdown' | 'json') => ipcRenderer.invoke('session:export', sessionId, format),
  },
  turn: { start: (sessionId: string, text: string, attachments?: AttachmentRef[], skillId?: string) => ipcRenderer.invoke('turn:start', sessionId, text, attachments, skillId), followUp: (turnId: string, text: string) => ipcRenderer.invoke('turn:followUp', turnId, text), cancel: (turnId: string) => ipcRenderer.invoke('turn:cancel', turnId) },
  approval: { resolve: (approvalId: string, decision: 'allow' | 'deny', reason?: string) => ipcRenderer.invoke('approval:resolve', approvalId, decision, reason) },
  input: { resolve: (requestId: string, answer: string) => ipcRenderer.invoke('input:resolve', requestId, answer) },
  plan: { approve: () => ipcRenderer.invoke('plan:approve') },
  changes: { revert: (changeSetId: string) => ipcRenderer.invoke('changes:revert', changeSetId) },
  checkpoint: { list: (sessionId?: string) => ipcRenderer.invoke('checkpoint:list', sessionId), restore: (checkpointId: string) => ipcRenderer.invoke('checkpoint:restore', checkpointId) },
  files: { list: (path?: string, depth?: number) => ipcRenderer.invoke('files:list', path, depth), read: (path: string, startLine?: number, endLine?: number) => ipcRenderer.invoke('files:read', path, startLine, endLine), search: (query: string, path?: string) => ipcRenderer.invoke('files:search', query, path) },
  attachment: { select: (): Promise<AttachmentRef[]> => ipcRenderer.invoke('attachment:select') },
  git: {
    status: () => ipcRenderer.invoke('git:status'), diff: (scope?: 'unstaged' | 'staged' | 'branch' | 'last-turn') => ipcRenderer.invoke('git:diff', scope), branches: () => ipcRenderer.invoke('git:branches'), checkout: (branch: string) => ipcRenderer.invoke('git:checkout', branch),
    stage: (path?: string) => ipcRenderer.invoke('git:stage', path), unstage: (path?: string) => ipcRenderer.invoke('git:unstage', path), revert: (path: string) => ipcRenderer.invoke('git:revert', path), commit: (message: string) => ipcRenderer.invoke('git:commit', message), push: () => ipcRenderer.invoke('git:push'), prStatus: (): Promise<PullRequestStatus> => ipcRenderer.invoke('git:prStatus'),
  },
  terminal: { run: (command: string, cwd?: string) => ipcRenderer.invoke('terminal:run', command, cwd) },
  preview: { open: (url: string) => ipcRenderer.invoke('preview:open', url) },
  extension: {
    list: () => ipcRenderer.invoke('extension:list'),
    import: () => ipcRenderer.invoke('extension:import'),
    refresh: (skillId: string) => ipcRenderer.invoke('extension:refresh', skillId),
    rename: (skillId: string, name: string) => ipcRenderer.invoke('extension:rename', skillId, name),
    delete: (skillId: string) => ipcRenderer.invoke('extension:delete', skillId),
    openSource: (skillId: string) => ipcRenderer.invoke('extension:openSource', skillId),
    trustHooks: (enabled: boolean) => ipcRenderer.invoke('extension:trustHooks', enabled),
  },
  schedule: { list: (): Promise<ScheduleDefinition[]> => ipcRenderer.invoke('schedule:list'), save: (value: ScheduleDefinition) => ipcRenderer.invoke('schedule:save', value), toggle: (id: string, enabled: boolean) => ipcRenderer.invoke('schedule:toggle', id, enabled), run: (id: string) => ipcRenderer.invoke('schedule:run', id) },
  settings: {
    read: () => ipcRenderer.invoke('settings:read'),
    update: (next: { mode?: ExecutionMode; model?: string; activeModelProfileId?: string; upsertModel?: ModelProfileInput; toggleModel?: { id: string; enabled: boolean }; deleteModelId?: string; contextWindow?: number; maxOutputTokens?: number }) => ipcRenderer.invoke('settings:update', next),
  },
  events: { subscribe: (listener: (event: AgentEvent) => void) => { const handler = (_event: Electron.IpcRendererEvent, value: AgentEvent) => listener(value); ipcRenderer.on('seecoder:event', handler); return () => { ipcRenderer.removeListener('seecoder:event', handler); }; } },
  menu: { subscribe: (listener: (action: string) => void) => { const handler = (_event: Electron.IpcRendererEvent, value: string) => listener(value); ipcRenderer.on('seecoder:menu', handler); return () => { ipcRenderer.removeListener('seecoder:menu', handler); }; } },
};

contextBridge.exposeInMainWorld('seecoder', api);
export type SeeCoderApi = typeof api;
