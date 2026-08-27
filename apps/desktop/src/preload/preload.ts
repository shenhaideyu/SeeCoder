import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent, PermissionMode } from '@seecoder/protocol';

const api = {
  workspace: { select: () => ipcRenderer.invoke('workspace:select') },
  thread: {
    create: (title?: string) => ipcRenderer.invoke('thread:create', title),
    list: () => ipcRenderer.invoke('thread:list'),
    hydrate: (threadId: string) => ipcRenderer.invoke('thread:hydrate', threadId),
    history: (threadId: string) => ipcRenderer.invoke('thread:history', threadId),
  },
  turn: {
    start: (threadId: string, text: string) => ipcRenderer.invoke('turn:start', threadId, text),
    cancel: (turnId: string) => ipcRenderer.invoke('turn:cancel', turnId),
  },
  approval: { resolve: (approvalId: string, decision: 'allow' | 'deny', reason?: string) => ipcRenderer.invoke('approval:resolve', approvalId, decision, reason) },
  changes: { revert: (changeSetId: string) => ipcRenderer.invoke('changes:revert', changeSetId) },
  settings: {
    read: () => ipcRenderer.invoke('settings:read'),
    update: (next: { mode?: PermissionMode; model?: string; baseUrl?: string }) => ipcRenderer.invoke('settings:update', next),
  },
  events: { subscribe: (listener: (event: AgentEvent) => void) => { const handler = (_event: Electron.IpcRendererEvent, value: AgentEvent) => listener(value); ipcRenderer.on('seecoder:event', handler); return () => { ipcRenderer.removeListener('seecoder:event', handler); }; } },
};

contextBridge.exposeInMainWorld('seecoder', api);

export type SeeCoderApi = typeof api;
