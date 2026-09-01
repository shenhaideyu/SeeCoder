// createHash 为文件内容生成稳定 SHA-256，用于 Checkpoint 冲突检测。
import { createHash } from 'node:crypto';
// z 是 Zod 运行时校验入口，用来验证摘要模型真正返回的 JSON。
import { z } from 'zod';
// ToolResult 是所有工具成功或失败时必须返回的统一协议结构。
import type { ToolResult } from '@seecoder/protocol';

// toolSchemas 把每个工具的名称映射为发送给模型的 JSON Schema。
export const toolSchemas: Record<string, unknown> = {
  // list_files 用于浏览目录，可以指定起始路径和递归深度。
  list_files: {
    // 参数整体必须是 JSON 对象。
    type: 'object',
    // path 是可选目录，depth 是可选整数深度。
    properties: { path: { type: 'string' }, depth: { type: 'integer' } },
  }, // 结束 list_files 参数定义。
  // read_file 读取一个文件的全部或指定行区间。
  read_file: {
    // 参数整体必须是 JSON 对象。
    type: 'object',
    // path 缺失时模型参数不完整，必须拒绝。
    required: ['path'],
    // 三个字段分别表示文件路径、起始行和结束行。
    properties: {
      // path 必须是字符串形式的 Workspace 相对路径。
      path: { type: 'string' },
      // startLine 必须是整数，并由真实工具进一步校验范围。
      startLine: { type: 'integer' },
      // endLine 必须是整数，并且应不小于起始行。
      endLine: { type: 'integer' },
    }, // 结束 read_file 字段定义。
  }, // 结束 read_file 参数定义。
  // search_text 在 Workspace 中搜索文本并返回匹配位置。
  search_text: {
    // 参数整体必须是对象。
    type: 'object',
    // query 是执行搜索不可缺少的字段。
    required: ['query'],
    // properties 描述搜索词、目录、文件过滤和结果上限。
    properties: {
      // query 是交给搜索工具的文本或模式。
      query: { type: 'string' },
      // path 可把搜索范围缩小到一个目录或文件。
      path: { type: 'string' },
      // glob 可进一步按文件名模式过滤。
      glob: { type: 'string' },
      // maxResults 控制最多返回多少条命中。
      maxResults: { type: 'integer' },
    }, // 结束 search_text 字段定义。
  }, // 结束 search_text 参数定义。
  // write_file 用完整 content 创建或覆盖一个文件。
  write_file: {
    // 参数整体必须是对象。
    type: 'object',
    // 路径和正文缺一不可。
    required: ['path', 'content'],
    // path 是目标位置，content 是新的完整文本。
    properties: { path: { type: 'string' }, content: { type: 'string' } },
  }, // 结束 write_file 参数定义。
  // apply_patch 接收一段补丁文本，由补丁工具解析多个文件变化。
  apply_patch: {
    // 参数整体必须是对象。
    type: 'object',
    // patch 是唯一必需字段。
    required: ['patch'],
    // patch 必须是字符串形式的统一补丁。
    properties: { patch: { type: 'string' } },
  }, // 结束 apply_patch 参数定义。
  // run_command 在受控工作目录中启动命令。
  run_command: {
    // 参数整体必须是对象。
    type: 'object',
    // command 缺失时没有可执行内容。
    required: ['command'],
    // properties 描述命令正文、工作目录和超时。
    properties: {
      // command 是交给当前平台 Shell 的命令字符串。
      command: { type: 'string' },
      // cwd 是 Workspace 内的可选子目录。
      cwd: { type: 'string' },
      // timeoutMs 是命令最长运行毫秒数。
      timeoutMs: { type: 'integer' },
    }, // 结束 run_command 字段定义。
  }, // 结束 run_command 参数定义。
  // git_diff 只读取 Git 差异，可以选择路径范围。
  git_diff: {
    // 参数整体必须是对象。
    type: 'object',
    // path 可选，缺省时查看整个仓库的差异。
    properties: { path: { type: 'string' } },
  }, // 结束 git_diff 参数定义。
  // set_plan 把模型生成的任务步骤同步到 UI 和 Ledger。
  set_plan: {
    // 参数整体必须是对象。
    type: 'object',
    // steps 数组是更新计划的核心数据。
    required: ['steps'],
    // properties 只定义 steps 字段。
    properties: {
      // steps 保存按顺序排列的任务步骤。
      steps: {
        // type=array 要求模型返回 JSON 数组。
        type: 'array',
        // items 定义数组中每个步骤对象的结构。
        items: {
          // 每一步必须是对象。
          type: 'object',
          // id、显示文字和状态缺一不可。
          required: ['id', 'label', 'status'],
          // properties 定义单个计划步骤的三个字段。
          properties: {
            // id 用于后续更新时稳定识别同一步骤。
            id: { type: 'string' },
            // label 是展示给用户的简短任务说明。
            label: { type: 'string' },
            // status 只能取四个已定义的生命周期值。
            status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed'] },
          }, // 结束单个步骤字段定义。
        }, // 结束 steps 元素定义。
      }, // 结束 steps 数组定义。
    }, // 结束 set_plan 字段定义。
  }, // 结束 set_plan 参数定义。
  // delegate 把只读探索或审查任务交给子 Agent。
  delegate: {
    // 参数整体必须是对象。
    type: 'object',
    // role 和 task 是创建子 Agent 的必需信息。
    required: ['role', 'task'],
    // properties 描述角色、任务正文和可选关注路径。
    properties: {
      // role 限制为 explore 或 review，不能伪造写入角色。
      role: { type: 'string', enum: ['explore', 'review'] },
      // task 是交给子 Agent 的明确目标。
      task: { type: 'string' },
      // focusPaths 可把子 Agent 阅读范围集中到若干路径。
      focusPaths: { type: 'array', items: { type: 'string' } },
    }, // 结束 delegate 字段定义。
  }, // 结束 delegate 参数定义。
  // finish 让模型显式声明任务结束并提供验证清单。
  finish: {
    // 参数整体必须是对象。
    type: 'object',
    // summary 是最终结果不可缺少的字段。
    required: ['summary'],
    // properties 描述总结和实际执行过的验证命令。
    properties: {
      // summary 是展示给用户的最终简短结论。
      summary: { type: 'string' },
      // verification 是真实验证命令或检查项数组。
      verification: { type: 'array', items: { type: 'string' } },
    }, // 结束 finish 字段定义。
  }, // 结束 finish 参数定义。
  // read_files 一次批量读取多个已知文件，减少模型往返轮次。
  read_files: {
    // 参数整体必须是对象。
    type: 'object',
    // paths 数组是必需字段。
    required: ['paths'],
    // paths 中每项都必须是字符串路径。
    properties: { paths: { type: 'array', items: { type: 'string' } } },
  }, // 结束 read_files 参数定义。
  // read_artifact 分页读取先前外置的大型工具结果。
  read_artifact: {
    // 参数整体必须是对象。
    type: 'object',
    // artifactRef 用来定位所属 Session 的结果文件。
    required: ['artifactRef'],
    // properties 描述引用、起始偏移和最大读取量。
    properties: {
      // artifactRef 是工具结果中返回的不可猜测引用。
      artifactRef: { type: 'string' },
      // offset 表示从第几个字符开始读取。
      offset: { type: 'integer' },
      // limit 表示本次最多返回多少字符。
      limit: { type: 'integer' },
    }, // 结束 read_artifact 字段定义。
  }, // 结束 read_artifact 参数定义。
  // ask_user 在缺少关键决定时暂停 Turn 并询问用户。
  ask_user: {
    // 参数整体必须是对象。
    type: 'object',
    // question 是必须展示给用户的正文。
    required: ['question'],
    // properties 描述问题和可选候选答案。
    properties: {
      // question 应是清晰且可以直接回答的问题。
      question: { type: 'string' },
      // choices 可提供有限选项，界面会把它们展示为按钮。
      choices: { type: 'array', items: { type: 'string' } },
    }, // 结束 ask_user 字段定义。
  }, // 结束 ask_user 参数定义。
  // checkpoint 不需要模型参数，只创建当前恢复标记。
  checkpoint: { type: 'object', properties: {} },
  // review_changes 可指定审查范围；缺省时审查当前变化。
  review_changes: { type: 'object', properties: { scope: { type: 'string' } } },
  // compact_context 没有参数，用于显式请求压缩历史上下文。
  compact_context: { type: 'object', properties: {} },
}; // 结束全部工具 JSON Schema 映射。

// semanticSummarySchema 严格校验摘要模型输出，并为每类文本设置大小上限。
export const semanticSummarySchema = z.object({
  // userIntent 保存用户当前主要目标，最多四千字符。
  userIntent: z.string().max(4000),
  // requirements 保存最多三十条仍然有效的要求。
  requirements: z.array(z.string().max(1000)).max(30),
  // activeDecisions 保存最多三十条当前采用的决定。
  activeDecisions: z.array(z.string().max(1000)).max(30),
  // supersededDecisions 保存已被替代的旧决定，防止模型重新采用它们。
  supersededDecisions: z.array(z.string().max(1000)).max(30),
  // completedWork 保存最多五十条已经完成的工作。
  completedWork: z.array(z.string().max(1000)).max(50),
  // unresolvedQuestions 保存仍需回答的开放问题。
  unresolvedQuestions: z.array(z.string().max(1000)).max(30),
  // narrative 是保持对话连续性的自然语言摘要，最多八千字符。
  narrative: z.string().max(8000),
}); // 结束结构化摘要 Schema。

// AgentErrorLike 是可以向 Turn 状态机传播的标准模型错误形状。
export interface AgentErrorLike {
  // code 供程序分类、测试断言和界面映射。
  code: string;
  // message 是展示或记录的可读错误原因。
  message: string;
  // retryable 告诉上层重试是否可能成功。
  retryable: boolean;
} // 结束标准错误接口。

// AgentRunError 在普通 Error 基础上增加机器可读 code 和 retryable 标志。
export class AgentRunError extends Error {
  // 构造函数同时初始化 Error 正文和 Agent 专用字段。
  constructor(
    // readonly 参数属性自动创建 this.code。
    readonly code: string,
    // message 传给标准 Error，最终出现在 stack 和用户错误中。
    message: string,
    // readonly 参数属性自动创建 this.retryable。
    readonly retryable: boolean,
  // 构造函数本身不返回值。
  ) {
    // 调用父类后 this 才能作为标准 Error 使用。
    super(message);
    // 明确类名，让日志区分 AgentRunError 和普通 Error。
    this.name = 'AgentRunError';
  } // 结束 AgentRunError 构造函数。
} // 结束 AgentRunError 类。

// fail 快速构造一个不可重试的标准工具失败结果。
export function fail(code: string, message: string): ToolResult {
  // durationMs 为零表示失败发生在真实工具计时之外，例如权限或参数检查。
  return { ok: false, error: { code, message, retryable: false }, durationMs: 0 };
} // 结束失败结果辅助函数。

// isExplorationCall 判断一次调用是否只在收集信息，用于限制无休止探索。
export function isExplorationCall(name: string, args: unknown): boolean {
  // 列表、读取、搜索、Diff 和只读子 Agent 都直接归类为探索。
  if (['list_files', 'read_file', 'read_files', 'search_text', 'git_diff', 'delegate', 'review_changes'].includes(name)) return true;
  // 除 run_command 外的工具不是需要进一步分析的只读命令。
  if (name !== 'run_command') return false;
  // 从 unknown 参数中安全提取 command，缺失时使用空字符串。
  const command = String((args as { command?: unknown } | undefined)?.command ?? '');
  // 只有五类只读 Git 子命令算探索，其他 Shell 命令视为实际动作。
  return /^\s*git\s+(status|diff|log|show|branch)\b/i.test(command);
} // 结束探索调用判断函数。

// hash 对文件内容计算稳定 SHA-256；null 继续表示文件不存在。
export function hash(value: string | null): string | null {
  // 已删除文件不生成摘要，其他文本按 UTF-8 更新哈希并输出十六进制。
  return value === null ? null : createHash('sha256').update(value).digest('hex');
} // 结束文件哈希函数。

// isChanges 是类型守卫，判断未知工具输出是否携带标准文件变化数组。
export function isChanges(value: unknown): value is {
  // kind 固定为 changes，便于调用方区分普通工具输出。
  kind: 'changes';
  // files 的每项保存路径以及修改前后的完整内容。
  files: Array<{ path: string; before: string | null; after: string | null }>;
// 类型守卫返回 true 后，TypeScript 会把 value 缩窄为上面的结构。
} {
  // 依次确认值非空、属于对象、kind 正确并且 files 真的是数组。
  return Boolean(value && typeof value === 'object' && (value as { kind?: string }).kind === 'changes' && Array.isArray((value as { files?: unknown }).files));
} // 结束 ChangeSet 输出判断函数。
