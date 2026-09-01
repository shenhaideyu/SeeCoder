// 从共享协议包导入拦截器可能检查或改写的模型消息、工具调用、工具结果和 Turn 类型。
import type { ModelMessage, ToolCall, ToolResult, Turn } from '@seecoder/protocol';

// InterceptStage 列出拦截器能够介入的全部生命周期位置。
export type InterceptStage =
  // userInput 表示用户原始输入刚进入 Agent、还没有创建 Turn。
  | 'userInput'
  // beforeTurn 表示 Turn 已准备创建，但主循环尚未开始。
  | 'beforeTurn'
  // beforeModelCall 表示模型请求已经组装好、还没有发往 Provider。
  | 'beforeModelCall'
  // messageDelta 表示模型刚产生一段流式文字。
  | 'messageDelta'
  // beforeToolCall 表示工具参数已解析、真实工具尚未执行。
  | 'beforeToolCall'
  // afterToolCall 表示工具已经得到结果、结果尚未写入历史。
  | 'afterToolCall';

// InterceptContext 把当前阶段、关联标识和可检查数据一起交给拦截器。
export interface InterceptContext<T> {
  // stage 告诉拦截器当前处于哪个生命周期位置。
  stage: InterceptStage;
  // sessionId 用来识别这次拦截属于哪条长期会话。
  sessionId: string;
  // turnId 在 Turn 创建之后存在；用户输入阶段可能还没有它。
  turnId?: string;
  // value 是当前阶段的真实数据，泛型 T 会随阶段变化。
  value: T;
} // 结束拦截上下文接口。

// InterceptResult 是拦截器允许返回的三种控制决定。
export type InterceptResult<T> =
  // continue 表示不修改数据，让后续拦截器和主流程继续。
  | { action: 'continue' }
  // replace 表示用新的 value 替换当前数据，然后继续执行。
  | { action: 'replace'; value: T }
  // block 表示停止当前阶段，并把可读原因交给上层错误处理。
  | { action: 'block'; reason: string };

// AgentInterceptor 描述一个可以注入流水线的拦截器对象。
export interface AgentInterceptor {
  // id 是日志和错误信息中识别拦截器的稳定名称。
  id: string;
  // timeoutMs 允许单个拦截器覆盖默认两秒超时。
  timeoutMs?: number;
  // intercept 接收当前上下文和取消信号，可以继续、替换、阻止或不返回决定。
  intercept<T>(context: InterceptContext<T>, signal: AbortSignal): Promise<InterceptResult<T> | void>;
} // 结束拦截器接口。

// InterceptValue 限制流水线中允许被拦截的数据，避免任意类型绕过类型检查。
export type InterceptValue = string | Turn | ModelMessage[] | ToolCall | ToolResult;

// AgentInterceptorPipeline 负责按注册顺序运行拦截器，并统一处理取消、超时和异常。
export class AgentInterceptorPipeline {
  // 构造函数保存拦截器数组；调用方不传时使用空数组，相当于直接放行。
  constructor(private readonly interceptors: AgentInterceptor[] = []) {}

  // run 对某一阶段的数据执行完整拦截链，并返回最终控制决定。
  async run<T extends InterceptValue>(
    // context 保存本阶段名称、Session、Turn 和初始数据。
    context: InterceptContext<T>,
    // parentSignal 由 TurnRunner 提供，用户取消 Turn 时会触发它。
    parentSignal: AbortSignal,
  // Promise 最终返回继续、替换或阻止三种结果之一。
  ): Promise<InterceptResult<T>> {
    // value 保存经过前面拦截器逐步替换后的当前值。
    let value = context.value;
    // 按注册顺序运行，保证拦截器行为可预测。
    for (const interceptor of this.interceptors) {
      // 父任务已经取消时不再调用用户代码，直接形成受控阻止结果。
      if (parentSignal.aborted) return { action: 'block', reason: '操作已取消' };
      // 每个拦截器使用独立控制器，超时只取消当前拦截器。
      const controller = new AbortController();
      // abort 把父 Turn 的取消转发给当前拦截器。
      const abort = () => controller.abort();
      // once 确保父信号最多触发一次当前取消回调。
      parentSignal.addEventListener('abort', abort, { once: true });
      // 超时至少为 100 毫秒；未配置时默认两秒，防止扩展永久卡住主循环。
      const timeoutMs = Math.max(100, interceptor.timeoutMs ?? 2_000);
      // timer 保存定时器句柄，finally 中需要清理它。
      let timer: ReturnType<typeof setTimeout> | undefined;
      // try 包住第三方拦截器代码，把异常转换为可解释的 block。
      try {
        // timeout Promise 在期限到达时主动取消拦截器并返回 block。
        const timeout = new Promise<InterceptResult<T>>((resolve) => {
          // setTimeout 到期后执行取消和结果解析。
          timer = setTimeout(() => {
            // 通知支持 AbortSignal 的拦截器停止后台工作。
            controller.abort();
            // 用稳定文本返回超时来源，便于用户和日志定位。
            resolve({ action: 'block', reason: `Interceptor ${interceptor.id} 超时` });
          // timeoutMs 决定本次定时器等待多久。
          }, timeoutMs);
        }); // 完成超时 Promise 的创建。
        // execution Promise 包装真实拦截器，兼容它返回 void 的情况。
        const execution = Promise.resolve(
          // 展开旧 context 并放入最新 value，让后一个拦截器看到前一个替换结果。
          interceptor.intercept({ ...context, value }, controller.signal),
        // 没有显式结果时按 continue 处理，降低简单观察型拦截器的实现成本。
        ).then((result) => result ?? ({ action: 'continue' } as const));
        // Promise.race 取真实执行和超时中最先完成的一个。
        const result = await Promise.race([execution, timeout]);
        // block 是终止决定，不再运行后续拦截器。
        if (result.action === 'block') return result;
        // replace 更新当前值，下一拦截器将继续处理这个新值。
        if (result.action === 'replace') value = result.value;
      // 捕获拦截器同步或异步抛出的异常。
      } catch (error) {
        // 异常不会直接冲破 Agent 循环，而是转换为稳定的阻止结果。
        return {
          // action 固定为 block，避免在扩展失败后继续执行危险动作。
          action: 'block',
          // Error 使用 message；非 Error 值统一显示为未知错误。
          reason: `Interceptor ${interceptor.id} 执行失败：${error instanceof Error ? error.message : '未知错误'}`,
        }; // 返回异常对应的 block 结果。
      // 无论成功、阻止还是异常，都必须释放定时器和事件监听器。
      } finally {
        // 定时器已经创建时取消它，防止执行结束后再次触发。
        if (timer) clearTimeout(timer);
        // 移除父信号监听，避免长期 Turn 累积无用闭包。
        parentSignal.removeEventListener('abort', abort);
      } // 结束当前拦截器的资源清理。
    } // 结束拦截器顺序循环。
    // 从未替换时返回 continue；发生过替换时把最终 value 返回给调用方。
    return value === context.value ? { action: 'continue' } : { action: 'replace', value };
  } // 结束 run 方法。
} // 结束 AgentInterceptorPipeline 类。
