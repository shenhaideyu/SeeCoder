import { dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentCore } from '@seecoder/agent-core';
import { SessionStore } from '@seecoder/storage';
import { WorkspacePolicy } from '@seecoder/tools';
import type { ToolRegistry } from '@seecoder/tools';
import type { AttachmentRef, ExecutionMode, LocalSkill, Session } from '@seecoder/protocol';
import type { MainLogger } from '../services/main-logger';
import type { WorkspaceService } from '../services/workspace-service';
import { psQuote, textArg } from '../services/workspace-service';

interface WorkspaceIpcOptions {
  getWindow: () => BrowserWindow | null;
  getCore: () => AgentCore;
  getWorkspace: () => string;
  getMode: () => ExecutionMode;
  setMode: (mode: ExecutionMode) => void;
  getRecentWorkspaces: () => string[];
  selectWorkspace: () => Promise<string | null>;
  switchWorkspace: (workspace: string) => Promise<string>;
  sameWorkspace: (left: string, right: string) => boolean;
  storeRoot: () => string;
  logger: MainLogger;
  toolRegistry: ToolRegistry;
  workspaceService: WorkspaceService;
  loadSkill: (skillId: string) => Promise<{ skill: LocalSkill; content: string }>;
}

export function registerWorkspaceIpc(options: WorkspaceIpcOptions): void {
  const { selectWorkspace, switchWorkspace, sameWorkspace, storeRoot, logger, toolRegistry, workspaceService, loadSkill, setMode } = options;
  const state = {
    get mainWindow() { return options.getWindow(); },
    get core() { return options.getCore(); },
    get workspace() { return options.getWorkspace(); },
    get mode() { return options.getMode(); },
    get recentWorkspaces() { return options.getRecentWorkspaces(); },
  };

  ipcMain.handle('workspace:select', async () => {
    const selected = await selectWorkspace();
    if (!selected) return { cancelled: true };
    return { cancelled: false, workspace: await switchWorkspace(selected) };
  });
  ipcMain.handle('workspace:list', async () => ({
    current: state.workspace,
    recent: [state.workspace, ...state.recentWorkspaces].filter((item, index, list) => existsSync(item) && list.findIndex((value) => sameWorkspace(value, item)) === index),
  }));
  ipcMain.handle('workspace:switch', async (_event, nextWorkspace: string) => ({
    workspace: await switchWorkspace(nextWorkspace),
  }));
  ipcMain.handle('workspace:open', async () => {
    await shell.openPath(state.workspace);
    return state.workspace;
  });
  ipcMain.handle('session:create', async (_event, title?: string) => state.core.createSession(typeof title === 'string' && title.length <= 120 ? title : undefined));
  ipcMain.handle('session:list', async () =>
    (await state.core.listSessions()).map((session) => ({
      ...session,
      pinned: session.pinned ?? false,
      archived: session.archived ?? false,
      unread: session.unread ?? false,
    })),
  );
  ipcMain.handle('session:hydrate', async (_event, sessionId: string) => state.core.hydrateSession(textArg(sessionId, 'sessionId', 100)));
  // Renderer 需要事件 seq 才能从某个历史 Turn 的终点创建准确分支。
  ipcMain.handle('session:history', async (_event, sessionId: string) => state.core.readSessionEventRecords(textArg(sessionId, 'sessionId', 100)));
  ipcMain.handle('session:rename', async (_event, sessionId: string, title: string) => {
    const session = await state.core.hydrateSession(textArg(sessionId, 'sessionId', 100));
    if (!session) throw new Error('session 不存在');
    session.title = textArg(title, 'title', 120);
    session.updatedAt = new Date().toISOString();
    await new SessionStore(storeRoot()).saveSession(session);
    return session;
  });
  ipcMain.handle('session:flag', async (_event, sessionId: string, flag: 'pinned' | 'archived') => {
    const session = await state.core.hydrateSession(textArg(sessionId, 'sessionId', 100));
    if (!session) throw new Error('session 不存在');
    session[flag] = !session[flag];
    session.updatedAt = new Date().toISOString();
    await new SessionStore(storeRoot()).saveSession(session);
    return session;
  });
  ipcMain.handle('session:delete', async (_event, sessionId: string) => {
    const id = textArg(sessionId, 'sessionId', 100);
    await state.core.deleteSession(id);
    logger.write('INFO', 'session.deleted', { sessionId: id });
    return { deleted: true, sessionId: id };
  });
  ipcMain.handle('session:fork', async (_event, sessionId: string, eventSeq?: number) =>
    state.core.forkFrom(textArg(sessionId, 'sessionId', 100), eventSeq),
  );
  ipcMain.handle('session:rewind', async (_event, sessionId: string, eventSeq: number) =>
    state.core.rewindSession(textArg(sessionId, 'sessionId', 100), eventSeq),
  );
  ipcMain.handle('session:switchBranch', async (_event, sessionId: string) =>
    state.core.switchBranch(textArg(sessionId, 'sessionId', 100)),
  );
  ipcMain.handle('session:search', async (_event, query: string) => {
    const q = textArg(query, 'query', 200).toLowerCase();
    const all = await state.core.listSessions();
    const result: Session[] = [];
    for (const session of all) {
      if (session.title.toLowerCase().includes(q)) {
        result.push(session);
        continue;
      }
      // 使用 Core 的可见历史，turn.reverted 已删除的内容不能再次被搜索命中。
      const events = await state.core.readSessionEvents(session.id);
      // 标题未命中时再检查仍可见的事件正文。
      if (events.some((event) => JSON.stringify(event).toLowerCase().includes(q))) result.push(session);
    }
    return result;
  });
  ipcMain.handle('session:export', async (_event, sessionId: string, format: 'markdown' | 'json') => {
    const id = textArg(sessionId, 'sessionId', 100);
    const events = await state.core.readSessionEvents(id);
    const body = format === 'json' ? JSON.stringify(events, null, 2) : events.map((event) => `${event.type}\n${JSON.stringify(event, null, 2)}`).join('\n\n');
    const target = await dialog.showSaveDialog(state.mainWindow!, {
      defaultPath: `seecoder-${id.slice(0, 8)}.${format === 'json' ? 'json' : 'md'}`,
    });
    if (target.canceled || !target.filePath) return { cancelled: true };
    await writeFile(target.filePath, body, 'utf8');
    return { cancelled: false, path: target.filePath };
  });
  ipcMain.handle('turn:start', async (_event, sessionId: string, text: string, attachments?: AttachmentRef[], skillId?: string) => state.core.startTurn(textArg(sessionId, 'sessionId', 100), textArg(text, 'text'), undefined, Array.isArray(attachments) ? attachments.slice(0, 4) : [], typeof skillId === 'string' ? await loadSkill(skillId) : undefined));
  ipcMain.handle('turn:followUp', async (_event, turnId: string, text: string) => {
    await state.core.queueFollowUp(textArg(turnId, 'turnId', 100), textArg(text, 'text'));
  });
  ipcMain.handle('turn:steer', async (_event, turnId: string, text: string) => {
    await state.core.steerTurn(textArg(turnId, 'turnId', 100), textArg(text, 'text'));
  });
  ipcMain.handle('turn:cancel', async (_event, turnId: string) => state.core.cancelTurn(textArg(turnId, 'turnId', 100)));
  ipcMain.handle('approval:resolve', async (_event, approvalId: string, decision: 'allow' | 'deny', reason?: string) => state.core.resolveApproval(textArg(approvalId, 'approvalId', 100), decision === 'allow' ? 'allow' : 'deny', typeof reason === 'string' ? reason.slice(0, 500) : undefined));
  ipcMain.handle('input:resolve', async (_event, requestId: string, answer: string) => state.core.resolveUserInput(textArg(requestId, 'requestId', 100), textArg(answer, 'answer', 10_000)));
  ipcMain.handle('plan:approve', async () => {
    setMode('guided');
    state.core.setMode('guided');
    return 'guided';
  });
  ipcMain.handle('changes:revert', async (_event, changeSetId: string) => state.core.revertChangeSet(textArg(changeSetId, 'changeSetId', 100)));
  ipcMain.handle('checkpoint:list', async (_event, sessionId?: string) => state.core.listCheckpoints(typeof sessionId === 'string' ? sessionId : undefined));
  ipcMain.handle('checkpoint:restore', async (_event, checkpointId: string) => state.core.restoreCheckpoint(textArg(checkpointId, 'checkpointId', 100)));
  ipcMain.handle('files:list', async (_event, path?: string, depth?: number) => toolRegistry.get('list_files')?.execute({ path, depth }, { workspace: state.workspace }));
  ipcMain.handle('files:read', async (_event, path: string, startLine?: number, endLine?: number) => toolRegistry.get('read_file')?.execute({ path: textArg(path, 'path', 1000), startLine, endLine }, { workspace: state.workspace }));
  ipcMain.handle('files:search', async (_event, query: string, path?: string) => toolRegistry.get('search_text')?.execute({ query: textArg(query, 'query', 500), path }, { workspace: state.workspace }));
  ipcMain.handle('attachment:select', async () => {
    const result = await dialog.showOpenDialog(state.mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '文本与图片',
          extensions: ['txt', 'md', 'json', 'ts', 'tsx', 'js', 'jsx', 'css', 'html', 'png', 'jpg', 'jpeg'],
        },
      ],
    });
    if (result.canceled) return [];
    const policy = new WorkspacePolicy(state.workspace);
    const values: AttachmentRef[] = [];
    for (const path of result.filePaths.slice(0, 4)) {
      const stat = await (await import('node:fs/promises')).stat(path);
      if (stat.size > 5 * 1024 * 1024 || !policy.isInside(path)) continue;
      const mimeType = /\.(png|jpe?g)$/i.test(path) ? 'image/' + (path.toLowerCase().endsWith('.png') ? 'png' : 'jpeg') : 'text/plain';
      values.push({
        id: randomUUID(),
        kind: mimeType.startsWith('image/') ? 'image' : 'text',
        name: path.split(/[\\/]/).pop() ?? path,
        path,
        mimeType,
        size: stat.size,
      });
    }
    return values;
  });
  ipcMain.handle('git:status', async () => workspaceService.runGit('git status --short --branch'));
  ipcMain.handle('git:diff', async (_event, scope: 'unstaged' | 'staged' | 'branch' | 'last-turn' = 'unstaged') => workspaceService.runGit(scope === 'staged' ? 'git diff --cached' : 'git diff'));
  ipcMain.handle('git:branches', async () => workspaceService.runGit('git branch --format="%(refname:short)"'));
  ipcMain.handle('git:checkout', async (_event, branch: string) => {
    const name = textArg(branch, 'branch', 200);
    if (!/^[\w./-]+$/.test(name)) throw new Error('分支名称包含不允许的字符');
    return workspaceService.runGit(`git switch ${psQuote(name)}`, 60_000);
  });
  ipcMain.handle('git:stage', async (_event, path?: string) => workspaceService.runGit(path ? `git add -- ${psQuote(relative(state.workspace, await new WorkspacePolicy(state.workspace).path(path)))}` : 'git add -A'));
  ipcMain.handle('git:unstage', async (_event, path?: string) => workspaceService.runGit(path ? `git restore --staged -- ${psQuote(relative(state.workspace, await new WorkspacePolicy(state.workspace).path(path)))}` : 'git restore --staged .'));
  ipcMain.handle('git:revert', async (_event, path: string) => workspaceService.runGit(`git restore -- ${psQuote(relative(state.workspace, await new WorkspacePolicy(state.workspace).path(textArg(path, 'path', 1000))))}`));
  ipcMain.handle('git:commit', async (_event, message: string) => workspaceService.runGit(`git commit -m ${psQuote(textArg(message, 'message', 2000))}`, 60_000));
  ipcMain.handle('git:push', async () => workspaceService.runGit('git push', 120_000));
  ipcMain.handle('git:prStatus', async () => workspaceService.readPullRequestStatus());
}
