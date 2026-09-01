/**
 * SubagentRunner 运行只读的 explore/review 子 Agent。
 * 子 Agent 有自己的短消息历史和迭代循环，但不能写文件、运行命令或继续委派，
 * 因而主 Agent 始终是唯一写入者，修改顺序和审计轨迹保持确定。
 */
// randomUUID 为子 Agent 和持久化 Item 生成唯一标识。
import { randomUUID } from 'node:crypto';
// ModelConfig 提供子 Agent 使用的模型名称等配置。
import type { ModelConfig } from '@seecoder/model';
// 共享协议类型描述事件、消息、Provider、角色、可观察状态、结果和父 Turn。
import type { AgentEvent, Item, ModelMessage, ModelProvider, SubagentRole, SubagentState, ToolResult, Turn } from '@seecoder/protocol';
// ToolRegistry 用于从主注册表筛选允许子 Agent 使用的只读工具。
import type { ToolRegistry } from '@seecoder/tools';
// 导入统一错误、失败结果、模型工具 Schema 和流式错误类型。
import { AgentRunError, fail, toolSchemas, type AgentErrorLike } from './policy.js';

// 创建 now 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
const now = () => new Date().toISOString();
// itemId 为 subagent Item 创建独立标识。
const itemId = () => randomUUID();

// 声明一个对象结构类型，明确调用方必须提供哪些字段。
interface SubagentRunnerOptions {
  /** 子 Agent 允许读取的工作区。 */
  workspace: string;
  /** 从中筛选只读工具。 */
  registry: ToolRegistry;
  /** 动态读取当前模型 Provider。 */
  getProvider: () => ModelProvider;
  /** 动态读取当前模型参数。 */
  getModel: () => ModelConfig;
  /** 将子 Agent 状态写入主事件流。 */
  emit: (event: AgentEvent, item?: Item) => Promise<void>;
} // 结束子 Agent 运行器依赖接口。

// SubagentRunner 管理并发子 Agent、独立循环、只读工具和取消传播。
export class SubagentRunner {
  // children 记录正在运行的子 Agent；AbortController 用于传播取消信号。
  private readonly children = new Map<string, { controller: AbortController; parentTurnId: string }>();

  // 构造函数保存共享依赖，但每次 run 都建立独立消息和控制器。
  constructor(private readonly options: SubagentRunnerOptions) {}

  /** 只取消属于指定父 Turn 的子 Agent。 */
  cancelTurn(turnId: string): void {
    // 只遍历当前运行 children，并取消父 Turn 匹配的控制器。
    for (const child of this.children.values()) if (child.parentTurnId === turnId) child.controller.abort();
  } // 结束指定父 Turn 的子 Agent 取消。

  /** 工作区切换或应用退出时取消所有子 Agent。 */
  cancelAll(): void {
    // Workspace 切换时所有子 Agent 都不能继续读取旧项目。
    for (const child of this.children.values()) child.controller.abort();
  } // 结束全部子 Agent 取消。

  /** 模型工具参数是 JSON 字符串；解析失败时返回空对象，让后续 Schema 给出规范错误。 */
  private parseArgs(raw: string): unknown {
    // 进入可能失败的操作区，异常会交给后面的 catch 或 finally 处理。
    try {
      // 非空字符串按 JSON 解析，空字符串代表无参数对象。
      return raw ? JSON.parse(raw) : {};
    // 捕获前面操作抛出的异常，把它转换成模块约定的安全结果。
    } catch {
      // JSON 语法错误不在这里抛出，由后续 Zod 返回统一 invalid_args。
      return {};
    } // 结束参数解析异常降级。
  } // 结束工具参数解析方法。

  /** 创建一个只读子 Agent，并把最终摘要包装成主 Agent 可处理的 ToolResult。 */
  async run(turn: Turn, args: { role: SubagentRole; task: string; focusPaths?: string[] }, parentSignal: AbortSignal): Promise<ToolResult> {
    // 限制并发可以控制 Token 和磁盘读取压力。
    if (this.children.size >= 2) return fail('subagent_limit', '当前最多同时运行两个只读子 Agent');
    const started = Date.now(); // 用于计算子 Agent 总耗时
    const id = randomUUID(); // 子 Agent 唯一 id
    const controller = new AbortController(); // 独立取消控制器
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.children.set(id, { controller, parentTurnId: turn.id });
    // 父 Turn 取消时，子 Agent 必须跟着取消，不能成为后台“僵尸任务”。
    parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
    // state 是发送给 UI 的可观察运行状态，不包含模型私有思维链。
    const state: SubagentState = {
      id, // 当前子 Agent id
      parentTurnId: turn.id, // 所属主 Turn
      role: args.role, // explore 或 review
      task: args.task, // 主 Agent 委派的任务描述
      status: 'running', // 初始运行状态
      iteration: 0, // 尚未调用模型
      durationMs: 0, // 初始耗时
      inputTokens: 0, // 累计输入 Token
      outputTokens: 0, // 累计输出 Token
      currentAction: '调用模型', // UI 当前动作说明
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    };
    // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
    await this.options.emit({ type: 'subagent.updated', timestamp: now(), child: state }, { kind: 'subagent', id: itemId(), state, createdAt: now() });
    // 进入可能失败的操作区，异常会交给后面的 catch 或 finally 处理。
    try {
      // 子 Agent 使用独立消息数组，不会污染主 Agent 的模型对话协议。
      const messages: ModelMessage[] = [
        // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        {
          role: 'system', // 限制子 Agent 权限的系统消息
          // 设置 content 字段，把这一项数据传给目标对象、事件或函数。
          content: `你是 SeeCoder 的只读 ${args.role} 子 Agent。只能读取、搜索和查看 Diff，不能写文件、运行命令或委派其他 Agent。返回简洁的结论、证据文件和风险。工作区：${this.options.workspace}`,
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        },
        { role: 'user', content: args.task }, // 实际委派任务
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      ];
      // 创建 summary 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
      let summary = '';
      // evidence 收集有限的结构化搜索命中，供主 Agent 核对来源。
      const evidence: Array<{ path?: string; detail: string }> = [];
      // 最多六轮模型调用，防止只读探索无限循环。
      for (let iteration = 0; iteration < 6; iteration += 1) {
        // 状态对用户从 1 开始显示，所以保存 iteration + 1。
        state.iteration = iteration + 1;
        // UI 在每轮模型请求开始时显示统一动作说明。
        state.currentAction = '调用模型';
        // 白名单只保留四个无副作用工具；definition.sideEffect 还会再做第二重检查。
        // 每一轮重新读取 registry，支持工具注册表动态变化。
        const allowed = this.options.registry.list().filter((tool) => ['list_files', 'read_file', 'search_text', 'git_diff'].includes(tool.name));
        // calls 按 callId 聚合流式到达的工具名称和参数片段。
        const calls = new Map<string, { name: string; args: string }>();
        // text 累积本轮子 Agent 的自然语言输出。
        let text = '';
        // modelError 暂存流中的 Provider 错误，流结束后统一抛出。
        let modelError: AgentErrorLike | undefined;
        // 流式工具调用的 name/args 可能分片到达，因此按 callId 累积。
        for await (const event of this.options.getProvider().stream(
          // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          {
            // 子 Agent 使用自己的短消息历史。
            messages,
            // 只把 allowed 白名单工具暴露给模型。
            tools: allowed.map((tool) => ({
              // OpenAI compatible Function Tool 的固定类型。
              type: 'function' as const,
              // function 内保存模型选择工具所需的名称、说明和参数结构。
              function: {
                // name 必须与注册表中的真实工具名一致。
                name: tool.name,
                // description 帮助模型判断什么时候使用该工具。
                description: tool.description,
                // parameters 使用中央 Schema；缺失时退回普通对象。
                parameters: toolSchemas[tool.name] ?? { type: 'object' },
              }, // 结束单个 Function Tool 定义。
            })), // 结束只读工具映射。
            // 每轮读取当前模型名称，支持设置页热切换。
            model: this.options.getModel().model,
            // 低温度减少只读调查结论的随机变化。
            temperature: 0.1,
            // 子 Agent 单轮最多输出三千 token。
            maxOutputTokens: 3000,
          }, // 结束子 Agent 模型请求。
          // 独立 signal 同时响应父 Turn 取消。
          controller.signal,
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        )) {
          // 检查该条件；只有条件成立时才执行紧随其后的分支。
          if (event.type === 'textDelta') text += event.text;
          // 检查该条件；只有条件成立时才执行紧随其后的分支。
          if (event.type === 'toolCallDelta') {
            // 创建 current 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
            const current = calls.get(event.callId) ?? { name: event.name ?? '', args: '' };
            // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
            current.name = event.name ?? current.name;
            // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
            current.args += event.argsDelta;
            // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
            calls.set(event.callId, current);
          // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
          }
          // 检查该条件；只有条件成立时才执行紧随其后的分支。
          if (event.type === 'usage') {
            // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
            state.inputTokens = (state.inputTokens ?? 0) + event.inputTokens;
            // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
            state.outputTokens = (state.outputTokens ?? 0) + event.outputTokens;
          // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
          }
          // 检查该条件；只有条件成立时才执行紧随其后的分支。
          if (event.type === 'error') modelError = event;
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        }
        // 检查该条件；只有条件成立时才执行紧随其后的分支。
        if (modelError) throw new AgentRunError(modelError.code, modelError.message, modelError.retryable);
        // assistant tool_calls 必须原样写入历史，下一条 tool 消息才能合法配对。
        const parsedCalls = [...calls.entries()].map(([callId, raw]) => ({
          // 设置 id 字段，把这一项数据传给目标对象、事件或函数。
          id: callId,
          // 设置 name 字段，把这一项数据传给目标对象、事件或函数。
          name: raw.name,
          // 设置 arguments 字段，把这一项数据传给目标对象、事件或函数。
          arguments: raw.args,
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        }));
        // 每轮自然语言追加到最终摘要；没有文本时不改变字符串。
        if (text) summary += text;
        // 检查该条件；只有条件成立时才执行紧随其后的分支。
        if (text || parsedCalls.length)
          // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          messages.push({
            // 设置 role 字段，把这一项数据传给目标对象、事件或函数。
            role: 'assistant',
            // 设置 content 字段，把这一项数据传给目标对象、事件或函数。
            content: text,
            // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
            ...(parsedCalls.length ? { toolCalls: parsedCalls } : {}),
          // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
          });
        // 有工具时展示工具名称，否则表明模型正在整理最终结论。
        state.currentAction = parsedCalls.length ? parsedCalls.map((call) => call.name).join('、') : '整理结论';
        // durationMs 每轮更新，UI 可以显示实时累计耗时。
        state.durationMs = Date.now() - started;
        // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
        await this.options.emit({
          // 设置 type 字段，把这一项数据传给目标对象、事件或函数。
          type: 'subagent.updated',
          // 设置 timestamp 字段，把这一项数据传给目标对象、事件或函数。
          timestamp: now(),
          // 设置 child 字段，把这一项数据传给目标对象、事件或函数。
          child: { ...state },
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        });
        // 没有工具调用代表模型已经给出最终结论，可以提前结束循环。
        if (!calls.size) break;
        // 逐个执行本轮聚合完成的只读工具调用。
        for (const [callId, raw] of calls) {
          // 通过工具名从主注册表查真实定义。
          const definition = this.options.registry.get(raw.name);
          // value 保存成功或失败的统一工具结果。
          let value: ToolResult;
          // 即使模型伪造了工具名，也只能执行注册表中明确允许且无副作用的定义。
          if (!definition || definition.sideEffect || !allowed.some((tool) => tool.name === raw.name)) value = fail('subagent_tool_denied', `子 Agent 不允许调用 ${raw.name || '未知工具'}`);
          // 即使参数 JSON 能解析，也必须通过该工具自己的 Zod Schema。
          else {
            // 创建 parsed 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
            const parsed = definition.parameters.safeParse(this.parseArgs(raw.args));
            // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
            value = parsed.success
              // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
              ? await definition.execute(parsed.data, {
                  // 设置 workspace 字段，把这一项数据传给目标对象、事件或函数。
                  workspace: this.options.workspace,
                  // 设置 signal 字段，把这一项数据传给目标对象、事件或函数。
                  signal: controller.signal,
                // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
                })
              // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
              : fail('invalid_args', parsed.error.message);
          // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
          }
          // Tool Result 必须带 toolCallId，供下一轮模型识别它回答的是哪个调用。
          messages.push({
            // 设置 role 字段，把这一项数据传给目标对象、事件或函数。
            role: 'tool',
            // 设置 content 字段，把这一项数据传给目标对象、事件或函数。
            content: JSON.stringify(value),
            // 设置 toolCallId 字段，把这一项数据传给目标对象、事件或函数。
            toolCallId: callId,
            // 设置 toolName 字段，把这一项数据传给目标对象、事件或函数。
            toolName: raw.name,
          // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
          });
          // 只从数组型输出提取有限证据；例如 search_text 的命中列表。
          if (value.ok && Array.isArray(value.output))
            // 遍历当前集合或异步事件流，并按顺序处理其中每一项。
            for (const item of value.output.slice(0, 10))
              // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
              evidence.push({
                // 设置 path 字段，把这一项数据传给目标对象、事件或函数。
                path: typeof item.path === 'string' ? item.path : undefined,
                // 设置 detail 字段，把这一项数据传给目标对象、事件或函数。
                detail: JSON.stringify(item),
              // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
              });
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        }
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
      // 只保存有限长度的摘要和证据，避免子 Agent 结果反过来撑爆主上下文。
      state.status = 'completed';
      // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      state.summary = summary.slice(-8000);
      // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      state.evidence = evidence.slice(0, 20);
      // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      state.durationMs = Date.now() - started;
      // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      state.currentAction = '完成';
      // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
      await this.options.emit({ type: 'subagent.updated', timestamp: now(), child: state });
      // 最终成功结果回到主 Agent 的 delegate/review_changes 工具调用。
      return {
        // 设置 ok 字段，把这一项数据传给目标对象、事件或函数。
        ok: true,
        // 设置 output 字段，把这一项数据传给目标对象、事件或函数。
        output: { role: args.role, summary: state.summary, evidence: state.evidence },
        // 设置 durationMs 字段，把这一项数据传给目标对象、事件或函数。
        durationMs: 0,
      }; // 完成子 Agent 成功 ToolResult 构造。
    // 捕获前面操作抛出的异常，把它转换成模块约定的安全结果。
    } catch (error) {
      // 取消和普通失败都转成 ToolResult，主 Turn 可以按普通工具失败继续处理。
      state.status = controller.signal.aborted ? 'cancelled' : 'failed';
      // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      state.summary = error instanceof Error ? error.message : '子 Agent 失败';
      // AgentRunError 有稳定 code；其他异常统一标记 subagent_failed。
      state.errorCode = error instanceof AgentRunError ? error.code : 'subagent_failed';
      // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      state.durationMs = Date.now() - started;
      // 执行 subagent-runner.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      delete state.currentAction;
      // 等待异步操作完成，保证状态、事件或磁盘结果就绪后再继续。
      await this.options.emit({ type: 'subagent.updated', timestamp: now(), child: state });
      // 把计算完成的结果返回给当前方法的调用方。
      return fail('subagent_failed', state.summary);
    // 无论成功、失败或取消都执行清理，防止临时状态和资源泄漏。
    } finally {
      // 无论成功、失败还是取消，都从并发计数中移除。
      this.children.delete(id);
    } // 结束子 Agent 并发计数清理。
  } // 结束子 Agent run 方法。
} // 结束 SubagentRunner 类。
