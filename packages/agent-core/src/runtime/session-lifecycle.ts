/**
 * SessionLifecycle 负责 Session 的创建、删除和事件回放。
 * Session 是一个长期任务容器，Turn 是其中的一次用户请求；应用重启后，
 * 本类会用持久化事件重新构建模型消息、Ledger、Evidence、Memory 和 ChangeSet。
 */
// randomUUID 为 Session、Item 和恢复生成的记录创建唯一标识。
import { randomUUID } from 'node:crypto';
// resolve 规范化 Workspace 路径，避免同一目录因写法不同被误判。
import { resolve } from 'node:path';
// 这些协议类型描述会话事件、持久化 Item、Session 元数据和 Turn。
import type { AgentEvent, Item, Session, SessionEvent, Turn } from '@seecoder/protocol';
// replaySessionEvents 是纯回放器，SessionStore 提供磁盘读写，ReplayDiagnostic 描述历史异常。
import { replaySessionEvents, type ReplayDiagnostic, type SessionStore } from '@seecoder/storage';
// ModelMessage 是回放后可以再次发送给模型的合法消息形状。
import type { ModelMessage } from '@seecoder/protocol';
// 导入 Ledger、Evidence、Memory 以及恢复消息需要的辅助函数。
import {
  // ContextLedger 保存权威任务状态，ContextLedgerStateV2 是磁盘快照格式。
  ContextLedger,
  // 声明 TypeScript 类型别名，只用于编译期约束，不会生成运行时代码。
  type ContextLedgerStateV2,
  // FileEvidenceStore 和 MemoryIndex 是可以从事件重新建立的派生索引。
  FileEvidenceStore,
  // 执行 session-lifecycle.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
  MemoryIndex,
  // 三个函数分别识别验证命令、清理消息协议、生成工具 Observation。
  isValidationCommand,
  // 执行 session-lifecycle.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
  sanitizeModelMessages,
  // 执行 session-lifecycle.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
  serializeObservation,
} from '../context.js'; // 结束上下文模块导入。
// ChangeManager 在回放时恢复 ChangeSet 和 Checkpoint 内存索引。
import type { ChangeManager } from './change-manager.js';
// TokenCalibrator 从 Compaction Snapshot 恢复模型估算倍率。
import type { TokenCalibrator } from './token-calibrator.js';

// now 为 Session 和恢复事件生成统一 ISO 时间。
const now = () => new Date().toISOString();
// itemId 为恢复时新增的 error Item 生成唯一标识。
const itemId = () => randomUUID();
// Windows 路径不区分大小写；统一 key 可避免同一目录被误判为两个工作区。
const workspaceKey = (value: string): string => {
  // 创建 normalized 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
  const normalized = resolve(value);
  // 把计算完成的结果返回给当前方法的调用方。
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
};

// 声明一个对象结构类型，明确调用方必须提供哪些字段。
interface SessionLifecycleOptions {
  // 这些 Map 由 AgentCore 创建，并以引用方式共享给各运行组件。
  /** 当前项目根目录，用于隔离不同项目的 Session。 */
  workspace: string;
  /** Session 元数据、事件和状态快照的磁盘存储。 */
  store: SessionStore;
  /** 内存中的 Session 元数据。 */
  sessions: Map<string, Session>;
  /** 回放后可直接发送给模型的消息。 */
  messages: Map<string, ModelMessage[]>;
  /** 每个 Session 的权威任务账本。 */
  ledgers: Map<string, ContextLedger>;
  /** 每个 Session 的文件证据。 */
  evidence: Map<string, FileEvidenceStore>;
  /** 每个 Session 的可检索历史。 */
  memories: Map<string, MemoryIndex>;
  /** 删除 Session 前检查是否有运行中 Turn。 */
  activeSessionTurns: Map<string, string>;
  /** 回放和清理 ChangeSet/Checkpoint。 */
  changes: ChangeManager;
  // 设置 tokenCalibrator 字段，把这一项数据传给目标对象、事件或函数。
  tokenCalibrator: TokenCalibrator;
  /** 发布创建事件或中断恢复事件。 */
  emit: (event: AgentEvent, item?: Item) => Promise<void>;
  /** 将回放异常交给主进程日志。 */
  onReplayDiagnostic?: (sessionId: string, diagnostic: ReplayDiagnostic) => void;
} // 结束 SessionLifecycle 依赖接口。

// 声明这个模块的核心类，把相关状态和操作集中封装。
export class SessionLifecycle {
  // 构造函数保存 AgentCore 共享 Map、存储和事件入口。
  constructor(private readonly options: SessionLifecycleOptions) {}

  /** 只列出当前 workspace 的 Session，防止跨项目读取历史。 */
  async list(): Promise<Session[]> {
    // 先把当前 workspace 规范化一次，避免 filter 中重复计算。
    const current = workspaceKey(this.options.workspace);
    // store 可能包含多个工作区的历史，只返回路径 key 相同的记录。
    return (await this.options.store.listSessions()).filter((session) => workspaceKey(session.workspacePath) === current);
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 返回包含真实 seq 的历史记录，供 Renderer 定位 Turn 分支点。 */
  async readEventRecords(sessionId: string): Promise<SessionEvent[]> {
    // 优先使用内存 Session；没有时才读取磁盘元数据。
    const session = this.options.sessions.get(sessionId) ?? (await this.options.store.readSession(sessionId));
    // 找不到或属于其他 workspace 时返回空数组，避免跨项目泄漏。
    if (!session || workspaceKey(session.workspacePath) !== workspaceKey(this.options.workspace)) return [];
    // SessionStore 已合并父分支前缀与当前分支增量，并保留每条记录的持久化序号。
    const history = await this.options.store.readEvents(sessionId);
    // 回放器会应用 turn.reverted tombstone，Renderer 不会重新看到已回退 Turn。
    return replaySessionEvents(sessionId, history).records;
  // 结束历史记录读取方法。
  }

  /** 返回只包含 AgentEvent 的兼容视图，供 Core 内部回放、搜索和导出继续使用。 */
  async readEvents(sessionId: string): Promise<AgentEvent[]> {
    // 复用带 seq 的安全读取入口，再去掉 Renderer 此处不需要的持久化包装。
    return (await this.readEventRecords(sessionId)).map((record) => record.event);
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 删除磁盘数据以及所有对应的内存缓存。 */
  async delete(sessionId: string): Promise<void> {
    // 创建 session 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const session = this.options.sessions.get(sessionId) ?? (await this.options.store.readSession(sessionId));
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (!session || workspaceKey(session.workspacePath) !== workspaceKey(this.options.workspace)) throw new Error('session 不存在');
    // 运行中的 Turn 仍可能写入事件，必须先停止才能删除 Session。
    if (this.options.activeSessionTurns.has(sessionId)) throw new Error('运行中的任务不能删除，请先停止任务');
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (await this.options.store.hasChildBranches(sessionId)) throw new Error('该任务仍有子分支，不能删除');
    // 先删除磁盘，再清内存；磁盘失败时内存仍保持可恢复状态。
    await this.options.store.deleteSession(sessionId);
    // 每个 Map 都保存同一 Session 的不同运行态，需要全部删除。
    this.options.sessions.delete(sessionId);
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.options.messages.delete(sessionId);
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.options.ledgers.delete(sessionId);
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.options.evidence.delete(sessionId);
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.options.memories.delete(sessionId);
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.options.changes.removeSession(sessionId);
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 创建空 Session，并为它初始化五类运行时状态。 */
  async create(title = '新的 SeeCoder 任务'): Promise<Session> {
    // 创建和更新时间初始相同。
    const timestamp = now();
    // 创建 session 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const session: Session = {
      id: randomUUID(), // Session 唯一 id
      title, // UI 展示标题
      workspacePath: this.options.workspace, // Session 固定归属的项目
      createdAt: timestamp, // 创建时间
      updatedAt: timestamp, // 初始更新时间
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    };
    // 先装入内存，再持久化并发布事件；后续 Turn 可立即引用这些对象。
    this.options.sessions.set(session.id, session);
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.options.messages.set(session.id, []);
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.options.ledgers.set(session.id, new ContextLedger());
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.options.evidence.set(session.id, new FileEvidenceStore());
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.options.memories.set(session.id, new MemoryIndex());
    // saveSession 成功后再发事件，避免 UI 展示无法持久化的 Session。
    await this.options.store.saveSession(session);
    // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
    await this.options.emit({ type: 'session.created', timestamp, session });
    // 把计算完成的结果返回给当前方法的调用方。
    return session;
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 从可见历史的指定事件位置创建增量分支，不复制父 Session 的 JSONL。 */
  async forkFrom(sessionId: string, eventSeq?: number, kind: 'Fork' | 'Rewind' = 'Fork'): Promise<Session> {
    // 创建 source 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const source = await this.hydrate(sessionId);
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (!source) throw new Error('session 不存在');
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (this.options.activeSessionTurns.has(sessionId)) throw new Error('运行中的任务不能创建分支');
    // 创建 history 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const history = await this.options.store.readEvents(sessionId);
    // 创建 head 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const head = history.reduce((max, record) => Math.max(max, record.seq ?? 0), 0);
    // 创建 target 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const target = eventSeq ?? head;
    // 创建 floor 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const floor = await this.options.store.getCompactionFloor(sessionId);
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (!Number.isInteger(target) || target < floor || target > head) {
      // 抛出明确错误并终止当前路径，由上层统一转换或处理。
      throw new Error(`事件位置必须在压缩下界 ${floor} 与分支头 ${head} 之间`);
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // 创建 timestamp 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const timestamp = now();
    // 创建 branch 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const branch: Session = {
      // 设置 id 字段，把这一项数据传给目标对象、事件或函数。
      id: randomUUID(),
      // 设置 title 字段，把这一项数据传给目标对象、事件或函数。
      title: `${source.title}（${kind}）`,
      // 设置 workspacePath 字段，把这一项数据传给目标对象、事件或函数。
      workspacePath: source.workspacePath,
      // 设置 createdAt 字段，把这一项数据传给目标对象、事件或函数。
      createdAt: timestamp,
      // 设置 updatedAt 字段，把这一项数据传给目标对象、事件或函数。
      updatedAt: timestamp,
      // 设置 lineage 字段，把这一项数据传给目标对象、事件或函数。
      lineage: {
        // 设置 rootSessionId 字段，把这一项数据传给目标对象、事件或函数。
        rootSessionId: source.lineage?.rootSessionId ?? source.id,
        // 设置 parentSessionId 字段，把这一项数据传给目标对象、事件或函数。
        parentSessionId: source.id,
        // 设置 forkedFromSeq 字段，把这一项数据传给目标对象、事件或函数。
        forkedFromSeq: target,
        // 设置 compactionFloor 字段，把这一项数据传给目标对象、事件或函数。
        compactionFloor: floor,
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      },
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    };
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.options.sessions.set(branch.id, branch);
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.options.store.initializeSequence(branch.id, target);
    // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
    await this.options.store.saveSession(branch);
    // 创建 branchLedger 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const branchLedger = this.rebuildLedger(history.filter((record) => (record.seq ?? 0) <= target));
    // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
    await this.options.store.writeState(branch.id, branchLedger.snapshot());
    // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
    await this.options.emit({ type: 'session.created', timestamp, session: branch });
    // emit 已写入当前分支的第一条增量事件；hydrate 会据此重建消息和派生索引。
    return (await this.hydrate(branch.id)) ?? branch;
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  // 执行 session-lifecycle.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
  rewind(sessionId: string, eventSeq: number): Promise<Session> {
    // Rewind 与 Fork 使用相同增量机制，只改变生成标题表达的用户意图。
    return this.forkFrom(sessionId, eventSeq, 'Rewind');
  } // 结束 Rewind 分支创建。

  /** 加载目标分支的可见事件和运行状态；不会移动或合并事件。 */
  switchBranch(sessionId: string): Promise<Session | null> {
    // 每个分支本身就是 Session，所以切换等价于 hydrate 目标 Session。
    return this.hydrate(sessionId);
  } // 结束 Session 分支切换。

  /** 只从公开事件事实重建分叉点 Ledger，不读取或保存模型私有推理。 */
  private rebuildLedger(history: Awaited<ReturnType<SessionStore['readEvents']>>): ContextLedger {
    // 创建 ledger 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const ledger = new ContextLedger();
    // 创建 calls 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const calls = new Map<string, { name: string; args: unknown }>();
    // 创建 changes 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const changes = new Map<string, Extract<AgentEvent, { type: 'changes.created' }>['changeSet']>();
    // 遍历当前集合或异步事件流，并按顺序处理其中每一项。
    for (const record of history) {
      // 创建 event 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
      const event = record.event;
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (event.type === 'message.user') ledger.setGoal(event.text);
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (event.type === 'plan.updated') ledger.setPlan(event.steps);
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (event.type === 'changes.created') {
        // 执行 session-lifecycle.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        changes.set(event.changeSet.id, event.changeSet);
        // 执行 session-lifecycle.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        ledger.recordChanges(event.changeSet.files.map((file) => ({ path: file.path, after: file.after })));
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (event.type === 'changes.reverted') {
        // 创建 changeSet 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
        const changeSet = changes.get(event.changeSetId);
        // 检查该条件；只有条件成立时才执行紧随其后的分支。
        if (changeSet) ledger.recordChanges(changeSet.files.map((file) => ({ path: file.path, after: file.before })));
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (event.type === 'tool.requested') calls.set(event.call.id, { name: event.call.name, args: event.call.args });
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (event.type === 'tool.completed') {
        // 创建 call 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
        const call = calls.get(event.callId);
        // 创建 command 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
        const command = call?.name === 'run_command'
          // 执行 session-lifecycle.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          ? String((call.args as { command?: unknown } | undefined)?.command ?? '')
          // 执行 session-lifecycle.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          : '';
        // 检查该条件；只有条件成立时才执行紧随其后的分支。
        if (command && isValidationCommand(command)) {
          // 创建 output 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
          const output = event.result.output as { stderr?: unknown; stdout?: unknown } | undefined;
          // 执行 session-lifecycle.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          ledger.addValidation(command, event.result.ok, String(output?.stderr || output?.stdout || event.result.error?.message || '').slice(-500));
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        }
        // 检查该条件；只有条件成立时才执行紧随其后的分支。
        if (!event.result.ok && event.result.error && event.result.error.code !== 'exploration_budget_exhausted') {
          // 执行 session-lifecycle.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          ledger.addError(event.result.error.code, event.result.error.message);
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        }
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // 返回只由分叉点之前公开事件推导出的独立账本。
    return ledger;
  } // 结束分支 Ledger 重建方法。

  /** 从 JSONL 事件历史恢复一个 Session 的完整可运行状态。 */
  async hydrate(sessionId: string, rebuildDerivedState = false): Promise<Session | null> {
    // hydrate 总是以磁盘数据为准，确保恢复的是持久化 Session。
    const session = await this.options.store.readSession(sessionId);
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (!session || workspaceKey(session.workspacePath) !== workspaceKey(this.options.workspace)) return null;
    // 先缓存 Session 元数据，后续事件路由可以立即通过 id 查到它。
    this.options.sessions.set(sessionId, session);
    // Ledger 有单独的 state 快照；不存在时从空状态开始。
    let ledger = rebuildDerivedState ? new ContextLedger() : (this.options.ledgers.get(sessionId) ?? new ContextLedger());
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.options.ledgers.set(sessionId, ledger);
    // readState 使用泛型声明“期望读到的 JSON 结构”。
    const savedLedger = await this.options.store.readState<ContextLedgerStateV2 | Record<string, unknown>>(sessionId);
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (savedLedger && !rebuildDerivedState) ledger.restore(savedLedger);
    // Evidence 正文不单独持久化，可以从工具结果按需重新建立。
    const evidence = rebuildDerivedState ? new FileEvidenceStore() : (this.options.evidence.get(sessionId) ?? new FileEvidenceStore());
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.options.evidence.set(sessionId, evidence);
    // 创建 memory 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const memory = rebuildDerivedState ? new MemoryIndex() : (this.options.memories.get(sessionId) ?? new MemoryIndex());
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.options.memories.set(sessionId, memory);
    // replaySessionEvents 是纯回放器：它把事件流归类，但不直接修改这里的 Map。
    const history = await this.options.store.readEvents(sessionId);
    // 创建 replay 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const replay = replaySessionEvents(sessionId, history);
    // Turn 回退后不能继续使用包含被撤销目标、计划和 revision 的旧 state.json。
    if (rebuildDerivedState) {
      // 仅根据 tombstone 过滤后的公开事件重建权威账本。
      ledger = this.rebuildLedger(replay.records);
      // 用新实例替换旧 Ledger 引用，后续模型请求立即读取干净状态。
      this.options.ledgers.set(sessionId, ledger);
      // 覆盖 state.json，保证应用重启后仍保持相同上下文。
      await this.options.store.writeState(sessionId, ledger.snapshot());
    }
    // 创建 latestSnapshot 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    let latestSnapshot;
    // 遍历当前集合或异步事件流，并按顺序处理其中每一项。
    for (const item of [...replay.modelItems].reverse()) {
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (item.kind === 'compaction' && item.snapshot) { latestSnapshot = item.snapshot; break; }
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (latestSnapshot) this.options.tokenCalibrator.restore(latestSnapshot.modelKey, latestSnapshot.tokenScale);
    // 每条回放诊断都交给可选回调；?. 表示没有回调时跳过。
    for (const diagnostic of replay.diagnostics) this.options.onReplayDiagnostic?.(sessionId, diagnostic);
    // toolNames 用于把 tool_result 重新配对到原来的工具名。
    const messages: ModelMessage[] = [];
    // 创建 toolNames 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const toolNames = new Map<string, string>();
    // 创建 artifacts 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const artifacts = new Map(
      // 执行 session-lifecycle.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      replay.records.flatMap((record) => record.event.type === 'artifact.created'
        // 执行 session-lifecycle.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        ? [[record.event.artifact.toolCallId, record.event.artifact] as const]
        // 执行 session-lifecycle.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        : []),
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    );
    // 重建时先清掉该 Session 的旧索引，避免已撤销 Turn 的 ChangeSet 继续留在内存。
    if (rebuildDerivedState) this.options.changes.removeSession(sessionId);
    // ChangeManager 先恢复可见索引，UI 才能立即撤销或恢复检查点。
    this.options.changes.hydrate(replay.changeSets, replay.checkpoints);
    // 遍历当前集合或异步事件流，并按顺序处理其中每一项。
    for (const item of replay.modelItems) {
      // 用户消息可直接还原为模型协议中的 user role。
      if (item.kind === 'user_message') messages.push({ role: 'user', content: item.text });
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (item.kind === 'assistant_message') {
        // toolCalls 若存在必须与 assistant 消息一起恢复，不能拆开。
        messages.push({
          // 设置 role 字段，把这一项数据传给目标对象、事件或函数。
          role: 'assistant',
          // 设置 content 字段，把这一项数据传给目标对象、事件或函数。
          content: item.text,
          // 执行 session-lifecycle.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          ...(item.toolCalls ? { toolCalls: item.toolCalls } : {}),
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        });
        // 保存 callId -> name，后续 tool_result Item 本身只有 callId。
        for (const call of item.toolCalls ?? []) toolNames.set(call.id, call.name);
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (item.kind === 'tool_result') {
        // 创建 toolName 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
        const toolName = toolNames.get(item.callId) ?? 'unknown';
        // serializeObservation 会恢复模型实际看过的裁剪/证据化结果，而非任意原始对象。
        messages.push({
          // 设置 role 字段，把这一项数据传给目标对象、事件或函数。
          role: 'tool',
          // 设置 content 字段，把这一项数据传给目标对象、事件或函数。
          content: serializeObservation(toolName, {}, item.result, ledger, evidence, artifacts.get(item.callId)),
          // 设置 toolCallId 字段，把这一项数据传给目标对象、事件或函数。
          toolCallId: item.callId,
          // 执行 session-lifecycle.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          ...(toolName !== 'unknown' ? { toolName } : {}),
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        });
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (item.kind === 'compaction') {
        // 压缩点取代它之前的自然语言历史，所以先清空再装入压缩后的消息。
        messages.length = 0;
        // 旧存储若没有 messages，就退回为一条带摘要的 user 消息。
        if (item.messages?.length) messages.push(...item.messages);
        // 前面的条件均不成立时执行这个后备分支。
        else messages.push({ role: 'user', content: `[历史压缩摘要]\n${item.summary}` });
        // 压缩后重新扫描保留消息中的 toolCalls，建立新的配对表。
        toolNames.clear();
        // 遍历当前集合或异步事件流，并按顺序处理其中每一项。
        for (const message of messages) for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name);
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // 删除没有配对 tool_result 的残缺协议组，避免模型 API 拒绝下一次请求。
    this.options.messages.set(sessionId, sanitizeModelMessages(messages));
    // MemoryIndex 是派生索引，可以安全地从事件日志全部重建。
    memory.rebuild(sessionId, replay.records, ledger.revision());
    // 遍历当前集合或异步事件流，并按顺序处理其中每一项。
    for (const started of replay.unfinishedTurns) {
      // 同一 Session 没有新运行 Turn 时，才为旧未完成 Turn 写入一次失败事件。
      if (!this.options.activeSessionTurns.has(sessionId)) {
        // 应用退出前未结束的 Turn 不会继续执行，回放时明确记为 interrupted。
        const interrupted: Turn = { ...started, status: 'failed', completedAt: now() };
        // 创建 error 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
        const error = {
          // 设置 code 字段，把这一项数据传给目标对象、事件或函数。
          code: 'interrupted',
          // 设置 message 字段，把这一项数据传给目标对象、事件或函数。
          message: '应用在任务结束前退出，后台执行已停止。请重新尝试。',
          // 设置 retryable 字段，把这一项数据传给目标对象、事件或函数。
          retryable: true,
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        };
        // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
        await this.options.emit(
          // 执行 session-lifecycle.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          { type: 'turn.failed', timestamp: now(), turn: interrupted, error, sessionId },
          // 执行 session-lifecycle.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          { kind: 'error', id: itemId(), error, createdAt: now() },
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        );
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // 所有内存 Map 和可能的中断事件都处理完成后返回 Session 元数据。
    return session;
  } // 结束 Session hydrate 方法。
} // 结束 SessionLifecycle 类。
