/**
 * ToolCallExecutor 负责“一次工具调用”的完整生命周期：
 * 解析参数 → 检查幂等 → 风险审批 → pre Hook → 执行 → post Hook → 记录结果。
 * TurnRunner 只决定何时调用工具，不需要了解每种特殊工具的内部处理。
 */
// randomUUID 为审批、提问、审查发现和持久化 Item 创建全局唯一标识。
import { randomUUID } from 'node:crypto';
// 以下协议类型定义工具执行器与状态机、UI、持久化层之间交换的数据。
import type {
  AgentEvent, // 执行器向外发布的实时状态事件。
  Approval, // 等待用户确认的风险操作描述。
  ExecutionMode, // 决定工具权限的 plan/guided/auto 模式。
  HookCommand, // 项目 Hook 配置解析后得到的一条命令。
  HookExecutionContext, // Hook 执行时可读取的最小上下文。
  HookStage, // preToolUse、postFileEdit、turnEnd 等生命周期阶段。
  Item, // 需要写入 Session 时间线的持久化记录。
  PlanStep, // set_plan 工具写入 Ledger 的计划步骤。
  ReviewFinding, // review_changes 对 UI 输出的结构化问题。
  SubagentRole, // delegate 允许的 explore 或 review 角色。
  ToolCall, // 模型提出的工具名、参数和 callId。
  ToolResult, // 所有工具统一返回的成功或失败结构。
  Turn, // 当前工具调用所属的 Agent Turn。
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
} from '@seecoder/protocol';
// 工具包提供命令风险识别、补丁路径提取、执行上下文、注册表和工作区安全策略。
import { commandRisk, extractPatchPaths, type ToolContext, type ToolRegistry, type WorkspacePolicy } from '@seecoder/tools';
// isValidationCommand 识别测试命令，ContextLedger 保存验证与错误等权威状态。
import { isValidationCommand, type ContextLedger } from '../context.js';
// ChangeManager 在文件工具成功后记录可回滚的变更集。
import type { ChangeManager } from './change-manager.js';
// 拦截器可在工具执行前后检查、替换或阻止数据。
import type { AgentInterceptorPipeline } from './agent-interceptor.js';
// fail 生成标准失败结果，isChanges 判断工具输出是否包含文件修改。
import { fail, isChanges } from './policy.js';
// SubagentRunner 执行 delegate 和 review_changes 背后的只读子 Agent。
import type { SubagentRunner } from './subagent-runner.js';
// ToolArtifactStore 外置大型结果，并支持 read_artifact 分页读取。
import type { ToolArtifactStore } from './tool-artifact-store.js';
// WorkspaceMutationCoordinator 为文件写入提供路径锁或工作区独占锁。
import type { WorkspaceMutationCoordinator } from './workspace-mutation-coordinator.js';

// 声明一个对象结构类型，明确调用方必须提供哪些字段。
export interface HookRuntime {
  /** 根据生命周期阶段返回需要运行的 Hook 命令。 */
  resolve(stage: HookStage): Promise<HookCommand[]>;
  /** 在受控环境中执行一条 Hook 命令。 */
  execute(command: HookCommand, context: HookExecutionContext, signal: AbortSignal): Promise<ToolResult>;
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}
// 声明一个对象结构类型，明确调用方必须提供哪些字段。
interface PendingApproval {
  // approval 是给 UI 展示的数据，resolve 用来恢复暂停中的 Promise。
  approval: Approval;
  // 设置 resolve 字段，把这一项数据传给目标对象、事件或函数。
  resolve: (decision: { allow: boolean; reason?: string }) => void;
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}

// 声明一个对象结构类型，明确调用方必须提供哪些字段。
interface ToolCallExecutorOptions {
  // Executor 不直接依赖 AgentCore，而是通过字段和回调读取最小必要能力。
  /** 工具运行时看到的项目根目录。 */
  workspace: string;
  /** 按工具名查找参数 Schema、风险和 execute 实现。 */
  registry: ToolRegistry;
  /** 根据模式和风险决定是否自动执行。 */
  policy: WorkspacePolicy;
  /** 文件修改成功后创建 ChangeSet 和 Checkpoint。 */
  changes: ChangeManager;
  /** delegate 与 review_changes 的实际执行组件。 */
  subagents: SubagentRunner;
  /** 大型工具结果的 Session 隔离存储和分段读取。 */
  artifacts: ToolArtifactStore;
  /** 跨 Session 协调所有 workspace 写操作。 */
  mutations: WorkspaceMutationCoordinator;
  /** 项目未配置 Hook 时为 undefined。 */
  hooks: HookRuntime | undefined;
  /** 可在工具执行前改参数、执行后改结果或受控阻止。 */
  interceptors: AgentInterceptorPipeline;
  /** 读取指定 Turn 的 plan/guided/auto 模式。 */
  getMode: (turnId: string) => ExecutionMode;
  /** 将 turnId 转成 sessionId，便于事件正确路由。 */
  getTurnSession: (turnId: string) => string | undefined;
  /** 获取 Session 的权威 Ledger。 */
  getLedger: (sessionId: string) => ContextLedger | undefined;
  /** Ledger 更新后写入磁盘。 */
  persistLedger: (sessionId: string) => Promise<void>;
  /** 发布事件，并可附带需要持久化的 Item。 */
  emit: (event: AgentEvent, item?: Item) => Promise<void>;
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}

// 用统一的 ISO 时间字符串写事件，方便排序和 JSON 持久化。
const now = () => new Date().toISOString();
// Item 使用 UUID，不依赖跨进程共享的自增计数器。
const itemId = () => randomUUID();

// 声明这个模块的核心类，把相关状态和操作集中封装。
export class ToolCallExecutor {
  // 审批和用户输入都用 Promise 暂停，不通过轮询浪费 CPU。
  private readonly approvals = new Map<string, PendingApproval>();
  // 声明类的内部字段或方法，用来保存仅由本模块维护的状态。
  private readonly pendingInputs = new Map<string, { turnId: string; resolve: (answer: string) => void }>();
  // 同一个 Turn 内，callId 对应唯一结果，防止模型重复触发文件写入等副作用。
  private readonly executedCalls = new Map<string, Map<string, ToolResult>>();

  // 参数属性语法会自动创建并保存 this.options，构造函数无需额外赋值语句。
  constructor(private readonly options: ToolCallExecutorOptions) {}

  /** 将模型流中累积的 JSON 字符串转成对象；无效 JSON 留下 __invalid 供 Schema 报错。 */
  parseArguments(raw: string): unknown {
    // JSON.parse 可能因模型输出半截 JSON 而抛错，因此必须捕获。
    try {
      // 空参数按空对象处理；非空字符串则解析成真正的 JavaScript 值。
      return raw ? JSON.parse(raw) : {};
    // 捕获前面操作抛出的异常，把它转换成模块约定的安全结果。
    } catch {
      // 不直接抛异常，让后续 Zod Schema 产生统一的 invalid_args 工具结果。
      return { __invalid: raw.slice(0, 2000) };
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /**
   * 只有整批工具都显式声明 parallelSafe 时才并行；否则整批串行。
   * Promise.all 保持返回数组的输入顺序，因此模型 Tool Result 配对仍然稳定。
   */
  async executeBatch(
    // 设置 turn 字段，把这一项数据传给目标对象、事件或函数。
    turn: Turn,
    // 设置 calls 字段，把这一项数据传给目标对象、事件或函数。
    calls: ToolCall[],
    // 设置 signal 字段，把这一项数据传给目标对象、事件或函数。
    signal: AbortSignal,
    // 设置 forcedResults 字段，把这一项数据传给目标对象、事件或函数。
    forcedResults: Map<string, ToolResult> = new Map(),
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  ): Promise<ToolResult[]> {
    // 只有两个以上调用且每个定义都明确标记 parallelSafe，parallel 才为 true。
    const parallel = calls.length > 1 && calls.every(
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      (call) => this.options.registry.get(call.name)?.parallelSafe === true,
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    );
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (parallel) {
      // Promise.all 并发等待，但结果数组仍与 calls 的输入下标一一对应。
      return Promise.all(calls.map((call) => this.execute(turn, call, signal, forcedResults.get(call.id))));
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // 只要一个调用可能产生冲突，整批就按模型声明顺序串行执行。
    const results: ToolResult[] = [];
    // await 放在循环内部，保证前一个调用完成后才启动下一个。
    for (const call of calls) {
      // forcedResults 可把某个调用转换为状态机预先生成的失败结果。
      results.push(await this.execute(turn, call, signal, forcedResults.get(call.id)));
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // TurnRunner 将按此数组顺序写回 tool 消息。
    return results;
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** Turn 进入终态前，把本轮多次文件修改收口为唯一 Checkpoint。 */
  async finalizeTurnCheckpoint(turn: Turn): Promise<void> {
    // ChangeManager 自己保证幂等；成功、失败和取消路径都可以安全调用。
    await this.options.changes.finalizeTurn(turn);
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** UI 回答审批后，通过保存的 resolve 函数恢复 execute()。 */
  async resolveApproval(approvalId: string, decision: 'allow' | 'deny', reason?: string): Promise<void> {
    // approvalId 来自 Renderer；Map 中没有它说明请求已取消、完成或重复回答。
    const pending = this.approvals.get(approvalId);
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (!pending) return;
    // 在删除 pending 前先取出 Session，供 resolved 事件路由。
    const sessionId = this.options.getTurnSession(pending.approval.turnId);
    // 调用 resolve 会让 execute() 中 await new Promise 的代码从暂停点继续。
    pending.resolve({ allow: decision === 'allow', ...(reason ? { reason } : {}) });
    // Promise 只能解决一次，立即移除可防止 Renderer 重复点击。
    this.approvals.delete(approvalId);
    // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
    await this.options.emit({
      // 设置 type 字段，把这一项数据传给目标对象、事件或函数。
      type: 'approval.resolved',
      // 设置 timestamp 字段，把这一项数据传给目标对象、事件或函数。
      timestamp: now(),
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      approvalId,
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      decision,
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      ...(reason ? { reason } : {}),
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      ...(sessionId ? { sessionId } : {}),
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** UI 回答 ask_user 后恢复对应工具调用。 */
  async resolveUserInput(requestId: string, answer: string): Promise<void> {
    // requestId 对应 askUser() 创建的等待项。
    const pending = this.pendingInputs.get(requestId);
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (!pending) return;
    // 限制答案长度，避免一次 UI 输入无限扩大模型上下文。
    pending.resolve(answer.slice(0, 10_000));
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.pendingInputs.delete(requestId);
    // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
    await this.options.emit({
      // 设置 type 字段，把这一项数据传给目标对象、事件或函数。
      type: 'user.input.resolved',
      // 设置 timestamp 字段，把这一项数据传给目标对象、事件或函数。
      timestamp: now(),
      // 设置 turnId 字段，把这一项数据传给目标对象、事件或函数。
      turnId: pending.turnId,
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      requestId,
      // 设置 answer 字段，把这一项数据传给目标对象、事件或函数。
      answer: answer.slice(0, 10_000),
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 取消一个 Turn 时，同时释放其审批 Promise 和输入 Promise。 */
  cancelTurn(turnId: string, reason = '用户取消了任务'): void {
    // Map 可以在 for...of 遍历时删除当前元素。
    for (const [id, pending] of this.approvals) {
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (pending.approval.turnId === turnId) {
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        pending.resolve({ allow: false, reason });
        // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
        this.approvals.delete(id);
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // 遍历当前集合或异步事件流，并按顺序处理其中每一项。
    for (const [id, pending] of this.pendingInputs) {
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (pending.turnId === turnId) {
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        pending.resolve(reason);
        // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
        this.pendingInputs.delete(id);
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 工作区切换时一次释放所有等待状态。 */
  cancelAll(reason = '工作区已切换'): void {
    // 所有审批都按拒绝处理，使等待中的 execute() 可以结束。
    for (const pending of this.approvals.values()) {
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      pending.resolve({ allow: false, reason });
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // resolve 完毕后清空索引，避免重复回答。
    this.approvals.clear();
    // 所有 ask_user 等待都以取消原因作为占位答案恢复。
    for (const pending of this.pendingInputs.values()) {
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      pending.resolve(reason);
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // 清空输入请求索引，释放闭包引用。
    this.pendingInputs.clear();
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** Turn 终止后的兜底清理，确保 callId 缓存不会泄漏到下一 Turn。 */
  cleanupTurn(turnId: string): void {
    // 幂等结果只在一个 Turn 生命周期内有效，终态后即可删除。
    this.executedCalls.delete(turnId);
    // 再调用 cancelTurn 清理极端异常路径中未释放的审批或输入。
    this.cancelTurn(turnId, 'Turn 已结束');
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 按顺序运行某个阶段的 Hook；任一失败就停止后续 Hook。 */
  async runHooks(
    // 设置 stage 字段，把这一项数据传给目标对象、事件或函数。
    stage: HookStage,
    // 设置 turn 字段，把这一项数据传给目标对象、事件或函数。
    turn: Turn,
    // 设置 signal 字段，把这一项数据传给目标对象、事件或函数。
    signal: AbortSignal,
    // 设置 details 字段，把这一项数据传给目标对象、事件或函数。
    details: Partial<HookExecutionContext> = {},
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  ): Promise<{ ok: boolean; error?: ToolResult['error'] }> {
    // 没有 Hook 配置等价于成功跳过，不应该阻塞正常工具执行。
    if (!this.options.hooks) return { ok: true };
    // commands 在 try 成功后保存当前阶段按配置顺序解析出的命令。
    let commands: HookCommand[];
    // 进入可能失败的操作区，异常会交给后面的 catch 或 finally 处理。
    try {
      // 配置解析失败和命令执行失败使用不同 code，方便用户定位。
      commands = await this.options.hooks.resolve(stage);
    // 捕获前面操作抛出的异常，把它转换成模块约定的安全结果。
    } catch (error) {
      // 把计算完成的结果返回给当前方法的调用方。
      return {
        // 设置 ok 字段，把这一项数据传给目标对象、事件或函数。
        ok: false,
        // 设置 error 字段，把这一项数据传给目标对象、事件或函数。
        error: {
          // 设置 code 字段，把这一项数据传给目标对象、事件或函数。
          code: 'hook_config_invalid',
          // 设置 message 字段，把这一项数据传给目标对象、事件或函数。
          message: error instanceof Error ? error.message : 'Hook 配置无效',
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        },
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      };
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // Hook 必须顺序执行，前一个失败时后一个不应继续产生副作用。
    for (const command of commands) {
      // started/completed 成对出现，形成可审计的 Hook 轨迹。
      await this.options.emit({
        // 设置 type 字段，把这一项数据传给目标对象、事件或函数。
        type: 'hook.started',
        // 设置 timestamp 字段，把这一项数据传给目标对象、事件或函数。
        timestamp: now(),
        // 设置 turnId 字段，把这一项数据传给目标对象、事件或函数。
        turnId: turn.id,
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        stage,
        // 设置 hookId 字段，把这一项数据传给目标对象、事件或函数。
        hookId: command.id,
        // 设置 sessionId 字段，把这一项数据传给目标对象、事件或函数。
        sessionId: turn.sessionId,
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      });
      // result 统一承接 Hook 正常返回或 catch 转换后的失败结构。
      let result: ToolResult;
      // 进入可能失败的操作区，异常会交给后面的 catch 或 finally 处理。
      try {
        // details 会补充 toolName、callId 或 changedPaths 等阶段特有信息。
        result = await this.options.hooks.execute(
          // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          command,
          // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          { sessionId: turn.sessionId, turnId: turn.id, stage, ...details },
          // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          signal,
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        );
      // 捕获前面操作抛出的异常，把它转换成模块约定的安全结果。
      } catch (error) {
        // Hook Runtime 若直接 throw，也必须转成 ToolResult，不能让异常越过审计事件。
        result = fail('hook_failed', error instanceof Error ? error.message : 'Hook 执行失败');
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
      // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
      await this.options.emit({
        // 设置 type 字段，把这一项数据传给目标对象、事件或函数。
        type: 'hook.completed',
        // 设置 timestamp 字段，把这一项数据传给目标对象、事件或函数。
        timestamp: now(),
        // 设置 turnId 字段，把这一项数据传给目标对象、事件或函数。
        turnId: turn.id,
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        stage,
        // 设置 hookId 字段，把这一项数据传给目标对象、事件或函数。
        hookId: command.id,
        // 设置 ok 字段，把这一项数据传给目标对象、事件或函数。
        ok: result.ok,
        // 设置 durationMs 字段，把这一项数据传给目标对象、事件或函数。
        durationMs: result.durationMs,
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        ...(result.error?.code ? { errorCode: result.error.code } : {}),
        // 设置 sessionId 字段，把这一项数据传给目标对象、事件或函数。
        sessionId: turn.sessionId,
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      });
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (!result.ok) {
        // 把计算完成的结果返回给当前方法的调用方。
        return {
          // 设置 ok 字段，把这一项数据传给目标对象、事件或函数。
          ok: false,
          // 设置 error 字段，把这一项数据传给目标对象、事件或函数。
          error: result.error ?? { code: 'hook_failed', message: `Hook ${command.id} 执行失败` },
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        };
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // 所有命令依次成功后，本阶段才算成功。
    return { ok: true };
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /**
   * 执行单个 ToolCall。forcedResult 用于 TurnRunner 主动阻止超预算探索，
   * 但仍会走统一的 completed 事件和错误记账流程。
   */
  async execute(turn: Turn, call: ToolCall, signal: AbortSignal, forcedResult?: ToolResult): Promise<ToolResult> {
    // 每个 Turn 有独立的 callId -> result 子 Map，相同 id 在不同 Turn 可以重新使用。
    const turnCalls = this.executedCalls.get(turn.id) ?? new Map<string, ToolResult>();
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.executedCalls.set(turn.id, turnCalls);
    // 重复 callId 直接复用结果，不再次产生副作用。
    const existing = turnCalls.get(call.id);
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (existing) return existing;
    // 工具名前置拦截允许改参数，但禁止把已调度的安全工具偷换成另一种工具。
    const beforeIntercept = await this.options.interceptors.run(
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      { stage: 'beforeToolCall', sessionId: turn.sessionId, turnId: turn.id, value: call },
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      signal,
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    );
    // 创建 blockedByInterceptor 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    let blockedByInterceptor = beforeIntercept.action === 'block' ? beforeIntercept.reason : undefined;
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (beforeIntercept.action === 'replace') {
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (beforeIntercept.value.name !== call.name) blockedByInterceptor = 'beforeToolCall 不允许修改工具名称';
      // 前面的条件均不成立时执行这个后备分支。
      else call = beforeIntercept.value;
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // definition 可能为 undefined，后面会返回 unknown_tool，而不是直接调用。
    const definition = this.options.registry.get(call.name);
    // Item 会持久化进 Session 轨迹，AgentEvent 则用于实时状态通知。
    const callItem: Item = { kind: 'tool_call', id: itemId(), call, createdAt: now() };
    // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
    await this.options.emit({ type: 'tool.requested', timestamp: now(), turnId: turn.id, call }, callItem);
    // complete 是所有成功/失败出口共享的“收尾函数”。
    const complete = async (value: ToolResult, parsedData?: unknown): Promise<ToolResult> => {
      // 某些虚拟工具不记录耗时，统一补成 0，满足协议字段要求。
      const finalValue = { ...value, durationMs: value.durationMs || 0 };
      // 先写幂等缓存，再发布事件；事件监听期间若重复调用也不会再次执行。
      turnCalls.set(call.id, finalValue);
      // tool_result Item 会与前面的 tool_call Item 一起形成可回放的工具轨迹。
      const resultItem: Item = {
        kind: 'tool_result', // Item 判别字段。
        id: itemId(), // 这条结果记录自身的唯一 id。
        callId: call.id, // 与模型发出的 ToolCall 精确配对。
        result: finalValue, // 包含 ok、output/error 与耗时。
        createdAt: now(), // 结果完成并准备落盘的时间。
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      };
      // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
      await this.options.emit(
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        { type: 'tool.completed', timestamp: now(), turnId: turn.id, callId: call.id, result: finalValue },
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        resultItem,
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      );
      // 文件修改产生 ChangeSet；postFileEdit Hook 的失败不回滚已经成功的真实修改。
      if (finalValue.ok && isChanges(finalValue.output)) {
        // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
        await this.options.changes.record(turn, finalValue.output.files);
        // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
        await this.runHooks('postFileEdit', turn, signal, {
          // 设置 toolName 字段，把这一项数据传给目标对象、事件或函数。
          toolName: call.name,
          // 设置 callId 字段，把这一项数据传给目标对象、事件或函数。
          callId: call.id,
          // 设置 changedPaths 字段，把这一项数据传给目标对象、事件或函数。
          changedPaths: finalValue.output.files.map((file) => file.path),
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        });
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
      // Ledger 可能还未初始化，因此使用可选链 ?. 安全调用。
      const ledger = this.options.getLedger(turn.sessionId);
      // set_plan 同时更新 UI 事件和权威 Ledger。
      if (call.name === 'set_plan' && finalValue.ok && parsedData) {
        // 创建 steps 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
        const steps = (parsedData as { steps: PlanStep[] }).steps;
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        ledger?.setPlan(steps);
        // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
        await this.options.persistLedger(turn.sessionId);
        // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
        await this.options.emit({ type: 'plan.updated', timestamp: now(), turnId: turn.id, steps });
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
      // 只有被识别为验证命令的 run_command 才进入 ValidationRecord。
      if (
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        call.name === 'run_command' &&
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        isValidationCommand(String((parsedData as { command?: unknown } | undefined)?.command ?? ''))
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      ) {
        // 创建 command 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
        const command = String((parsedData as { command?: unknown } | undefined)?.command ?? '').slice(0, 300);
        // 创建 output 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
        const output = finalValue.output as { stderr?: unknown; stdout?: unknown } | undefined;
        // 创建 summary 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
        const summary = String(output?.stderr || output?.stdout || finalValue.error?.message || '').slice(-500);
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        ledger?.addValidation(command, finalValue.ok, summary);
        // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
        await this.options.persistLedger(turn.sessionId);
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (!finalValue.ok && finalValue.error && finalValue.error.code !== 'exploration_budget_exhausted') {
        // 探索预算耗尽属于收敛控制，不是真实工具错误，所以不写入 Ledger errors。
        ledger?.addError(finalValue.error.code, finalValue.error.message);
        // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
        await this.options.persistLedger(turn.sessionId);
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
      // 返回已经缓存、发事件并完成 Ledger 维护的最终结果。
      return finalValue;
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    };
    // 即使工具被状态机提前阻止，也要走 complete 保持事件和消息协议完整。
    if (forcedResult) return complete(forcedResult);
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (blockedByInterceptor) return complete(fail('interceptor_blocked', blockedByInterceptor));
    // 工具注册表不存在该名称时，不允许模型凭空调用任意函数。
    if (!definition) return complete(fail('unknown_tool', `未知工具 ${call.name}`));
    // safeParse 在运行时校验模型参数，不能只相信 TypeScript 编译期类型。
    // definition.parameters 是 Zod Schema；parsed.data 是校验和默认值处理后的安全参数。
    const parsed = definition.parameters.safeParse(call.args);
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (!parsed.success) return complete(fail('invalid_args', parsed.error.message));
    // 模式按 turnId 读取，避免全局模式热更新改变一个运行中 Turn 的既定权限。
    const turnMode = this.options.getMode(turn.id);
    // Plan 模式是硬只读：即使用户没有看到审批框，也绝不能执行副作用工具。
    if (turnMode === 'plan' && definition.sideEffect) {
      // 把计算完成的结果返回给当前方法的调用方。
      return complete(fail('plan_read_only', 'Plan 模式禁止写文件、运行命令或其他副作用操作'), parsed.data);
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // canAutoApprove 根据模式、工具风险和命令内容决定是否暂停等待用户。
    if (!this.options.policy.canAutoApprove(call, turnMode === 'plan' ? 'guided' : turnMode)) {
      // run_command 的风险取决于具体命令文本，其他工具使用定义时声明的固定风险。
      const risk =
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        call.name === 'run_command'
          // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          ? commandRisk(String((parsed.data as { command?: unknown }).command ?? ''))
          // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          : definition.risk;
      // 创建 approval 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
      const approval: Approval = {
        id: randomUUID(), // Renderer 后续用这个 id 回答
        turnId: turn.id, // 记录审批属于哪个 Turn
        call, // UI 展示即将执行的工具及参数
        // 设置 reason 字段，把这一项数据传给目标对象、事件或函数。
        reason:
          // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          turnMode === 'guided'
            // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
            ? 'Guided 模式要求在执行前确认'
            // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
            : `${definition.name} 可能产生文件或进程副作用`,
        risk, // low/medium/high 风险等级
        status: 'pending', // 当前仍在等待用户决定
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      };
      // UI 根据 waitingApproval 状态展示审批卡片。
      turn.status = 'waitingApproval';
      // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
      await this.options.emit(
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        { type: 'approval.requested', timestamp: now(), approval },
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        { kind: 'approval', id: itemId(), approval, createdAt: now() },
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      );
      // Promise 的 resolve 被存入 Map；Renderer 稍后调用 resolveApproval 才继续向下执行。
      const decision = await new Promise<{ allow: boolean; reason?: string }>((resolve) =>
        // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
        this.approvals.set(approval.id, { approval, resolve }),
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      );
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (!decision.allow) {
        // 审批已经结束，因此 Turn 恢复 running；工具结果本身标记为失败。
        turn.status = 'running';
        // 把计算完成的结果返回给当前方法的调用方。
        return complete(fail('approval_denied', decision.reason ?? '用户拒绝了此操作'), parsed.data);
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
      // 用户允许后恢复 running，再继续 Hook 和真实工具执行。
      turn.status = 'running';
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // preToolUse Hook 可以在工具真正运行前阻止它。
    const preHook = await this.runHooks('preToolUse', turn, signal, {
      // 设置 toolName 字段，把这一项数据传给目标对象、事件或函数。
      toolName: call.name,
      // 设置 callId 字段，把这一项数据传给目标对象、事件或函数。
      callId: call.id,
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (!preHook.ok) {
      // 把计算完成的结果返回给当前方法的调用方。
      return complete(fail('hook_blocked', preHook.error?.message ?? 'preToolUse Hook 阻止了工具执行'), parsed.data);
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // 保存实际执行起点，用于工具未自行提供耗时时补算 durationMs。
    const started = Date.now();
    // ToolContext 是工具能看到的最小环境：受限 workspace、取消信号和流式输出回调。
    const context: ToolContext = {
      // 设置 workspace 字段，把这一项数据传给目标对象、事件或函数。
      workspace: this.options.workspace,
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      signal,
      // 设置 onOutput 字段，把这一项数据传给目标对象、事件或函数。
      onOutput: (stream, text) => {
        // run_command 的 stdout/stderr 可以实时到达；void 表示不阻塞子进程读取。
        void this.options.emit({
          // 设置 type 字段，把这一项数据传给目标对象、事件或函数。
          type: 'tool.output',
          // 设置 timestamp 字段，把这一项数据传给目标对象、事件或函数。
          timestamp: now(),
          // 设置 callId 字段，把这一项数据传给目标对象、事件或函数。
          callId: call.id,
          // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          stream,
          // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          text,
          // 设置 sessionId 字段，把这一项数据传给目标对象、事件或函数。
          sessionId: turn.sessionId,
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        });
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      },
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    };
    // 通用超时使用子 AbortController，既能响应父 Turn 取消，也能主动停止支持 signal 的工具。
    // 子 controller 可同时响应父 Turn 取消和当前工具超时。
    const executionController = new AbortController();
    // 保存具名回调，finally 才能用同一个函数引用移除监听器。
    const abortExecution = () => executionController.abort();
    // 父 signal 一旦 abort，立即向真实工具传播取消。
    signal.addEventListener('abort', abortExecution, { once: true });
    // 工具只看到子 signal，这样超时不必取消整个父 Turn controller。
    context.signal = executionController.signal;
    // timer 保存定时器句柄，finally 中无论成功失败都可以清理。
    let timer: ReturnType<typeof setTimeout> | undefined;
    // timedOut 区分用户取消和定时器触发的取消。
    let timedOut = false;
    // value 在 try/catch 两条路径都会被赋值，然后统一执行后置拦截和 complete。
    let value: ToolResult;
    // 进入可能失败的操作区，异常会交给后面的 catch 或 finally 处理。
    try {
      // executeActual 把框架内置虚拟工具与注册表中的普通工具统一包装成 Promise。
      const executeActual = async (): Promise<ToolResult> => {
        // delegate 不调用注册表 execute，而是交给子 Agent 运行器。
        if (call.name === 'delegate') {
          // 把计算完成的结果返回给当前方法的调用方。
          return this.options.subagents.run(
            // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
            turn,
            // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
            parsed.data as { role: SubagentRole; task: string; focusPaths?: string[] },
            // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
            executionController.signal,
          // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
          );
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        }
        // ask_user 会暂停当前工具，等待 Renderer 提交答案。
        if (call.name === 'ask_user') {
          // 把计算完成的结果返回给当前方法的调用方。
          return this.askUser(turn, parsed.data as { question: string; choices?: string[] }, executionController.signal);
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        }
        // checkpoint 只登记意图；真正恢复点在 Turn 终态时统一聚合，避免一轮出现多个入口。
        if (call.name === 'checkpoint') return this.options.changes.createCheckpoint(turn);
        // read_artifact 从外置大结果中读取指定窗口。
        if (call.name === 'read_artifact') {
          // 创建 args 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
          const args = parsed.data as { artifactRef: string; offset?: number; limit?: number };
          // 创建 output 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
          const output = await this.options.artifacts.read(turn.sessionId, args.artifactRef, args.offset, args.limit);
          // 把计算完成的结果返回给当前方法的调用方。
          return { ok: true, output, durationMs: Date.now() - started };
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        }
        // review_changes 委托 review 子 Agent，并转换为结构化 findings。
        if (call.name === 'review_changes') {
          // 把计算完成的结果返回给当前方法的调用方。
          return this.runReview(turn, (parsed.data as { scope?: string }).scope ?? '最近一轮', executionController.signal);
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        }
        // compact_context 只设置请求标记；真正压缩必须由 TurnRunner 在整批结果写完后执行。
        if (call.name === 'compact_context') {
          // 把计算完成的结果返回给当前方法的调用方。
          return { ok: true, output: { requested: true, message: '将在当前工具组完成后压缩上下文' }, durationMs: 0 };
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        }
        // invoke 延迟调用注册工具，使互斥协调器可以包裹真实执行过程。
        const invoke = () => definition.execute(parsed.data, context);
        // 无副作用工具不需要工作区写锁，可以直接执行。
        if (!definition.sideEffect) return invoke();
        // write_file 的写入目标可从参数准确提取，因此只锁定该路径。
        if (call.name === 'write_file') {
          // 把计算完成的结果返回给当前方法的调用方。
          return this.options.mutations.runExclusive(
            // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
            [String((parsed.data as { path?: unknown }).path ?? '')],
            // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
            invoke,
          // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
          );
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        }
        // apply_patch 可能修改多文件，先从补丁文本提取全部路径再同时加锁。
        if (call.name === 'apply_patch') {
          // 创建 paths 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
          const paths = extractPatchPaths(String((parsed.data as { patch?: unknown }).patch ?? ''));
          // 把计算完成的结果返回给当前方法的调用方。
          return this.options.mutations.runExclusive(paths, invoke);
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        }
        // 命令和第三方副作用工具无法可靠预判全部写入路径，使用 workspace 独占锁。
        return this.options.mutations.runWorkspaceExclusive(invoke);
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      };
      // 工具可声明专用超时；未声明时默认限制为 60 秒。
      const timeoutMs = definition.timeoutMs ?? 60_000;
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (timeoutMs > 0) {
        // timeout Promise 与真实执行竞争，先完成者决定本次工具结果。
        const timeout = new Promise<ToolResult>((resolve) => {
          // setTimeout 到期后先中止真实工具，再返回标准 timeout 结果。
          timer = setTimeout(() => {
            // 标记超时，供 catch 判断 AbortError 的真实来源。
            timedOut = true;
            // 通知支持 AbortSignal 的工具停止工作。
            executionController.abort();
            // 解决竞争 Promise，使 execute() 不再继续等待。
            resolve(fail('timeout', `工具 ${call.name} 超过 ${timeoutMs}ms`));
          // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
          }, timeoutMs);
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        });
        // Promise.race 取真实工具和超时计时器中最先完成的一项。
        value = await Promise.race([executeActual(), timeout]);
      // 前面的条件均不成立时执行这个后备分支。
      } else {
        // timeoutMs <= 0 表示该工具明确禁用通用超时。
        value = await executeActual();
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
    // 捕获前面操作抛出的异常，把它转换成模块约定的安全结果。
    } catch (error) {
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      value = signal.aborted
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        ? fail('cancelled', '用户取消了任务')
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        : timedOut
          // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          ? fail('timeout', `工具 ${call.name} 执行超时`)
          // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          : fail('tool_exception', error instanceof Error ? error.message : '工具执行异常');
    // 无论成功、失败或取消都执行清理，防止临时状态和资源泄漏。
    } finally {
      // 工具提前完成时取消尚未触发的计时器，防止迟到的 abort。
      if (timer) clearTimeout(timer);
      // 移除父 signal 监听，避免长期 Turn 积累无用闭包。
      signal.removeEventListener('abort', abortExecution);
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // 父 Turn 已取消时不再执行后置拦截器，以免取消路径被替换成其他结果。
    if (!signal.aborted) {
      // afterToolCall 可以审查或改写实际 ToolResult。
      const afterIntercept = await this.options.interceptors.run(
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        { stage: 'afterToolCall', sessionId: turn.sessionId, turnId: turn.id, value },
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        signal,
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      );
      // block 把原结果替换为稳定的 interceptor_blocked 失败。
      if (afterIntercept.action === 'block') {
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        value = fail('interceptor_blocked', afterIntercept.reason);
      // 前一条件不成立时继续检查这个互斥条件。
      } else if (afterIntercept.action === 'replace') {
        // replace 使用拦截器给出的完整新结果。
        value = afterIntercept.value;
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // finish 成功前检查当前代码 revision 是否存在新鲜验证，并把警告放进结果。
    if (call.name === 'finish' && value.ok) {
      // 创建 ledger 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
      const ledger = this.options.getLedger(turn.sessionId);
      // 创建 warning 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
      const warning =
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        ledger?.requiresFreshValidation() && !ledger.hasFreshValidation()
          // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          ? '当前代码 revision 没有成功验证；任务允许完成，但结果应视为未验证或验证已过期。'
          // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          : undefined;
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      value = {
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        ...value,
        // 设置 output 字段，把这一项数据传给目标对象、事件或函数。
        output: {
          // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          ...(value.output as Record<string, unknown>),
          // 设置 verificationStatus 字段，把这一项数据传给目标对象、事件或函数。
          verificationStatus: warning ? 'warning' : 'verified',
          // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          ...(warning ? { warning } : {}),
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        },
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      };
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // 普通工具未提供 durationMs 时，用本地开始时间计算真实耗时。
    return complete({ ...value, durationMs: value.durationMs || Date.now() - started }, parsed.data);
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** review_changes 实际委派只读 review 子 Agent，再把结果转换成统一 finding 事件。 */
  private async runReview(turn: Turn, scope: string, signal: AbortSignal): Promise<ToolResult> {
    // 先通知 UI 审查开始，scope 是用户或模型指定的审查范围。
    await this.options.emit({ type: 'review.started', timestamp: now(), turnId: turn.id, scope });
    // 创建 result 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const result = await this.options.subagents.run(
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      turn,
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      { role: 'review', task: `请审查当前工作区变更。审查范围：${scope}` },
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      signal,
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    );
    // findings 是 UI 能稳定渲染的结构，不直接依赖子 Agent 的自由文本格式。
    const findings: ReviewFinding[] = [];
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (result.ok) {
      // 创建 output 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
      const output = result.output as { summary?: string } | undefined;
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (output?.summary) {
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        findings.push({
          // 设置 id 字段，把这一项数据传给目标对象、事件或函数。
          id: randomUUID(),
          // 设置 severity 字段，把这一项数据传给目标对象、事件或函数。
          severity: 'low',
          // 设置 title 字段，把这一项数据传给目标对象、事件或函数。
          title: 'Review 已完成',
          // 设置 path 字段，把这一项数据传给目标对象、事件或函数。
          path: scope,
          // 设置 explanation 字段，把这一项数据传给目标对象、事件或函数。
          explanation: output.summary.slice(0, 2000),
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        });
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
    // 前面的条件均不成立时执行这个后备分支。
    } else {
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      findings.push({
        // 设置 id 字段，把这一项数据传给目标对象、事件或函数。
        id: randomUUID(),
        // 设置 severity 字段，把这一项数据传给目标对象、事件或函数。
        severity: 'medium',
        // 设置 title 字段，把这一项数据传给目标对象、事件或函数。
        title: 'Review 未完成',
        // 设置 path 字段，把这一项数据传给目标对象、事件或函数。
        path: scope,
        // 设置 explanation 字段，把这一项数据传给目标对象、事件或函数。
        explanation: result.error?.message ?? '只读审查失败',
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      });
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // 每条 finding 单独发布，最后再发 completed 汇总事件。
    for (const finding of findings) {
      // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
      await this.options.emit({ type: 'review.finding', timestamp: now(), turnId: turn.id, finding });
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
    await this.options.emit({ type: 'review.completed', timestamp: now(), turnId: turn.id, findings });
    // 把计算完成的结果返回给当前方法的调用方。
    return {
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      ...result,
      // 设置 output 字段，把这一项数据传给目标对象、事件或函数。
      output: result.ok ? { ...(result.output as object), findings } : result.output,
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    };
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** ask_user 把 Turn 状态切为 waitingInput，并等待 Renderer 回答或 AbortSignal 取消。 */
  private async askUser(
    // 设置 turn 字段，把这一项数据传给目标对象、事件或函数。
    turn: Turn,
    // 设置 args 字段，把这一项数据传给目标对象、事件或函数。
    args: { question: string; choices?: string[] },
    // 设置 signal 字段，把这一项数据传给目标对象、事件或函数。
    signal: AbortSignal,
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  ): Promise<ToolResult> {
    // requestId 将 Renderer 的回答精确关联到这次提问。
    const requestId = randomUUID();
    // 状态切换后 UI 会显示输入卡片，并知道 Turn 尚未完成。
    turn.status = 'waitingInput';
    // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
    await this.options.emit({
      // 设置 type 字段，把这一项数据传给目标对象、事件或函数。
      type: 'user.input.requested',
      // 设置 timestamp 字段，把这一项数据传给目标对象、事件或函数。
      timestamp: now(),
      // 设置 turnId 字段，把这一项数据传给目标对象、事件或函数。
      turnId: turn.id,
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      requestId,
      // 设置 question 字段，把这一项数据传给目标对象、事件或函数。
      question: args.question,
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      ...(args.choices?.length ? { choices: args.choices } : {}),
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
    // AbortSignal 是浏览器/Node 标准取消协议；once: true 保证监听器只执行一次。
    const answer = await new Promise<string>((resolve) => {
      // 创建 onAbort 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
      const onAbort = () => {
        // 取消时删除等待项并提供一个占位答案，让 Promise 正常结束。
        this.pendingInputs.delete(requestId);
        // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        resolve('用户取消了输入');
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      };
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      signal.addEventListener('abort', onAbort, { once: true });
      // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
      this.pendingInputs.set(requestId, {
        // 设置 turnId 字段，把这一项数据传给目标对象、事件或函数。
        turnId: turn.id,
        // 设置 resolve 字段，把这一项数据传给目标对象、事件或函数。
        resolve: (value) => {
          // 正常回答后移除 abort 监听，防止未来误触发已完成的 Promise。
          signal.removeEventListener('abort', onAbort);
          // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          resolve(value);
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        },
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      });
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
    // 无论回答或取消，离开等待点后先把状态恢复为 running。
    turn.status = 'running';
    // 把计算完成的结果返回给当前方法的调用方。
    return signal.aborted
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      ? fail('cancelled', '用户取消了输入')
      // 执行 tool-call-executor.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      : { ok: true, output: { answer }, durationMs: 0 };
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}
