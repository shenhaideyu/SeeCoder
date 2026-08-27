import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent, AttachmentRef, ExecutionMode, ScheduleDefinition } from '@seecoder/protocol';

const api = {
  workspace: { select: () => ipcRenderer.invoke('workspace:select'), open: () => ipcRenderer.invoke('workspace:open') },
  thread: {
    create: (title?: string) => ipcRenderer.invoke('thread:create', title), list: () => ipcRenderer.invoke('thread:list'), hydrate: (threadId: string) => ipcRenderer.invoke('thread:hydrate', threadId), history: (threadId: string) => ipcRenderer.invoke('thread:history', threadId),
    rename: (threadId: string, title: string) => ipcRenderer.invoke('thread:rename', threadId, title), flag: (threadId: string, flag: 'pinned' | 'archived') => ipcRenderer.invoke('thread:flag', threadId, flag), fork: (threadId: string) => ipcRenderer.invoke('thread:fork', threadId), search: (query: string) => ipcRenderer.invoke('thread:search', query), export: (threadId: string, format: 'markdown' | 'json') => ipcRenderer.invoke('thread:export', threadId, format),
  },
  turn: { start: (threadId: string, text: string, attachments?: AttachmentRef[]) => ipcRenderer.invoke('turn:start', threadId, text, attachments), followUp: (turnId: string, text: string) => ipcRenderer.invoke('turn:followUp', turnId, text), cancel: (turnId: string) => ipcRenderer.invoke('turn:cancel', turnId) },
  approval: { resolve: (approvalId: string, decision: 'allow' | 'deny', reason?: string) => ipcRenderer.invoke('approval:resolve', approvalId, decision, reason) },
  input: { resolve: (requestId: string, answer: string) => ipcRenderer.invoke('input:resolve', requestId, answer) },
  plan: { approve: () => ipcRenderer.invoke('plan:approve') },
  changes: { revert: (changeSetId: string) => ipcRenderer.invoke('changes:revert', changeSetId) },
  checkpoint: { list: (threadId?: string) => ipcRenderer.invoke('checkpoint:list', threadId), restore: (checkpointId: string) => ipcRenderer.invoke('checkpoint:restore', checkpointId) },
  files: { list: (path?: string, depth?: number) => ipcRenderer.invoke('files:list', path, depth), read: (path: string, startLine?: number, endLine?: number) => ipcRenderer.invoke('files:read', path, startLine, endLine), search: (query: string, path?: string) => ipcRenderer.invoke('files:search', query, path) },
  attachment: { select: (): Promise<AttachmentRef[]> => ipcRenderer.invoke('attachment:select') },
  git: {
    status: () => ipcRenderer.invoke('git:status'), diff: (scope?: 'unstaged' | 'staged' | 'branch' | 'last-turn') => ipcRenderer.invoke('git:diff', scope), branches: () => ipcRenderer.invoke('git:branches'), checkout: (branch: string) => ipcRenderer.invoke('git:checkout', branch),
    stage: (path?: string) => ipcRenderer.invoke('git:stage', path), unstage: (path?: string) => ipcRenderer.invoke('git:unstage', path), revert: (path: string) => ipcRenderer.invoke('git:revert', path), commit: (message: string) => ipcRenderer.invoke('git:commit', message), push: () => ipcRenderer.invoke('git:push'), prStatus: () => ipcRenderer.invoke('git:prStatus'),
  },
  terminal: { run: (command: string, cwd?: string) => ipcRenderer.invoke('terminal:run', command, cwd) },
  preview: { open: (url: string) => ipcRenderer.invoke('preview:open', url) },
  extension: { list: () => ipcRenderer.invoke('extension:list') },
  schedule: { list: (): Promise<ScheduleDefinition[]> => ipcRenderer.invoke('schedule:list'), save: (value: ScheduleDefinition) => ipcRenderer.invoke('schedule:save', value), toggle: (id: string, enabled: boolean) => ipcRenderer.invoke('schedule:toggle', id, enabled), run: (id: string) => ipcRenderer.invoke('schedule:run', id) },
  settings: {
    read: () => ipcRenderer.invoke('settings:read'),
    update: (next: { mode?: ExecutionMode; model?: string; baseUrl?: string; contextWindow?: number; maxOutputTokens?: number; apiKey?: string; clearApiKey?: boolean }) => ipcRenderer.invoke('settings:update', next),
  },
  events: { subscribe: (listener: (event: AgentEvent) => void) => { const handler = (_event: Electron.IpcRendererEvent, value: AgentEvent) => listener(value); ipcRenderer.on('seecoder:event', handler); return () => { ipcRenderer.removeListener('seecoder:event', handler); }; } },
  menu: { subscribe: (listener: (action: string) => void) => { const handler = (_event: Electron.IpcRendererEvent, value: string) => listener(value); ipcRenderer.on('seecoder:menu', handler); return () => { ipcRenderer.removeListener('seecoder:menu', handler); }; } },
};

contextBridge.exposeInMainWorld('seecoder', api);
export type SeeCoderApi = typeof api;
