/**
 * 这个文件实现 Agent 的“工作记忆”。它不是模型的私有思维链，而是可审计的事实状态：
 * ContextLedger 保存目标、修改 revision 和验证；FileEvidenceStore 保存读过的文件片段；
 * MemoryIndex 保存可检索的历史事实；buildHybridContext 把它们组合成下一次模型请求。
 */
// createHash 计算文件证据摘要，randomUUID 为 Evidence 和 Memory 生成唯一标识。
import { createHash, randomUUID } from 'node:crypto';
// estimateTokens 估算模型输入成本，ModelConfig 提供上下文窗口和输出预算。
import { estimateTokens, type ModelConfig } from '@seecoder/model';
// 以下协议类型描述事件、消息、计划、摘要、Artifact 和工具结果。
import type {
  // 第一组用于事件回放、压缩指标、持久化 Item、模型消息和计划步骤。
  AgentEvent, ContextCompactionMetrics, Item, ModelMessage, PlanStep,
  // 第二组用于结构化摘要、Session 事件、外置结果和工具返回值。
  SemanticSummary, SessionEvent, ToolArtifact, ToolResult,
} from '@seecoder/protocol'; // 类型导入在运行时不会产生额外依赖。

/** Agent 已采用或已被替代的一条显式决策。 */
export interface DecisionRecord {
  /** 决策唯一 id。 */
  id: string;
  /** 决策正文，例如“使用 SQLite 保存本地状态”。 */
  decision: string;
  /** 为什么做这个决定。 */
  reason?: string;
  /** active 仍有效；superseded 已被新决定替代。 */
  status: 'active' | 'superseded';
} // 结束 DecisionRecord 接口。

/** 某个代码 revision 上真实运行过的一条验证命令。 */
export interface ValidationRecord {
  /** 实际执行过的命令。 */
  command: string;
  /** 执行时对应的文件修改版本。 */
  revision: number;
  /** 命令是否成功。 */
  status: 'passed' | 'failed';
  /** stdout/stderr 的短摘要。 */
  summary: string;
  /** 命令完成时间。 */
  timestamp: string;
} // 结束 ValidationRecord 接口。

/** 文件的当前内容摘要，以及它最近何时被读取或修改。 */
export interface FileStateRecord {
  /** 相对 workspace 的文件路径。 */
  path: string;
  /** 当前内容 SHA-256；null 表示文件已删除。 */
  contentHash: string | null;
  /** 最近一次读取该文件时的 revision。 */
  lastReadRevision?: number;
  /** 最近一次修改该文件时的 revision。 */
  lastChangedRevision?: number;
} // 结束 FileStateRecord 接口。

/** 可展示、可恢复的错误事实，不包含模型私有推理。 */
export interface ErrorRecord {
  /** 供程序判断的稳定错误码。 */
  code: string;
  /** 给用户看的错误说明。 */
  message: string;
  /** 错误出现时的文件修改版本。 */
  revision: number;
  /** open 尚未解决；resolved 已解决。 */
  status: 'open' | 'resolved';
  /** 错误记录时间。 */
  timestamp: string;
} // 结束 ErrorRecord 接口。

/** Ledger 的可持久化 V2 数据结构；version 用于将来安全迁移。 */
export interface ContextLedgerStateV2 {
  /** 固定字面量 2，用于识别存储格式版本。 */
  version: 2;
  /** 当前用户任务目标。 */
  goal: string;
  /** 可验证的完成条件。 */
  acceptanceCriteria: string[];
  /** 项目或用户声明的约束。 */
  constraints: string[];
  /** Agent 当前计划。 */
  plan: PlanStep[];
  /** 每批文件修改递增一次。 */
  changeRevision: number;
  /** 结构化决策历史。 */
  decisions: DecisionRecord[];
  /** 已知文件状态。 */
  files: FileStateRecord[];
  /** 验证命令历史。 */
  validations: ValidationRecord[];
  /** 错误历史。 */
  errors: ErrorRecord[];
} // 结束 ContextLedgerStateV2 接口。

// 旧版本没有结构化 revision；保留此类型是为了兼容已有用户数据。
type LegacyLedger = {
  // goal 是旧格式保存的可选用户目标。
  goal?: string;
  // constraints 是旧格式已有的约束数组。
  constraints?: string[];
  // plan 是旧格式已有的计划步骤。
  plan?: PlanStep[];
  // changedFiles 只有路径，无法恢复内容哈希和准确 revision。
  changedFiles?: string[];
  // tests 是旧格式的自由文本测试结果。
  tests?: string[];
  // errors 是旧格式的自由文本错误数组。
  errors?: string[];
}; // 结束旧 Ledger 兼容类型。

// 创建 timestamp 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
const timestamp = () => new Date().toISOString();
// SHA-256 把任意长文本变成稳定短摘要，相同内容必定得到相同 hash。
export const contentHash = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * ContextLedger 是任务的权威结构化状态。
 * 与聊天摘要不同，它不会让模型自由改写，因此验证和 revision 判断更可靠。
 */
export class ContextLedger {
  // 初始 Ledger 为空任务、零 revision，并且没有任何历史事实。
  private state: ContextLedgerStateV2 = {
    version: 2, // 当前存储格式版本
    goal: '', // startTurn 后由 setGoal 写入
    acceptanceCriteria: [], // 初始没有验收条件
    constraints: [], // 初始没有额外约束
    plan: [], // 初始没有计划步骤
    changeRevision: 0, // 尚未修改文件
    decisions: [], // 尚未记录决策
    files: [], // 尚未读取或修改文件
    validations: [], // 尚未运行验证
    errors: [], // 尚未发生错误
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  };

  /** 保存用户目标，最多 4,000 字符。 */
  setGoal(goal: string): void {
    // slice 防止极长用户输入无限扩大独立 state.json。
    this.state.goal = goal.slice(0, 4000);
  } // 结束目标更新方法。

  /** 保存最多 50 个计划步骤，避免模型生成无限计划。 */
  setPlan(plan: PlanStep[]): void {
    // slice 创建受限副本，避免模型生成无限计划步骤。
    this.state.plan = plan.slice(0, 50);
  } // 结束计划更新方法。

  /** 返回当前文件修改版本。 */
  revision(): number {
    // changeRevision 只在一批真实文件变化后增加。
    return this.state.changeRevision;
  } // 结束当前 revision 读取方法。

  /** 从 V2 快照恢复；如果读到旧格式，则转换成当前结构。 */
  restore(input: ContextLedgerStateV2 | LegacyLedger): void {
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if ((input as ContextLedgerStateV2).version === 2) {
      // 类型断言只告诉 TypeScript 按 V2 读取；下面仍对缺失字段提供默认值。
      const value = input as ContextLedgerStateV2;
      // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
      this.state = {
        version: 2, // 已确认是 V2
        goal: value.goal ?? '', // 旧的损坏数据缺 goal 时使用空字符串
        // acceptanceCriteria 缺失时恢复为空数组。
        acceptanceCriteria: value.acceptanceCriteria ?? [],
        // constraints 缺失时恢复为空数组。
        constraints: value.constraints ?? [],
        // plan 缺失时恢复为空计划。
        plan: value.plan ?? [],
        // 无法读取 revision 时从零开始，不猜测旧代码状态。
        changeRevision: value.changeRevision ?? 0,
        // 以下四类结构化历史都提供空数组后备。
        decisions: value.decisions ?? [],
        // 设置 files 字段，把这一项数据传给目标对象、事件或函数。
        files: value.files ?? [],
        // 设置 validations 字段，把这一项数据传给目标对象、事件或函数。
        validations: value.validations ?? [],
        // 设置 errors 字段，把这一项数据传给目标对象、事件或函数。
        errors: value.errors ?? [],
      }; // 完成 V2 状态整体替换。
      // V2 已恢复完成，不继续执行旧格式迁移。
      return;
    } // 结束 V2 快照恢复分支。
    // 没有 version: 2 就按旧结构处理，补上新字段的安全默认值。
    const legacy = input as LegacyLedger;
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.state = {
      version: 2, // 迁移后统一保存为 V2
      goal: legacy.goal ?? '', // 沿用旧目标
      acceptanceCriteria: [], // 旧格式没有该字段
      constraints: legacy.constraints ?? [], // 沿用旧约束
      plan: legacy.plan ?? [], // 沿用旧计划
      changeRevision: 0, // 旧格式无法可靠推导 revision
      decisions: [], // 旧格式没有结构化决策
      // 设置 files 字段，把这一项数据传给目标对象、事件或函数。
      files: (legacy.changedFiles ?? []).map((path) => ({ path, contentHash: null, lastChangedRevision: 0 })),
      // 设置 validations 字段，把这一项数据传给目标对象、事件或函数。
      validations: (legacy.tests ?? []).map((summary) => ({ command: summary.slice(0, 300), revision: 0, status: summary.startsWith('通过') ? 'passed' : 'failed', summary: summary.slice(0, 500), timestamp: timestamp() })),
      // 设置 errors 字段，把这一项数据传给目标对象、事件或函数。
      errors: (legacy.errors ?? []).map((message) => ({ code: 'legacy_error', message: message.slice(0, 500), revision: 0, status: 'open', timestamp: timestamp() })),
    }; // 完成旧格式到 V2 的迁移。
  } // 结束 Ledger 恢复方法。

  /** 每发生一批文件修改，只增加一次 revision，并记录每个文件的新 hash。 */
  recordChanges(files: Array<{ path: string; after: string | null }>): number {
    // 同一工具调用可能修改多个文件，但它们属于同一个 revision。
    this.state.changeRevision += 1;
    // 保存局部变量，保证循环内所有文件写入相同 revision。
    const revision = this.state.changeRevision;
    // 逐个记录本批工具调用涉及的文件。
    for (const file of files) {
      // find 返回第一条路径相同的记录，没找到则为 undefined。
      const existing = this.state.files.find((item) => item.path === file.path);
      // after=null 表示删除文件，否则计算修改后内容 hash。
      const nextHash = file.after === null ? null : contentHash(file.after);
      if (existing) { // 已有记录时就地更新，保留先前读取信息。
        // 已知文件直接更新原对象。
        existing.contentHash = nextHash;
        // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
        existing.lastChangedRevision = revision;
      } else { // 首次看到该路径时创建文件状态记录。
        // 首次出现的文件追加一条状态记录。
        this.state.files.push({ path: file.path, contentHash: nextHash, lastChangedRevision: revision });
      } // 结束已有文件与新文件两种处理。
    } // 结束本 revision 的文件循环。
    // 只保留最近 100 个文件，限制长期 Session 的状态大小。
    this.state.files = this.state.files.slice(-100);
    // 返回本批变化对应的新 revision。
    return revision;
  } // 结束文件变化记录方法。

  /** 记录一次文件读取，使后续逻辑知道这份证据对应哪个 revision。 */
  recordRead(path: string, hash: string): void {
    // 查找路径已有状态；单纯读取不会增加 changeRevision。
    const existing = this.state.files.find((item) => item.path === path);
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (existing) {
      // 读取确认了当前内容，因此刷新 hash 和读取 revision。
      existing.contentHash = hash;
      // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      existing.lastReadRevision = this.state.changeRevision;
    // 前面的条件均不成立时执行这个后备分支。
    } else {
      // 首次读取的文件创建状态记录，但不设置 lastChangedRevision。
      this.state.files.push({ path, contentHash: hash, lastReadRevision: this.state.changeRevision });
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 验证结果绑定当前 revision；代码再次变化后，旧测试不再算“新鲜”。 */
  addValidation(command: string, ok: boolean, summary: string): void {
    // push 追加一条与当前代码 revision 绑定的验证事实。
    this.state.validations.push({
      command: command.slice(0, 300), // 保存有限长度的命令文本
      revision: this.state.changeRevision, // 绑定当前代码版本
      status: ok ? 'passed' : 'failed', // boolean 转成更易读的状态字符串
      summary: summary.slice(0, 500), // 只保存输出摘要
      timestamp: timestamp(), // 验证完成时间
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
    // 保留最近 40 次验证。
    this.state.validations = this.state.validations.slice(-40);
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 保存最近错误，并限制数组长度，防止长期 Session 无限增长。 */
  addError(code: string, message: string): void {
    // push 追加一个尚未解决的可恢复错误事实。
    this.state.errors.push({
      code, // 程序错误码
      message: message.slice(0, 500), // 用户可读说明
      revision: this.state.changeRevision, // 错误发生时的代码版本
      status: 'open', // 新错误默认尚未解决
      timestamp: timestamp(), // 记录时间
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
    // 只保留最近四十条，避免长期失败循环无限增长。
    this.state.errors = this.state.errors.slice(-40);
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 是否至少发生过一次文件修改。 */
  hasChanges(): boolean {
    // revision 大于零说明至少发生过一批文件变化。
    return this.state.changeRevision > 0;
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }
  // 只有本 revision 修改了非文档文件时，finish 才需要新验证。
  requiresFreshValidation(): boolean {
    // 文档修改通常不需要代码测试，因此从新鲜验证要求中排除。
    const documentation = /\.(?:md|mdx|txt|rst|adoc)$/i;
    // 当前 revision 只要修改过非文档文件，就要求重新运行验证。
    return this.state.files.some((file) => file.lastChangedRevision === this.state.changeRevision && !documentation.test(file.path));
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }
  /** 当前 revision 是否至少有一次成功验证。 */
  hasFreshValidation(): boolean {
    // 把计算完成的结果返回给当前方法的调用方。
    return this.state.validations.some(
      // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      (item) => item.revision === this.state.changeRevision && item.status === 'passed',
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    );
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }
  // structuredClone 返回深拷贝，调用方无法绕过方法直接篡改内部 state。
  snapshot(): ContextLedgerStateV2 {
    // structuredClone 防止调用方绕过方法修改内部 state。
    return structuredClone(this.state);
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 返回适合放进模型上下文的缩进 JSON 文本。 */
  summary(): string {
    // 两空格缩进让权威状态在模型上下文和调试日志中易读。
    return JSON.stringify(this.snapshot(), null, 2);
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}
/** 一段已经实际读过的文件证据。 */
export interface FileEvidence {
  /** 供后续 observation 引用的唯一 id。 */
  id: string;
  /** 被读取文件的相对路径。 */
  path: string;
  /** 这段文本的 SHA-256。 */
  contentHash: string;
  /** 证据开始行，包含该行。 */
  startLine: number;
  /** 证据结束行，包含该行。 */
  endLine: number;
  /** 实际读取到的正文。 */
  text: string;
  /** 读取时对应的 Ledger revision。 */
  revision: number;
  /** 首次记录时间。 */
  createdAt: string;
  /** 后续是否发生过重复读取。 */
  referenced: boolean;
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}
/**
 * FileEvidenceStore 对重复读取去重。
 * 模型第二次读取相同路径、相同行号和相同内容时，只收到 evidenceRef，而非整段文本。
 */
export class FileEvidenceStore {
  // entries 用 evidence id 找完整对象。
  private readonly entries = new Map<string, FileEvidence>();
  // keys 用“路径+hash+行范围”快速判断是否重复读取。
  private readonly keys = new Map<string, string>();

  /** 生成不会和普通路径文本混淆的复合 key；\0 是空字符分隔符。 */
  private key(path: string, hash: string, startLine: number, endLine: number): string {
    // 把计算完成的结果返回给当前方法的调用方。
    return `${path}\0${hash}\0${startLine}\0${endLine}`;
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 保存新证据或返回已有证据；duplicate 告诉调用方是否可以省略正文。 */
  record(path: string, text: string, startLine: number, endLine: number, revision: number): { evidence: FileEvidence; duplicate: boolean } {
    // 先对实际片段文本计算 hash，同一路径内容变化后会得到不同 key。
    const hash = contentHash(text);
    // 创建 key 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const key = this.key(path, hash, startLine, endLine);
    // 创建 existingId 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const existingId = this.keys.get(key);
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (existingId) {
      // 非空断言 !：keys 中存在的 id 按不变量一定也存在于 entries。
      const existing = this.entries.get(existingId)!;
      // 标记 referenced，ContextBuilder 会在 Evidence 区集中注入一次正文。
      existing.referenced = true;
      // 把计算完成的结果返回给当前方法的调用方。
      return { evidence: existing, duplicate: true };
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // 创建 evidence 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const evidence: FileEvidence = {
      id: randomUUID(), // 新证据 id
      path, // 使用参数属性简写
      contentHash: hash, // 保存上面计算的 hash
      startLine, // 片段起始行
      endLine, // 片段结束行
      text, // 首次读取保留正文
      revision, // 证据属于哪个代码版本
      createdAt: timestamp(), // 创建时间
      referenced: false, // 还没有重复引用
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    };
    // 两个 Map 必须同时写入，保持双向索引一致。
    this.entries.set(evidence.id, evidence);
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.keys.set(key, evidence.id);
    // 把计算完成的结果返回给当前方法的调用方。
    return { evidence, duplicate: false };
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 文件一旦被修改，基于旧内容的证据必须立即失效。 */
  invalidate(paths: string[]): void {
    // Set.has 比每次在数组中搜索更直接，也会自动去重输入路径。
    const targets = new Set(paths);
    // 遍历当前集合或异步事件流，并按顺序处理其中每一项。
    for (const [id, entry] of this.entries) {
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (targets.has(entry.path)) {
        // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
        this.entries.delete(id);
        // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
        this.keys.delete(this.key(entry.path, entry.contentHash, entry.startLine, entry.endLine));
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 返回当前 revision 中被重复引用的证据。 */
  referenced(revision: number): FileEvidence[] {
    // 把计算完成的结果返回给当前方法的调用方。
    return [...this.entries.values()].filter((entry) => entry.referenced && entry.revision === revision);
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 清空两个索引。 */
  clear(): void {
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.entries.clear();
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.keys.clear();
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}

/** MemoryIndex 中一条可检索的、对用户可解释的历史事实。 */
export interface MemoryEntry {
  /** 记忆条目唯一 id。 */
  id: string;
  /** 条目来源类别。 */
  kind: 'decision' | 'error' | 'validation' | 'change' | 'user' | 'assistant';
  /** 可检索和注入模型的短文本。 */
  text: string;
  /** 从文本提取或显式提供的相关文件路径。 */
  paths: string[];
  /** 用于词法匹配的关键词。 */
  keywords: string[];
  /** 条目所属 Session。 */
  sessionId: string;
  /** 可选的来源 Turn。 */
  turnId?: string;
  /** 可选的代码修改版本。 */
  revision?: number;
  /** 事件发生时间。 */
  timestamp: string;
  /** resolved/superseded 条目不会再被召回。 */
  status?: 'active' | 'resolved' | 'superseded';
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}

// 英文按单词、中文按相邻双字生成关键词，不依赖外部向量数据库。
function keywords(value: string): string[] {
  // 英文统一转小写，让 Foo 和 foo 可以匹配。
  const normalized = value.toLowerCase();
  // 正则提取英文、数字、文件路径常见字符组成的长度至少为 2 的 token。
  const output = new Set(normalized.match(/[a-z0-9_./-]{2,}/g) ?? []);
  // 去掉非汉字字符后，将中文拆成字符数组。
  const chinese = [...normalized.replaceAll(/[^\p{Script=Han}]/gu, '')];
  // 使用相邻两个汉字组成 bigram，提供不依赖分词库的简单中文检索。
  for (let index = 0; index < chinese.length - 1; index += 1) output.add(chinese[index]! + chinese[index + 1]!);
  // 展开 Set 为数组，并限制最多 200 个关键词。
  return [...output].slice(0, 200);
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}

/** 从自由文本中提取最多 20 个看起来像多段文件路径的字符串。 */
function pathsIn(value: string): string[] {
  // 正则寻找至少包含一个目录分隔符的路径形文本。
  const matches = value.match(/[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+/g) ?? [];
  // Set 去重后只保留前二十个，限制单条 Memory 的路径索引大小。
  return [...new Set(matches)].slice(0, 20);
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}

/**
 * MemoryIndex 是一个轻量词法检索器，不是“无限记忆”。
 * 它最多保留 500 条记录，并根据关键词、路径、revision 和时间进行排序。
 */
export class MemoryIndex {
  // 数组保持事件时间顺序，新增条目追加到末尾。
  private entries: MemoryEntry[] = [];

  /** 补全 id、paths、keywords 后保存一条记忆。 */
  add(entry: Omit<MemoryEntry, 'id' | 'keywords' | 'paths'> & { paths?: string[] }): void {
    // 读取或更新当前实例保存的状态，并调用相应依赖完成这一小步。
    this.entries.push({
      ...entry, // 保留调用方传入的 kind/text/sessionId 等字段
      id: randomUUID(), // 每次 add 生成新 id
      paths: entry.paths ?? pathsIn(entry.text), // 优先使用显式路径，否则自动提取
      keywords: keywords(entry.text), // 从正文生成检索关键词
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
    // 只保留最后 500 条，slice(-500) 从数组尾部取值。
    this.entries = this.entries.slice(-500);
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 将事件和持久化 Item 转成适合检索的事实条目。 */
  ingest(sessionId: string, event: AgentEvent, item: Item | undefined, revision: number): void {
    // Item 比 Event 更适合恢复完整消息正文；按 kind 分别转换。
    // 用户消息最多索引四千字符，并尽可能携带来源 Turn。
    if (item?.kind === 'user_message') this.add({ kind: 'user', text: item.text.slice(0, 4000), sessionId, ...('turnId' in event && event.turnId ? { turnId: event.turnId } : {}), revision, timestamp: item.createdAt, status: 'active' });
    // 非空 Assistant 正文同样作为可检索的活动历史加入索引。
    else if (item?.kind === 'assistant_message' && item.text) this.add({ kind: 'assistant', text: item.text.slice(0, 4000), sessionId, ...('turnId' in event && event.turnId ? { turnId: event.turnId } : {}), revision, timestamp: item.createdAt, status: 'active' });
    // ChangeSet 只索引文件路径摘要，不把完整 before/after 正文放入 Memory。
    else if (item?.kind === 'changes') this.add({ kind: 'change', text: `修改文件：${item.changeSet.files.map((file) => file.path).join('、')}`, paths: item.changeSet.files.map((file) => file.path), sessionId, turnId: item.changeSet.turnId, revision, timestamp: item.createdAt, status: 'active' });
    // Error Item 保存稳定 code 与可读 message，便于后续任务按错误召回。
    else if (item?.kind === 'error') this.add({ kind: 'error', text: `${item.error.code}: ${item.error.message}`, sessionId, revision, timestamp: item.createdAt, status: 'active' });
    // tool.completed 的错误可能没有独立 error Item，因此额外从事件补录。
    if (event.type === 'tool.completed' && event.result.error) this.add({ kind: 'error', text: `${event.result.error.code}: ${event.result.error.message}`, sessionId, turnId: event.turnId, revision, timestamp: event.timestamp, status: 'active' });
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** 应用重启后从事件日志重建指定 Session 的索引。 */
  rebuild(sessionId: string, records: SessionEvent[], revision: number): void {
    // 先删除该 Session 旧索引，其他 Session 的条目保持不变。
    this.entries = this.entries.filter((entry) => entry.sessionId !== sessionId);
    // 按持久化顺序重新 ingest，恢复与运行时相同的派生索引。
    for (const record of records) this.ingest(sessionId, record.event, record.item, revision);
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /** Ledger 比事件摘要更权威，因此先删除旧派生条目，再同步最新状态。 */
  syncLedger(sessionId: string, state: ContextLedgerStateV2): void {
    // 删除会由 Ledger 重新生成的三类条目，防止重复。
    this.entries = this.entries.filter((entry) => entry.sessionId !== sessionId || !['decision', 'validation', 'error'].includes(entry.kind));
    // 把 Ledger 当前决策逐条转换为 MemoryEntry。
    for (const decision of state.decisions) this.add({
      // 设置 kind 字段，把这一项数据传给目标对象、事件或函数。
      kind: 'decision', text: `${decision.decision}${decision.reason ? `：${decision.reason}` : ''}`,
      // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      sessionId, revision: state.changeRevision, timestamp: timestamp(), status: decision.status,
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
    // 验证记录保留执行命令、摘要和它对应的 revision。
    for (const validation of state.validations) this.add({
      // 设置 kind 字段，把这一项数据传给目标对象、事件或函数。
      kind: 'validation', text: `${validation.command}: ${validation.summary}`,
      // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      sessionId, revision: validation.revision, timestamp: validation.timestamp, status: 'active',
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
    // 错误的 open/resolved 状态转换成 Memory 的 active/resolved。
    for (const error of state.errors) this.add({
      // 设置 kind 字段，把这一项数据传给目标对象、事件或函数。
      kind: 'error', text: `${error.code}: ${error.message}`,
      // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      sessionId, revision: error.revision, timestamp: error.timestamp, status: error.status === 'open' ? 'active' : 'resolved',
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }

  /**
   * 按查询召回少量相关事实。路径命中权重最高，关键词次之，新 revision 和近期内容加分。
   */
  retrieve(query: string, revision: number, limit = 6, maxChars = 4000, excludeTurnId?: string): MemoryEntry[] {
    // 将查询也转换为与 MemoryEntry 相同的关键词和路径表示。
    const queryKeys = new Set(keywords(query));
    // 创建 queryPaths 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const queryPaths = pathsIn(query);
    // 当前毫秒时间用于计算随时间衰减的分数。
    const now = Date.now();
    // 创建 scored 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const scored = this.entries.flatMap((entry) => {
      // 当前 Turn 已在最近聊天历史中，不重复召回。
      if (excludeTurnId && entry.turnId === excludeTurnId) return [];
      // 已解决/已替代内容不再召回，旧 revision 的验证也不能证明当前代码正确。
      if (entry.status === 'resolved' || entry.status === 'superseded') return [];
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (entry.kind === 'validation' && entry.revision !== revision) return [];
      // 每个关键词命中加 3 分。
      let score = entry.keywords.reduce((sum, key) => sum + (queryKeys.has(key) ? 3 : 0), 0);
      // 路径互相包含时加 8 分，路径事实通常比普通词更精确。
      score += entry.paths.reduce((sum, path) => sum + (queryPaths.some((value) => value.includes(path) || path.includes(value)) ? 8 : 0), 0);
      // 当前代码 revision 和 active 状态各有小额加分。
      if (entry.revision === revision) score += 2;
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (entry.status === 'active') score += 1;
      // 30 天内的近期内容获得 0~1 的时间加分。
      score += Math.max(0, 1 - (now - Date.parse(entry.timestamp)) / 86_400_000 / 30);
      // flatMap 返回 [] 表示丢弃零分条目，否则返回带分数的单元素数组。
      return score > 0 ? [{ entry, score }] : [];
    // 先按分数降序，同分时较新的时间排前。
    }).sort((left, right) => right.score - left.score || right.entry.timestamp.localeCompare(left.entry.timestamp));
    // 同时遵守条目数和字符数预算，避免检索结果撑大模型上下文。
    // output 保存最终召回结果，chars 跟踪累计正文预算。
    const output: MemoryEntry[] = [];
    // chars 初始为零，每加入一条事实就增加它的文本长度。
    let chars = 0;
    // scored 已按相关性排序，因此从前向后选择就是保留最高分事实。
    for (const { entry } of scored) {
      // 达到条数或字符上限时停止，不让检索结果挤占当前任务上下文。
      if (output.length >= limit || chars + entry.text.length > maxChars) break;
      // 当前条目在预算内，加入结果数组。
      output.push(entry);
      // 累加正文长度供下一轮预算判断。
      chars += entry.text.length;
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // 返回已经按相关性和时间排序的有限结果。
    return output;
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}

// 只把常见测试、lint、typecheck、build 命令识别为验证，普通命令不算。
const validationPattern = /(^|\s)(test|lint|typecheck|build)(\s|:|$)|pytest|node\s+--test|python\s+-m\s+pytest/i;
// 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
export function isValidationCommand(command: string): boolean { return validationPattern.test(command); }

// 对超长输出保留开头和结尾：开头常含上下文，结尾常含报错和总结。
function headTail(value: string, head = 3000, tail = 5000): { text: string; truncated: boolean } {
  // 总长度在预算内时原样返回，并明确标记未裁剪。
  if (value.length <= head + tail) return { text: value, truncated: false };
  // 超长时保留首尾并插入可见标记，让模型知道中间内容缺失。
  return { text: `${value.slice(0, head)}\n…[已裁剪]…\n${value.slice(-tail)}`, truncated: true };
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}

// 从命令输出中提取有限数量的诊断行，帮助模型快速定位编译或测试错误。
function diagnosticLines(value: string): string[] {
  // 按行拆分后只保留疑似错误、警告或源码位置，最后限制为三十行。
  return value.split(/\r?\n/).filter((line) => /(?:error|failed|exception|warning|\.(?:ts|tsx|js|py|java|cpp))[:(\s]/i.test(line)).slice(-30).map((line) => line.slice(0, 500));
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}

/**
 * 将不同工具的原始 ToolResult 转成适合再次发送给模型的字符串。
 * 这里会去重文件证据、裁剪命令输出和 Diff，并保留审计所需的关键信息。
 */
export function serializeObservation(toolName: string, args: unknown, result: ToolResult, ledger: ContextLedger, evidence: FileEvidenceStore, artifact?: ToolArtifact): string {
  // base 是所有工具结果都共有的最小字段。
  const base = { ok: result.ok, ...(result.error ? { error: result.error } : {}), durationMs: result.durationMs, ...(artifact ? { artifactRef: artifact.id, artifactSize: artifact.size, artifactSha256: artifact.sha256 } : {}) };
  // 检查该条件；只有条件成立时才执行紧随其后的分支。
  if (toolName === 'list_files' && result.ok) {
    // 目录列表显式保留 truncated，防止模型把不完整列表误当成完整项目结构。
    const value = result.output && typeof result.output === 'object' && !Array.isArray(result.output)
      // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      ? result.output as { entries?: unknown; count?: unknown; truncated?: unknown; limit?: unknown }
      // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      : { entries: result.output };
    // 只接受字符串路径，丢弃模型不需要且协议外的异常元素。
    const entries = Array.isArray(value.entries) ? value.entries.filter((entry): entry is string => typeof entry === 'string') : [];
    // 输出同时保留 count、limit 和 truncated，防止模型误判目录完整性。
    return JSON.stringify({ ...base, output: { entries, count: typeof value.count === 'number' ? value.count : entries.length, truncated: value.truncated === true, limit: typeof value.limit === 'number' ? value.limit : 200 } });
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }
  // 检查该条件；只有条件成立时才执行紧随其后的分支。
  if (toolName === 'read_file' && result.ok && result.output && typeof result.output === 'object') {
    // 先按未知字段读取，只有路径和正文都是字符串时才登记 Evidence。
    const value = result.output as { path?: unknown; startLine?: unknown; endLine?: unknown; text?: unknown };
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (typeof value.path === 'string' && typeof value.text === 'string') {
      // 缺少起始行时默认从第一行开始。
      const startLine = typeof value.startLine === 'number' ? value.startLine : 1;
      // 缺少结束行时至少把范围设为起始行。
      const endLine = typeof value.endLine === 'number' ? value.endLine : startLine;
      // 重复证据只返回引用；首次读取则保留正文并登记 hash。
      const recorded = evidence.record(value.path, value.text, startLine, endLine, ledger.revision());
      // Ledger 同步保存当前文件哈希和读取 revision。
      ledger.recordRead(value.path, recorded.evidence.contentHash);
      // 重复读取删除正文并返回 cached 引用；首次读取保留完整文本。
      return JSON.stringify(recorded.duplicate ? { ...base, output: { path: value.path, evidenceRef: recorded.evidence.id, contentHash: recorded.evidence.contentHash, startLine, endLine, cached: true } } : { ...base, output: { ...value, evidenceRef: recorded.evidence.id, contentHash: recorded.evidence.contentHash } });
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }
  // 检查该条件；只有条件成立时才执行紧随其后的分支。
  if (toolName === 'read_files' && result.ok && Array.isArray(result.output)) {
    // 批量结果逐项转换，单个无效元素不会破坏其他文件。
    const output = result.output.map((raw) => {
      // 每项期望包含 path、text，error 用于保持失败项信息。
      const value = raw as { path?: unknown; text?: unknown; error?: unknown };
      // 缺少合法路径或正文时原样保留，不登记伪 Evidence。
      if (typeof value.path !== 'string' || typeof value.text !== 'string') return value;
      // split 计算完整文件片段覆盖的结束行号。
      const lines = value.text.split(/\r?\n/);
      // 批量读取默认从第一行覆盖到正文最后一行。
      const recorded = evidence.record(value.path, value.text, 1, lines.length, ledger.revision());
      // 把本次读取确认的哈希写入 Ledger。
      ledger.recordRead(value.path, recorded.evidence.contentHash);
      // 重复文件只返回引用，首次文件继续携带正文。
      return recorded.duplicate ? { path: value.path, evidenceRef: recorded.evidence.id, contentHash: recorded.evidence.contentHash, cached: true } : { ...value, evidenceRef: recorded.evidence.id, contentHash: recorded.evidence.contentHash };
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
    // 把转换后的批量数组放回统一 Observation 外壳。
    return JSON.stringify({ ...base, output });
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }
  // 检查该条件；只有条件成立时才执行紧随其后的分支。
  if (toolName === 'run_command' && result.output && typeof result.output === 'object') {
    // stdout/stderr 可能有数 MB，必须先裁剪再进入下一轮模型请求。
    const value = result.output as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
    // stdout 首尾各保留 2500 字符，兼顾命令背景和最终总结。
    const stdout = headTail(typeof value.stdout === 'string' ? value.stdout : '', 2500, 2500);
    // stderr 更偏重尾部，因为编译器通常在最后输出根因和汇总。
    const stderr = headTail(typeof value.stderr === 'string' ? value.stderr : '', 1000, 5000);
    // 只把受限命令、退出码、裁剪输出和诊断行发送到下一轮模型。
    return JSON.stringify({ ...base, output: { command: String((args as { command?: unknown } | undefined)?.command ?? '').slice(0, 500), exitCode: value.exitCode, stdout: stdout.text, stderr: stderr.text, diagnostics: diagnosticLines(`${stdout.text}\n${stderr.text}`), truncated: stdout.truncated || stderr.truncated } });
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }
  // 检查该条件；只有条件成立时才执行紧随其后的分支。
  if (toolName === 'write_file' || toolName === 'apply_patch') {
    // 模型只需要知道文件操作和字符规模，完整 before/after 已保存在 ChangeSet。
    const changes = result.output as { kind?: unknown; files?: Array<{ path: string; before: string | null; after: string | null }> } | undefined;
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (changes?.kind === 'changes' && Array.isArray(changes.files)) return JSON.stringify({ ...base, output: { kind: 'changes', files: changes.files.map((file) => ({ path: file.path, operation: file.after === null ? 'deleted' : file.before === null ? 'created' : 'updated', beforeChars: file.before?.length ?? 0, afterChars: file.after?.length ?? 0 })) } });
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }
  // 检查该条件；只有条件成立时才执行紧随其后的分支。
  if (toolName === 'search_text' && Array.isArray(result.output)) {
    // JSON 字符串作为 Map key，可以对结构相同的搜索结果去重。
    const unique = [...new Map(result.output.map((entry) => [JSON.stringify(entry), entry])).values()].slice(0, 50);
    // 把计算完成的结果返回给当前方法的调用方。
    return JSON.stringify({ ...base, output: unique, total: result.output.length, truncated: unique.length < result.output.length });
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }
  // 检查该条件；只有条件成立时才执行紧随其后的分支。
  if (toolName === 'git_diff' && result.output && typeof result.output === 'object') {
    // Git 工具约定输出退出码、stdout 差异和 stderr。
    const value = result.output as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
    // Diff 最多保留首尾各五千字符，避免大型仓库差异占满窗口。
    const diff = headTail(typeof value.stdout === 'string' ? value.stdout : '', 5000, 5000);
    // stderr 只保留最后两千字符，通常包含最具体的 Git 错误。
    return JSON.stringify({ ...base, output: { exitCode: value.exitCode, diff: diff.text, stderr: typeof value.stderr === 'string' ? value.stderr.slice(-2000) : '', truncated: diff.truncated } });
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }
  // 未专门处理的工具仍有 16k 字符总上限。
  const serialized = JSON.stringify(result);
  // 检查该条件；只有条件成立时才执行紧随其后的分支。
  if (serialized.length <= 16_000) return serialized;
  // 把计算完成的结果返回给当前方法的调用方。
  return JSON.stringify({ ...base, output: `[工具输出过长，已裁剪；${artifact ? `可使用 read_artifact 读取 ${artifact.id}` : '完整结果保留在轨迹'}]\n${serialized.slice(0, 10_000)}\n…\n${serialized.slice(-4_000)}` });
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}

/**
 * 把 assistant tool_calls 与紧随其后的 tool results 组成不可拆分的协议组。
 * OpenAI 兼容接口要求每个 tool call 都有对应 result，压缩时不能只保留一半。
 */
function messageGroups(messages: ModelMessage[]): ModelMessage[][] {
  // groups 保存最终可整体保留或整体删除的消息组。
  const groups: ModelMessage[][] = [];
  // index 手动前进，因为一个工具协议组可能一次消费多条消息。
  for (let index = 0; index < messages.length;) {
    // 非空断言成立，因为循环条件保证 index 在数组内。
    const message = messages[index]!;
    // Assistant 含 Tool Calls 时，必须收集后续全部对应 Tool Result。
    if (message.role === 'assistant' && message.toolCalls?.length) {
      // pending 初始包含每个尚未找到结果的 Tool Call id。
      const pending = new Set(message.toolCalls.map((call) => call.id));
      // group 第一项必须是发出 Tool Calls 的 Assistant 消息。
      const group = [message];
      // index 先移到紧随其后的第一条候选 Tool Result。
      index += 1;
      // 连续 tool 消息都属于当前 Assistant 工具调用区域。
      while (index < messages.length && messages[index]!.role === 'tool') {
        // 取出当前 Tool Result 消息。
        const tool = messages[index]!;
        // 结果 id 命中 pending 时标记该调用已配对。
        if (pending.has(tool.toolCallId ?? '')) pending.delete(tool.toolCallId!);
        // 无论是否命中都先加入候选组，完整性由 pending 最终决定。
        group.push(tool);
        // 前进到下一条消息。
        index += 1;
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      }
      // 只有每个调用都有结果时才保留整个协议组。
      if (pending.size === 0) groups.push(group);
    // 孤立 tool 消息没有合法 Assistant 调用，直接跳过。
    } else if (message.role === 'tool') index += 1;
    // 普通 user/assistant/system 消息各自形成单元素组。
    else {
      // 以数组包装，后续裁剪逻辑统一按组处理。
      groups.push([message]);
      // 单元素组只消费当前一条消息。
      index += 1;
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }
  // 返回只包含合法模型协议的消息组。
  return groups;
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}

/** 删除孤立 tool 消息和缺少结果的 assistant tool-call 组。 */
export function sanitizeModelMessages(messages: ModelMessage[]): ModelMessage[] { return messageGroups(messages).flat(); }

// 已在 Evidence 区重新注入的文件正文，从旧 tool 消息中折叠为引用，避免重复占 Token。
function collapseReferencedEvidence(messages: ModelMessage[], referenced: FileEvidence[]): ModelMessage[] {
  // 创建 ids 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
  const ids = new Set(referenced.map((entry) => entry.id));
  // 检查该条件；只有条件成立时才执行紧随其后的分支。
  if (!ids.size) return messages;
  // 把计算完成的结果返回给当前方法的调用方。
  return messages.map((message) => {
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (message.role !== 'tool' || typeof message.content !== 'string') return message;
    // 进入可能失败的操作区，异常会交给后面的 catch 或 finally 处理。
    try {
      // 创建 parsed 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
      const parsed = JSON.parse(message.content) as { output?: unknown };
      // 创建 collapse 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
      const collapse = (value: unknown): unknown => {
        // 检查该条件；只有条件成立时才执行紧随其后的分支。
        if (!value || typeof value !== 'object') return value;
        // 创建 record 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
        const record = value as Record<string, unknown>;
        // 检查该条件；只有条件成立时才执行紧随其后的分支。
        if (typeof record.evidenceRef === 'string' && ids.has(record.evidenceRef) && typeof record.text === 'string') {
          // 创建 reference 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
          const reference = { ...record };
          // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
          delete reference.text;
          // 把计算完成的结果返回给当前方法的调用方。
          return { ...reference, cached: true };
        // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
        }
        // 把计算完成的结果返回给当前方法的调用方。
        return value;
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      };
      // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      parsed.output = Array.isArray(parsed.output) ? parsed.output.map(collapse) : collapse(parsed.output);
      // 把计算完成的结果返回给当前方法的调用方。
      return { ...message, content: JSON.stringify(parsed) };
    // 捕获前面操作抛出的异常，把它转换成模块约定的安全结果。
    } catch { return message; }
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  });
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}

// 模型摘要不可用时的确定性后备：只依赖现有消息和 Ledger，结果可重复。
function deterministicSummary(old: ModelMessage[], ledger: ContextLedger): string {
  // 创建 narrative 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
  const narrative = old.map((message) => `${message.role}: ${typeof message.content === 'string' ? message.content.slice(0, 500) : '[多媒体内容]'}`).join('\n');
  // 把计算完成的结果返回给当前方法的调用方。
  return `ContextLedger V2:\n${ledger.summary()}\n历史片段：\n${narrative}`.slice(0, 12_000);
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}

/** buildHybridContext 的结果同时包含本次请求消息与需要持久化的新历史。 */
export interface ContextBuildResult {
  // 设置 messages 字段，把这一项数据传给目标对象、事件或函数。
  messages: ModelMessage[];
  // 设置 historyMessages 字段，把这一项数据传给目标对象、事件或函数。
  historyMessages: ModelMessage[];
  // 设置 summary 字段，把这一项数据传给目标对象、事件或函数。
  summary: string;
  // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
  semanticSummary?: SemanticSummary;
  // 设置 metrics 字段，把这一项数据传给目标对象、事件或函数。
  metrics: ContextCompactionMetrics;
  // 设置 retrieved 字段，把这一项数据传给目标对象、事件或函数。
  retrieved: MemoryEntry[];
  // 设置 retainedGroupIds 字段，把这一项数据传给目标对象、事件或函数。
  retainedGroupIds: string[];
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}

/**
 * 构建“混合上下文”：权威 Ledger + 相关 Memory + 当前 Evidence + 合法聊天历史。
 * 当 Token 超过预算时，它会压缩旧历史，但始终保护最近协议组和最后工具调用组。
 */
export async function buildHybridContext(options: {
  /** 当前 Session，用于限制 Memory 范围。 */
  sessionId: string;
  /** 当前 Turn，不从 Memory 召回它自身。 */
  currentTurnId?: string;
  /** 尚未加入系统提示的模型消息历史。 */
  messages: ModelMessage[];
  /** 权威任务状态。 */
  ledger: ContextLedger;
  /** 文件正文证据库。 */
  evidence: FileEvidenceStore;
  /** 历史事实检索索引。 */
  memory: MemoryIndex;
  /** 用于召回历史的查询文本。 */
  query: string;
  /** 决定上下文窗口和输出预算。 */
  model: ModelConfig;
  /** 系统提示、工具 Schema 等不在 messages 中的 Token 成本。 */
  fixedTokenCost?: number;
  /** 由真实 prompt usage 校准出的估算倍率。 */
  tokenScale?: number;
  /** true 表示用户显式要求压缩。 */
  force: boolean;
  /** 对旧消息生成语义摘要；失败时返回 null。 */
  summarize: (messages: ModelMessage[], fallback: string) => Promise<SemanticSummary | null>;
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}): Promise<ContextBuildResult> {
  // referenced 只取当前 revision 真正被再次引用过的文件证据。
  const referenced = options.evidence.referenced(options.ledger.revision());
  // availableInput = 模型总窗口 - 输出预算 - 安全余量。
  // 先删除非法工具协议组，再把已经集中注入的 Evidence 正文折叠为引用。
  const safe = collapseReferencedEvidence(sanitizeModelMessages(options.messages), referenced);
  // 可用输入等于总窗口减输出预算和至少 2048 token 的安全余量。
  const availableInput = Math.max(1000, options.model.contextWindow - options.model.maxOutputTokens - Math.max(2048, Math.floor(options.model.contextWindow * 0.05)));
  // Ledger 作为第一条临时 user 消息注入，并明确声明它的权威级别。
  const ledgerState = options.ledger.snapshot();
  // 创建 ledgerMessage 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
  const ledgerMessage: ModelMessage = { role: 'user', content: `[权威任务状态，不得被历史摘要覆盖]\n${JSON.stringify(ledgerState, null, 2)}` };
  // 将最新 Ledger 同步到 Memory，确保决策、验证和错误使用权威版本。
  options.memory.syncLedger(options.sessionId, ledgerState);
  // 避免召回最近六组对话中已经原样出现的事实。
  const recentNaturalText = messageGroups(safe).slice(-6).flat()
    // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
    .flatMap((message) => typeof message.content === 'string' ? [message.content.trim()] : []);
  // 创建 retrieved 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
  const retrieved = options.memory.retrieve(options.query, options.ledger.revision(), 6, 4000, options.currentTurnId)
    // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
    .filter((entry) => !recentNaturalText.some((text) => text === entry.text.trim() || text.startsWith(entry.text.trim())));
  // 有召回内容时才创建 retrievalMessage，避免注入空消息。
  const retrievalMessage: ModelMessage | undefined = retrieved.length ? { role: 'user', content: `[按需召回的历史事实]\n${retrieved.map((item) => `- [${item.kind}] ${item.text}`).join('\n').slice(0, 4000)}` } : undefined;
  // Evidence 只注入当前 revision 被重复引用的片段，并限制总字符数。
  const evidenceMessage: ModelMessage | undefined = referenced.length ? { role: 'user', content: `[当前 revision 的文件证据]\n${referenced.map((item) => `--- ${item.path}:${item.startLine}-${item.endLine} ref=${item.id} hash=${item.contentHash}\n${item.text}`).join('\n').slice(0, 20_000)}` } : undefined;
  // ephemeral 只用于本次请求，不直接写回长期聊天历史。
  const ephemeral = [ledgerMessage, ...(retrievalMessage ? [retrievalMessage] : []), ...(evidenceMessage ? [evidenceMessage] : [])];
  // fixedTokenCost 包含系统提示和工具 Schema 等 messages 之外的固定成本。
  const fixedTokenCost = options.fixedTokenCost ?? 0;
  // 校准倍率限制在 0.5～4，避免异常 usage 让预算完全失真。
  const tokenScale = Math.min(4, Math.max(0.5, options.tokenScale ?? 1));
  // tokenCost 把固定成本和消息估算相加，再应用真实 usage 校准倍率。
  const tokenCost = (value: ModelMessage[]) => Math.ceil((fixedTokenCost + estimateTokens(value)) * tokenScale);
  // groupIds 用每组内容的短哈希记录压缩后保留了哪些协议组。
  const groupIds = (value: ModelMessage[][]) => value.map((group) => contentHash(JSON.stringify(group)).slice(0, 16));
  // 超过可用输入的 75%，或用户显式请求 compact_context 时触发压缩。
  // beforeTokens 是压缩前本轮完整混合上下文的校准估算。
  const beforeTokens = tokenCost([...ephemeral, ...safe]);
  // 显式请求且历史足够长，或自动达到可用输入 75% 时触发压缩。
  const shouldCompact = (options.force && safe.length > 4) || beforeTokens > availableInput * 0.75;
  // 不需要压缩时直接返回“临时权威上下文 + 原合法历史”。
  if (!shouldCompact) return {
    // 本轮请求由临时权威上下文和原合法历史直接组成。
    messages: [...ephemeral, ...safe],
    // 长期历史保持 safe，不写入临时 Ledger、Memory 或 Evidence 消息。
    historyMessages: safe,
    // 没有压缩时不存在摘要正文。
    summary: '',
    // 指标明确标记 compacted=false，并记录召回数和 token 倍率。
    metrics: { beforeTokens, afterTokens: beforeTokens, availableInput, compacted: false, retrievedEntries: retrieved.length, droppedEvidence: 0, tokenScale, summaryUsed: false },
    // 返回本轮实际注入的检索条目。
    retrieved,
    // 记录全部合法历史协议组的短标识。
    retainedGroupIds: groupIds(messageGroups(safe)),
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  };

  // 第一层廉价压缩：只折叠旧工具正文，保留 assistant/tool 配对和稳定引用。
  const originalGroups = messageGroups(safe);
  // 创建 cheapPrunedGroups 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
  let cheapPrunedGroups = 0;
  // 创建 cheapGroups 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
  const cheapGroups = originalGroups.map((group, index) => {
    // 创建 protectedByRecency 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const protectedByRecency = index >= Math.max(0, originalGroups.length - 6);
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (protectedByRecency || group[0]?.role !== 'assistant' || !group[0].toolCalls?.length) return group;
    // 创建 changed 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    let changed = false;
    // 创建 collapsed 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const collapsed = group.map((message) => {
      // 检查该条件；只有条件成立时才执行紧随其后的分支。
      if (message.role !== 'tool' || typeof message.content !== 'string' || message.content.length <= 1200) return message;
      // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      changed = true;
      // 创建 artifactRef 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
      let artifactRef: string | undefined;
      // 进入可能失败的操作区，异常会交给后面的 catch 或 finally 处理。
      try {
        // 创建 parsed 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
        const parsed = JSON.parse(message.content) as { artifactRef?: unknown };
        // 检查该条件；只有条件成立时才执行紧随其后的分支。
        if (typeof parsed.artifactRef === 'string') artifactRef = parsed.artifactRef;
      // 捕获前面操作抛出的异常，把它转换成模块约定的安全结果。
      } catch { /* 非 JSON 工具正文没有可保留的 Artifact 引用。 */ }
      // 把计算完成的结果返回给当前方法的调用方。
      return { ...message, content: JSON.stringify({ archivedToolResult: true, toolName: message.toolName, toolCallId: message.toolCallId, ...(artifactRef ? { artifactRef } : {}), note: '旧工具正文已折叠；需要时重新读取文件或使用 artifactRef。' }) };
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (changed) cheapPrunedGroups += 1;
    // 把计算完成的结果返回给当前方法的调用方。
    return collapsed;
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  });
  // 创建 cheapSafe 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
  const cheapSafe = cheapGroups.flat();
  // 创建 target 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
  const target = availableInput * 0.60;
  // 创建 cheapRequest 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
  const cheapRequest = [...ephemeral, ...cheapSafe];
  // 检查该条件；只有条件成立时才执行紧随其后的分支。
  if (cheapPrunedGroups > 0 && tokenCost(cheapRequest) <= target) {
    // 创建 afterTokens 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const afterTokens = tokenCost(cheapRequest);
    // 把计算完成的结果返回给当前方法的调用方。
    return {
      // 设置 messages 字段，把这一项数据传给目标对象、事件或函数。
      messages: cheapRequest,
      // 设置 historyMessages 字段，把这一项数据传给目标对象、事件或函数。
      historyMessages: cheapSafe,
      // 设置 summary 字段，把这一项数据传给目标对象、事件或函数。
      summary: '',
      // 设置 metrics 字段，把这一项数据传给目标对象、事件或函数。
      metrics: { beforeTokens, afterTokens, availableInput, compacted: true, retrievedEntries: retrieved.length, droppedEvidence: 0, tokenScale, cheapPrunedGroups, summaryUsed: false },
      // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
      retrieved,
      // 设置 retainedGroupIds 字段，把这一项数据传给目标对象、事件或函数。
      retainedGroupIds: groupIds(cheapGroups),
    }; // 完成旧格式到 V2 的迁移。
  } // 结束 Ledger 恢复方法。

  // 最后一组消息和最后一个工具协议组永远不能被摘要或拆开。
  const groups = cheapGroups;
  // 创建 lastGroupIndex 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
  const lastGroupIndex = groups.length - 1;
  // 创建 lastToolGroupIndex 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
  let lastToolGroupIndex = -1;
  // 从后向前寻找最近的 assistant/tool 协议组。
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    // 创建 first 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
    const first = groups[index]?.[0];
    // 检查该条件；只有条件成立时才执行紧随其后的分支。
    if (first?.role === 'assistant' && first.toolCalls?.length) { lastToolGroupIndex = index; break; }
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }
  // 创建 protectedIndexes 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
  const protectedIndexes = new Set([lastGroupIndex, lastToolGroupIndex].filter((index) => index >= 0));
  // 最近六组优先保留原文，同时合并上面的强制保护索引。
  const keptIndexes = new Set([
    // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
    ...groups.slice(-Math.min(6, groups.length)).map((_, offset) => groups.length - Math.min(6, groups.length) + offset),
    // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
    ...protectedIndexes,
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  ]);
  // selectedMessages 每次根据 keptIndexes 重新生成按原顺序排列的消息。
  const selectedMessages = () => [...keptIndexes].sort((left, right) => left - right).flatMap((index) => groups[index] ?? []);
  // 创建 keep 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
  let keep = selectedMessages();
  // 摘要覆盖除强制保护组之外的历史。这样后续为了预算移除“最近原文”时，事实仍在摘要中。
  const old = groups.flatMap((group, index) => protectedIndexes.has(index) ? [] : group);
  // 先尝试语义摘要；失败时使用 deterministicSummary。
  // fallback 是不依赖模型、结果可重复的确定性摘要。
  const fallback = deterministicSummary(old, options.ledger);
  // 只有确实存在旧消息时才调用昂贵语义摘要；失败会返回 null。
  const semantic = old.length ? await options.summarize(old, fallback) : null;
  // 创建 summary 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
  let summary = semantic ? JSON.stringify(semantic) : fallback;
  // 创建 summaryMessage 变量，保存当前步骤得到的数据或状态，供后续分支和调用复用。
  let summaryMessage: ModelMessage = { role: 'user', content: `[历史压缩摘要]\n[仅作叙事参考]\n${summary}` };
  // activeRetrieved 可在预算仍超限时首先被移除。
  let activeRetrieved = retrievalMessage;
  // activeEvidence 保存当前仍准备注入的 Evidence 消息。
  let activeEvidence = evidenceMessage;
  // droppedEvidence 记录为释放预算而移除了多少条证据。
  let droppedEvidence = 0;
  // request 是一个闭包：每次调用都读取当前 activeRetrieved/activeEvidence/keep。
  const request = () => [ledgerMessage, ...(activeRetrieved ? [activeRetrieved] : []), ...(activeEvidence ? [activeEvidence] : []), summaryMessage, ...keep];
  // 目标控制在输入窗口 60%，为后续迭代和工具结果留出增长空间。
  const exceedsTarget = () => tokenCost(request()) > target;
  // 按“检索结果 → Evidence → 超长摘要 → 较旧原文”的顺序逐级释放预算。
  if (exceedsTarget()) activeRetrieved = undefined;
  // 检查该条件；只有条件成立时才执行紧随其后的分支。
  if (exceedsTarget() && activeEvidence) { activeEvidence = undefined; droppedEvidence = referenced.length; }
  // 检查该条件；只有条件成立时才执行紧随其后的分支。
  if (exceedsTarget() && summary.length > 4000) { summary = summary.slice(0, 4000); summaryMessage = { role: 'user', content: `[历史压缩摘要]\n[仅作叙事参考]\n${summary}` }; }
  // 只要条件仍成立就继续循环，并在循环体内推进状态。
  while (exceedsTarget()) {
    // 每次移除最旧且不属于 protectedIndexes 的原文组。
    const removable = [...keptIndexes].sort((left, right) => left - right).find((index) => !protectedIndexes.has(index));
    // 已无可移除组时退出，即使估算仍略高，也不能破坏模型协议。
    if (removable === undefined) break;
    // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
    keptIndexes.delete(removable);
    // 执行 context.ts 当前流程中的这一条语句，推进状态或构造下一步需要的数据。
    keep = selectedMessages();
  // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
  }
  // historyMessages 会替换 Session 长期消息；messages 是本次模型请求的完整混合上下文。
  // 长期历史只保存摘要和最终保留原文，不持久化临时 Ledger/检索/Evidence 消息。
  const historyMessages = [summaryMessage, ...keep];
  // 本轮请求重新清理协议组，防止逐级裁剪后留下孤立 Tool Result。
  const messages = sanitizeModelMessages(request());
  // afterTokens 记录所有降级和裁剪完成后的最终估算。
  const afterTokens = tokenCost(messages);
  // 把计算完成的结果返回给当前方法的调用方。
  return { messages, historyMessages, summary, ...(semantic ? { semanticSummary: semantic } : {}), metrics: { beforeTokens, afterTokens, availableInput, compacted: true, summarySource: semantic ? 'model' : 'deterministic-fallback', retrievedEntries: activeRetrieved ? retrieved.length : 0, droppedEvidence, tokenScale, cheapPrunedGroups, summaryUsed: true }, retrieved: activeRetrieved ? retrieved : [], retainedGroupIds: groupIds(messageGroups(historyMessages)) };
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
}
