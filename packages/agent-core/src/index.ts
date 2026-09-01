/**
 * AgentCore 是整个 Agent 引擎对外暴露的“门面”。
 *
 * 可以把它理解成 JavaScript 应用中的总控制器：调用方只需要认识 AgentCore，
 * 不需要知道 TurnRunner、ToolCallExecutor、SessionLifecycle 等内部组件如何协作。
 * 这个文件主要做三件事：组装依赖、转发公共 API、持久化并广播事件。
 */
// ModelConfig 描述当前模型地址、名称、上下文窗口和输出上限。
import type { ModelConfig } from '@seecoder/model';
// 这些协议类型贯穿 AgentCore 的公开 API、内存状态和事件通道。
import type { ModelMessage, ModelProvider, AgentEvent, AttachmentRef, Checkpoint, Item, LocalSkill, Session, SessionEvent, ToolResult, Turn, ExecutionMode } from '@seecoder/protocol';
// SessionStore 负责持久化，ReplayDiagnostic 描述回放时发现的历史异常。
import type { ReplayDiagnostic, SessionStore } from '@seecoder/storage';
// ToolRegistry 保存工具实现，WorkspacePolicy 限制所有路径留在项目内。
import { ToolRegistry, WorkspacePolicy } from '@seecoder/tools';
// 三个上下文类型分别保存权威任务账本、文件证据和可检索历史。
import type { ContextLedger, FileEvidenceStore, MemoryIndex } from './context.js';
// SubagentRunner 运行只读的 explore/review 子 Agent。
import { SubagentRunner } from './runtime/subagent-runner.js';
// ChangeManager 记录、撤销和恢复 Agent 产生的文件变化。
import { ChangeManager } from './runtime/change-manager.js';
// SessionLifecycle 创建、删除、分支和回放长期会话。
import { SessionLifecycle } from './runtime/session-lifecycle.js';
// ToolCallExecutor 承担工具校验、审批、执行和结果记账，HookRuntime 描述 Hook 环境。
import { ToolCallExecutor, type HookRuntime } from './runtime/tool-call-executor.js';
// TurnRunner 是从用户输入运行到终态的主状态机。
import { TurnRunner } from './runtime/turn-runner.js';
// 拦截器流水线允许在关键生命周期阶段观察、替换或阻止数据。
import { AgentInterceptorPipeline, type AgentInterceptor } from './runtime/agent-interceptor.js';
// TokenCalibrator 用 Provider 的真实 usage 修正本地 token 估算。
import { TokenCalibrator } from './runtime/token-calibrator.js';
// ToolArtifactStore 把过大的工具结果外置到 Session 文件。
import { ToolArtifactStore } from './runtime/tool-artifact-store.js';
// WorkspaceMutationCoordinator 防止同一项目中的多个 Session 并发覆盖文件。
import { WorkspaceMutationCoordinator } from './runtime/workspace-mutation-coordinator.js';

// 重新导出 ContextLedger，让调用方无需了解其内部文件位置。
export { ContextLedger, type ContextLedgerStateV2 } from './context.js';
// 重新导出 HookRuntime，供桌面主进程实现受信任 Hook。
export type { HookRuntime } from './runtime/tool-call-executor.js';
// 重新导出拦截器相关类型，供 AgentCoreOptions 的调用方实现扩展。
export type { AgentInterceptor, InterceptContext, InterceptResult, InterceptStage } from './runtime/agent-interceptor.js';

// 声明一个对象结构类型，明确调用方必须提供哪些字段。
export interface AgentCoreOptions {
  /** Agent 允许读写的项目根目录。 */
  workspace: string;
  /** 与大模型通信的适配器，可以在运行时替换。 */
  provider: ModelProvider;
  /** 模型名、上下文长度、输出上限等配置。 */
  model: ModelConfig;
  /** Session 和事件轨迹的持久化存储。 */
  store: SessionStore;
  /** 工具注册表；不传时使用内置工具集合。 */
  registry?: ToolRegistry;
  /** plan/guided/auto 三种执行模式。 */
  mode?: ExecutionMode;
  /** 可选的生命周期 Hook 执行环境。 */
  hooks?: HookRuntime;
  /** 可改写或阻止关键生命周期阶段的内存内拦截器。 */
  interceptors?: AgentInterceptor[];
  /** Session 回放发现损坏或不一致事件时的诊断回调。 */
  onReplayDiagnostic?: (sessionId: string, diagnostic: ReplayDiagnostic) => void;
} // 结束 AgentCore 构造选项接口。
// 所有持久化时间都使用 ISO 字符串，方便排序、序列化和跨时区显示。
const now = () => new Date().toISOString();
// AgentCore 是桌面后端唯一需要直接调用的 Agent 引擎入口。
export class AgentCore {
  // registry 与 policy 是多个运行组件共用的基础能力。
  private readonly registry: ToolRegistry;
  // 声明类的内部字段或方法，用来保存仅由本模块维护的状态。
  private readonly policy: WorkspacePolicy;
  // mode 可由设置页动态修改，所以不是 readonly。
  private mode: ExecutionMode;
  // Set 可避免同一个事件监听器被重复注册。
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  // 以下 Map 是内存中的权威运行态；key 通常是 sessionId 或 turnId。
  private readonly messages = new Map<string, ModelMessage[]>();
  // 声明类的内部字段或方法，用来保存仅由本模块维护的状态。
  private readonly sessions = new Map<string, Session>();
  // 声明类的内部字段或方法，用来保存仅由本模块维护的状态。
  private readonly turns = new Map<string, Turn>();
  // 声明类的内部字段或方法，用来保存仅由本模块维护的状态。
  private readonly activeSessionTurns = new Map<string, string>();
  // 下面的组件各自负责一个清晰领域，AgentCore 只负责把它们连接起来。
  private readonly subagents: SubagentRunner;
  // changes 管理工具产生的 ChangeSet 和 Checkpoint。
  private readonly changes: ChangeManager;
  // sessionLifecycle 管理会话元数据、分支和事件回放。
  private readonly sessionLifecycle: SessionLifecycle;
  // interceptors 按顺序执行调用方注册的内存扩展。
  private readonly interceptors: AgentInterceptorPipeline;
  // tokenCalibrator 在所有 Turn 间复用同一模型的估算倍率。
  private readonly tokenCalibrator = new TokenCalibrator();
  // artifacts 负责大型 ToolResult 的外置和分页读取。
  private readonly artifacts: ToolArtifactStore;
  // mutations 是同一 Workspace 所有写入动作共享的协调器。
  private readonly mutations: WorkspaceMutationCoordinator;
  // toolExecutor 执行单个或一批模型 Tool Call。
  private readonly toolExecutor: ToolCallExecutor;
  // turnRunner 控制 Turn 状态机、模型循环、取消和动态干预。
  private readonly turnRunner: TurnRunner;
  // turnModes 保存每个 Turn 对全局执行模式的临时覆盖。
  private readonly turnModes = new Map<string, ExecutionMode>();
  // ledgers 按 Session 保存结构化目标、计划、revision 和验证记录。
  private readonly ledgers = new Map<string, ContextLedger>();
  // evidence 按 Session 保存读取过的文件证据及其内容哈希。
  private readonly evidence = new Map<string, FileEvidenceStore>();
  // memories 按 Session 保存从历史事件建立的轻量检索索引。
  private readonly memories = new Map<string, MemoryIndex>();

  // 构造函数创建所有运行组件，并让它们共享上面的 Map 和事件入口。
  constructor(private readonly options: AgentCoreOptions) {
    // 若调用方未注入 registry，就创建包含 SeeCoder 内置工具的注册表。

    this.registry = options.registry ?? new ToolRegistry();
    // WorkspacePolicy 会把所有文件路径限制在 workspace 内。
    this.policy = new WorkspacePolicy(options.workspace);
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.interceptors = new AgentInterceptorPipeline(options.interceptors);
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.artifacts = new ToolArtifactStore(options.store);
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.mutations = new WorkspaceMutationCoordinator(options.workspace);
    // 子 Agent 只做 explore/review，并复用当前模型与事件通道。
    this.subagents = new SubagentRunner({
      workspace: options.workspace, // 子 Agent 只能读取这个工作区
      registry: this.registry, // 从同一注册表筛选只读工具
      getProvider: () => this.options.provider, // 每次调用都读取最新 Provider
      getModel: () => this.options.model, // 每次调用都读取最新模型配置
      emit: (event, item) => this.emit(event, item), // 复用 Core 的持久化和事件广播入口
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
    // ChangeManager 管理 ChangeSet、Checkpoint 与安全恢复。
    this.changes = new ChangeManager({
      workspace: options.workspace, // restoreChangeSet 实际操作的根目录
      policy: this.policy, // 恢复前用它校验文件仍在 workspace 内
      store: options.store, // 保存修改前的文件快照
      emit: (event, item) => this.emit(event, item), // 发布 ChangeSet/Checkpoint 事件
      persistLedger: (sessionId) => this.persistLedger(sessionId), // 修改后落盘最新 revision
      getLedger: (sessionId) => this.ledgers.get(sessionId), // 获取 Session 的任务账本
      getEvidence: (sessionId) => this.evidence.get(sessionId), // 修改后让旧文件证据失效
      getTurnSession: (turnId) => this.turns.get(turnId)?.sessionId, // 从 Turn 反查所属 Session
      // 所有恢复动作与普通工具写入使用同一个锁协调器。
      mutations: this.mutations,
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
    // SessionLifecycle 负责创建、删除和从事件日志恢复 Session。
    this.sessionLifecycle = new SessionLifecycle({
      workspace: options.workspace, // 只恢复属于当前工作区的 Session
      store: options.store, // 从磁盘读取 Session、事件和 Ledger 状态
      sessions: this.sessions, // 恢复后的 Session 元数据写入这个 Map
      messages: this.messages, // 回放得到的模型消息写入这个 Map
      ledgers: this.ledgers, // 每个 Session 对应一个 ContextLedger
      evidence: this.evidence, // 每个 Session 对应一个文件证据库
      memories: this.memories, // 每个 Session 对应一个历史检索索引
      activeSessionTurns: this.activeSessionTurns, // 删除前检查 Session 是否仍在运行
      changes: this.changes, // 回放 ChangeSet 和 Checkpoint
      // 回放压缩快照时恢复对应模型的 token 校准倍率。
      tokenCalibrator: this.tokenCalibrator,
      emit: (event, item) => this.emit(event, item), // 发布创建或中断恢复事件
      // 可选字段不能显式传 undefined，因此存在回调时才展开进配置对象。
      ...(options.onReplayDiagnostic ? { onReplayDiagnostic: options.onReplayDiagnostic } : {}),
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
    // ToolCallExecutor 负责一次工具调用从校验到记账的完整过程。
    this.toolExecutor = new ToolCallExecutor({
      workspace: options.workspace, // 普通工具执行时使用的根目录
      registry: this.registry, // 根据模型给出的工具名查找真实实现
      policy: this.policy, // 判断工具是否可自动批准
      changes: this.changes, // 文件工具成功后登记 ChangeSet
      subagents: this.subagents, // delegate/review_changes 工具的执行后端
      // 大型结果通过 artifacts 外置，避免直接塞入模型上下文。
      artifacts: this.artifacts,
      // 副作用工具通过 mutations 与其他 Session 写入互斥。
      mutations: this.mutations,
      hooks: options.hooks, // 可选的 preToolUse/postFileEdit 生命周期 Hook
      // before/afterToolCall 等阶段交给同一拦截器流水线。
      interceptors: this.interceptors,
      getMode: (turnId) => this.turnModes.get(turnId) ?? this.mode, // 优先使用 Turn 覆盖模式
      getTurnSession: (turnId) => this.turns.get(turnId)?.sessionId, // 审批事件需要 Session 路由
      getLedger: (sessionId) => this.ledgers.get(sessionId), // 写入计划、验证和错误记录
      persistLedger: (sessionId) => this.persistLedger(sessionId), // 每次记账后立即持久化
      emit: (event, item) => this.emit(event, item), // 统一发布 tool requested/completed 事件
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
    // TurnRunner 是主状态机，负责从用户消息一直运行到完成、失败或取消。
    this.turnRunner = new TurnRunner({
      workspace: options.workspace, // 构建系统提示和读取附件时使用
      registry: this.registry, // 生成发送给模型的工具 Schema
      policy: this.policy, // 校验附件路径
      subagents: this.subagents, // 取消 Turn 时同步取消子 Agent
      toolExecutor: this.toolExecutor, // 执行模型产生的每个 ToolCall
      // 模型请求前运行 beforeModelCall，用户输入阶段运行对应拦截器。
      interceptors: this.interceptors,
      // 每次模型 usage 返回后更新当前模型的估算倍率。
      tokenCalibrator: this.tokenCalibrator,
      // ContextBuilder 需要 Artifact 元数据来生成可回读的 Observation。
      artifacts: this.artifacts,
      // 分支压缩快照需要记录当前 Session 最新事件位置。
      getLastEventSeq: (sessionId) => this.options.store.getLastSequence(sessionId),
      getProvider: () => this.options.provider, // 支持运行时切换模型 Provider
      getModel: () => this.options.model, // 支持运行时切换模型参数
      getDefaultMode: () => this.mode, // 没有 Turn 覆盖值时使用全局模式
      // 先查内存；未命中时才读取磁盘并回放，避免每次 Turn 都重复 I/O。
      getSession: async (sessionId) =>
        // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
        this.sessions.get(sessionId) ?? this.sessionLifecycle.hydrate(sessionId),
      messages: this.messages, // 主模型的 Session 消息历史
      turns: this.turns, // turnId 到 Turn 状态的索引
      activeSessionTurns: this.activeSessionTurns, // 保证同一 Session 只有一个运行中 Turn
      turnModes: this.turnModes, // 保存每个 Turn 的模式覆盖值
      ledgers: this.ledgers, // 上下文构建需要的权威任务状态
      evidence: this.evidence, // 上下文构建需要的文件证据
      memories: this.memories, // 上下文构建需要的历史检索索引
      persistLedger: (sessionId) => this.persistLedger(sessionId), // Turn 修改目标或错误后落盘
      emit: (event, item) => this.emit(event, item), // 所有状态变化统一经过 Core
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
    // guided 是默认模式：有副作用的操作需要用户批准。
    this.mode = options.mode ?? 'guided';
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /**
   * 注册事件监听器。
   * Electron 主进程用它把 AgentEvent 转发给 Renderer；返回值是取消订阅函数。
   */
  onEvent(listener: (event: AgentEvent) => void): () => void {
    // Set.add 保存函数引用；同一函数重复添加不会出现两份。
    this.listeners.add(listener);
    // 闭包记住 listener，调用返回函数即可把它从 Set 删除。
    return () => this.listeners.delete(listener);
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 更新全局执行模式，并向 UI 发布 mode.changed。 */
  setMode(mode: ExecutionMode): void {
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.mode = mode;
    // 不阻塞设置操作；事件会异步写入并通知 UI。
    void this.emit({ type: 'mode.changed', timestamp: now(), mode });
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 返回当前全局执行模式，供 IPC 设置页读取。 */
  getMode(): ExecutionMode {
    // 把计算完成的结果返回给当前方法的调用方。
    return this.mode;
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /**
   * 在不丢失会话、审批和进行中 Turn 的情况下切换模型 Provider。
   * 设置页更新配置时只替换依赖，避免重建 Core 导致 Renderer 持有的
   * sessionId 脱离内存状态。
   */
  reconfigureModel(provider: ModelProvider, model: ModelConfig): void {
    // options 是 constructor parameter property，保存在 this.options 上且允许替换这两个字段。
    this.options.provider = provider;
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.options.model = model;
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 将指定 Session 的 Ledger 深拷贝快照写入独立 state 文件。 */
  private async persistLedger(sessionId: string): Promise<void> {
    // Map.get 可能返回 undefined，例如 Session 尚未创建 Ledger。
    const ledger = this.ledgers.get(sessionId);
    // 只有 Ledger 存在才写磁盘；optional 情况不被视为错误。
    if (ledger) await this.options.store.writeState(sessionId, ledger.snapshot());
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 把用户运行中追加的方向调整放入指定 Turn 的 steering 队列。 */
  async steerTurn(turnId: string, text: string): Promise<void> {
    // TurnRunner 会在完整消息协议组边界消费这条干预。
    return this.turnRunner.steerTurn(turnId, text);
  } // 结束运行中方向调整转发。

  /** 把用户的新要求排到当前 Turn 完成之后自动执行。 */
  async queueFollowUp(turnId: string, text: string): Promise<void> {
    // TurnRunner 负责校验目标 Turn 并保存 followUp 顺序。
    return this.turnRunner.queueFollowUp(turnId, text);
  } // 结束后续任务排队转发。

  /** 把 Renderer 回答的文本交给正在等待的 ask_user 工具。 */
  async resolveUserInput(requestId: string, answer: string): Promise<void> {
    // ToolCallExecutor 持有 ask_user 对应的等待 Promise。
    return this.toolExecutor.resolveUserInput(requestId, answer);
  } // 结束用户输入解析转发。

  /** 列出当前工作区的所有 Session。 */
  async listSessions(): Promise<Session[]> { return this.sessionLifecycle.list(); } // SessionLifecycle 会按当前 Workspace 过滤结果。

  /** 读取一个 Session 的持久化事件，供 UI 恢复轨迹。 */
  async readSessionEvents(sessionId: string): Promise<AgentEvent[]> { return this.sessionLifecycle.readEvents(sessionId); } // 分支 Session 返回父历史截止部分加自身增量。
  // Renderer 使用带 seq 的记录把每个 Turn 底部“分支”按钮绑定到正确历史位置。
  async readSessionEventRecords(sessionId: string): Promise<SessionEvent[]> { return this.sessionLifecycle.readEventRecords(sessionId); }

  /** 删除未运行的 Session 及其缓存。 */
  async deleteSession(sessionId: string): Promise<void> { return this.sessionLifecycle.delete(sessionId); } // 删除前会检查活动 Turn 和子分支。

  /** 撤销一个 ChangeSet，把文件恢复到该次修改之前。 */
  async revertChangeSet(changeSetId: string): Promise<ToolResult> { return this.changes.revert(changeSetId); } // ChangeManager 负责文件锁、恢复和重新记账。

  /** 返回全部或指定 Session 的检查点。 */
  listCheckpoints(sessionId?: string): Checkpoint[] { return this.changes.listCheckpoints(sessionId); } // 省略 sessionId 时返回全部检查点。

  /** 在无冲突时恢复指定检查点。 */
  async restoreCheckpoint(checkpointId: string): Promise<ToolResult> {
    // ChangeManager 先完成文件恢复并持久化 checkpoint.restored、turn.reverted 两个事实。
    const result = await this.changes.restore(checkpointId);
    // 失败时保持当前上下文和界面状态，错误原因原样交给 Renderer。
    if (!result.ok) return result;
    // 成功输出包含恢复点所属 Session；该字段由内部 ChangeManager 生成，不接受外部输入。
    const output = result.output as { sessionId?: unknown; turnId?: unknown } | undefined;
    // 分别读取需要重建的 Session 和需要删除的 Turn。
    const sessionId = output?.sessionId;
    // Turn 已经终止且被 tombstone 隐藏，内存索引也应同步删除。
    if (typeof output?.turnId === 'string') {
      // 删除 Turn 状态，避免内部查询仍把它当作有效历史 Turn。
      this.turns.delete(output.turnId);
      // 清理该 Turn 可能残留的模式覆盖。
      this.turnModes.delete(output.turnId);
    }
    // 立即依据 tombstone 后的可见历史重建模型消息、Ledger、Memory 和变更索引。
    if (typeof sessionId === 'string') await this.sessionLifecycle.hydrate(sessionId, true);
    // 返回原始 ToolResult，IPC 调用方仍能读取 restored、turnId 等信息。
    return result;
  } // 结束整轮恢复与上下文重建。

  /** 创建一个新的空 Session。 */
  async createSession(title = '新的 SeeCoder 任务'): Promise<Session> { return this.sessionLifecycle.create(title); } // 默认标题只用于用户没有传入标题时。

  /** 从指定事件位置建立增量分支；省略 eventSeq 时从当前分支头 Fork。 */
  async forkFrom(sessionId: string, eventSeq?: number): Promise<Session> { return this.sessionLifecycle.forkFrom(sessionId, eventSeq); } // 子分支只保存父引用和新增事件。

  /** 以新分支形式回退，不破坏原 Session。 */
  async rewindSession(sessionId: string, eventSeq: number): Promise<Session> { return this.sessionLifecycle.rewind(sessionId, eventSeq); } // Rewind 不删除原分支，也不自动恢复 Workspace 文件。

  /** 恢复并切换到指定分支。 */
  async switchBranch(sessionId: string): Promise<Session | null> { return this.sessionLifecycle.switchBranch(sessionId); } // 切换本质是 hydrate 目标 Session。

  /** 从磁盘事件恢复 Session，使它可以继续启动新 Turn。 */
  async hydrateSession(sessionId: string): Promise<Session | null> { return this.sessionLifecycle.hydrate(sessionId); } // 回放只重建事实，不重执行历史副作用。

  /** 创建并异步运行一个新的 Turn，立即返回它的唯一标识。 */
  async startTurn(sessionId: string, text: string, modeOverride?: ExecutionMode, attachments: AttachmentRef[] = [], activeSkill?: { skill: LocalSkill; content: string }): Promise<string> {
    // 对外签名保持简单，实际状态机完全封装在 TurnRunner 中。
    return this.turnRunner.start(sessionId, text, modeOverride, attachments, activeSkill);
  } // 结束 Turn 启动转发。

  /** 将 Renderer 的审批决定交给等待中的工具调用。 */
  async resolveApproval(approvalId: string, decision: 'allow' | 'deny', reason?: string): Promise<void> {
    // ToolCallExecutor 根据 approvalId 唤醒对应工具调用。
    return this.toolExecutor.resolveApproval(approvalId, decision, reason);
  } // 结束审批决定转发。

  /** 取消指定 Turn，以及它的模型请求、工具等待和子 Agent。 */
  cancelTurn(turnId: string): void {
    // TurnRunner 会把同一个取消信号传播到模型、工具、等待和子 Agent。
    this.turnRunner.cancelTurn(turnId);
  } // 结束单 Turn 取消转发。

  /** 工作区切换或窗口关闭时取消所有未完成执行，避免旧工作区继续写入。 */
  cancelAll(): void {
    // 批量取消用于 Workspace 切换和应用退出收尾。
    this.turnRunner.cancelAll();
  } // 结束全部 Turn 取消转发。

  /** 为事件补齐 Session 路由，追加到存储、更新记忆索引并通知实时监听器。 */
  private async emit(event: AgentEvent, item?: Item): Promise<void> {
    // 不同事件携带 Session 信息的位置不同，这里统一推导 sessionId。
    const sessionId = event.sessionId ?? ('turnId' in event ? this.turns.get(event.turnId)?.sessionId : undefined) ?? ('turn' in event ? event.turn.sessionId : undefined) ?? ('session' in event ? event.session.id : undefined) ?? ('approval' in event ? this.turns.get(event.approval.turnId)?.sessionId : undefined) ?? ('changeSet' in event ? this.turns.get(event.changeSet.turnId)?.sessionId : undefined) ?? ('child' in event ? this.turns.get(event.child.parentTurnId)?.sessionId : undefined) ?? ('sessionId' in event ? event.sessionId : undefined);
    // routed 是补齐 sessionId 后真正写入存储并发给 UI 的事件。
    const routed = sessionId ? { ...event, sessionId } : event;
    // 流式文本只服务实时 UI；message.completed 已保存完整回复。
    // 不把每个 delta 追加到 JSONL，避免长回复产生数千次磁盘写入和巨大会话文件。
    if (sessionId && event.type !== 'message.delta') await this.options.store.append(sessionId, { event: routed, ...(item ? { item } : {}) });
    // 同一份事件也进入轻量记忆索引，供后续上下文检索使用。
    if (sessionId) this.memories.get(sessionId)?.ingest(sessionId, routed, item, this.ledgers.get(sessionId)?.revision() ?? 0);
    // 最后通知所有实时监听器，例如 Electron 主进程转发给 Renderer。
    this.listeners.forEach((listener) => listener(routed));
  } // 结束统一事件出口。
} // 结束 AgentCore 门面类。
