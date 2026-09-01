// Vitest 提供测试分组、断言和同步/异步测试用例函数。
import { describe, expect, it } from 'vitest';
// 这些协议类型用于构造与生产代码完全一致的模型消息、摘要和工具结果。
import type { ModelMessage, SemanticSummary, ToolResult } from '@seecoder/protocol';
// 导入本文件覆盖的五个上下文核心组件。
import { buildHybridContext, ContextLedger, FileEvidenceStore, MemoryIndex, serializeObservation } from './context.js';

// 假模型配置只用于 Token 预算计算，不会真的发起网络请求。
const model = {
  baseUrl: 'http://fake', // 占位服务地址。
  model: 'fake', // 占位模型名。
  apiKeyEnv: 'UNUSED', // 测试不读取 API Key。
  contextWindow: 10_000, // 让测试能够可预测地触发或避开压缩。
  temperature: 0, // 与上下文算法无关，仅满足 ModelConfig。
  maxOutputTokens: 1000, // 从窗口中预留 1000 Token 给模型输出。
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
};
// semantic 模拟模型摘要器成功返回的结构化历史摘要。
const semantic: SemanticSummary = {
  userIntent: '修复问题', // 压缩前用户的主要目标。
  requirements: ['保留行为'], // 摘要中必须保留的约束。
  activeDecisions: [], // 当前仍有效的设计决定。
  supersededDecisions: [], // 已被替代的旧决定。
  completedWork: [], // 压缩前已完成的工作。
  unresolvedQuestions: [], // 仍待回答的问题。
  narrative: '旧讨论已压缩', // 给模型阅读的简短叙述。
// 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
};

// 这组测试覆盖 Ledger、Evidence、Memory、Observation 与混合上下文构建。
describe('hybrid context', () => {
  // 验证旧版 Ledger 能迁移，并且验证记录只对当前代码 revision 有效。
  it('migrates legacy ledger and tracks revision-scoped validation', () => {
    // 创建空的 V2 Ledger。
    const ledger = new ContextLedger();
    // restore 传入没有 version 字段的旧结构，触发兼容迁移逻辑。
    ledger.restore({ goal: '旧任务', changedFiles: ['a.ts'], tests: ['通过: pnpm test'], errors: ['旧错误'] });
    // 迁移后应变成 V2，同时保留目标且初始修改版本为 0。
    expect(ledger.snapshot()).toMatchObject({ version: 2, goal: '旧任务', changeRevision: 0 });
    // 第一次代码修改把 Ledger 推进到一个新 revision。
    ledger.recordChanges([{ path: 'a.ts', after: 'one' }]);
    // 记录当前 revision 上成功执行的测试。
    ledger.addValidation('pnpm test', true, 'ok');
    // 刚记录的成功测试应被判断为“新鲜验证”。
    expect(ledger.hasFreshValidation()).toBe(true);
    // 再次修改同一代码文件会推进 revision，使旧验证过期。
    ledger.recordChanges([{ path: 'a.ts', after: 'two' }]);
    // 上一 revision 的验证不能证明当前代码正确。
    expect(ledger.hasFreshValidation()).toBe(false);
    // TypeScript 文件变化属于代码变化，因此需要重新验证。
    expect(ledger.requiresFreshValidation()).toBe(true);
    // 单独创建 Ledger，验证纯文档变更的特殊规则。
    const documentation = new ContextLedger();
    // README.md 只包含说明文字，不要求运行代码测试。
    documentation.recordChanges([{ path: 'README.md', after: '# Updated' }]);
    // 纯文档 revision 不应强制要求验证命令。
    expect(documentation.requiresFreshValidation()).toBe(false);
    // JSON 配置可能改变程序行为，因此不能视作纯文档。
    documentation.recordChanges([{ path: 'config.json', after: '{}' }]);
    // 配置变化后应要求新鲜验证。
    expect(documentation.requiresFreshValidation()).toBe(true);
  }); // 结束 Ledger 迁移与验证新鲜度测试。

  // 验证相同文件正文会去重，而文件修改后旧证据会失效。
  it('deduplicates evidence by content and invalidates it after changes', () => {
    // 创建空文件证据存储。
    const evidence = new FileEvidenceStore();
    // 首次记录 a.ts 第一行正文，revision 为 0。
    const first = evidence.record('src/a.ts', 'const a = 1;', 1, 1, 0);
    // 使用相同路径、范围、正文和 revision 再记录一次。
    const second = evidence.record('src/a.ts', 'const a = 1;', 1, 1, 0);
    // 第一条是新证据，不应标记重复。
    expect(first.duplicate).toBe(false);
    // 第二条内容完全相同，应只返回引用而不重复注入正文。
    expect(second.duplicate).toBe(true);
    // revision 0 当前只有一份可引用的权威正文。
    expect(evidence.referenced(0)).toHaveLength(1);
    // 模拟工具修改 src/a.ts，使此前读取的正文不再可靠。
    evidence.invalidate(['src/a.ts']);
    // 失效证据不能继续进入 revision 0 的上下文。
    expect(evidence.referenced(0)).toEqual([]);
    // revision 1 的新正文应重新被视为非重复证据。
    expect(evidence.record('src/a.ts', 'const a = 2;', 1, 1, 1).duplicate).toBe(false);
  }); // 结束 Evidence 去重与失效测试。

  // 验证不同工具结果采用不同压缩策略，同时保留定位错误需要的诊断信息。
  it('compresses observations by tool semantics while preserving diagnostics', () => {
    // Ledger 接收工具带来的权威状态变化。
    const ledger = new ContextLedger();
    // Evidence 保存 read_file 返回的正文，并识别重复读取。
    const evidence = new FileEvidenceStore();
    // 构造一次成功读取 a.ts 第一行的标准 ToolResult。
    const read: ToolResult = {
      ok: true, // 工具执行成功。
      output: { path: 'a.ts', startLine: 1, endLine: 1, text: 'hello' }, // 真实读取内容。
      durationMs: 2, // 模拟两毫秒耗时。
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    };
    // 首次序列化必须保留正文，模型才能读取文件内容。
    expect(JSON.parse(serializeObservation('read_file', {}, read, ledger, evidence)).output.text).toBe('hello');
    // 第二次相同读取应返回 cached 标记，避免重复注入 hello 正文。
    expect(JSON.parse(serializeObservation('read_file', {}, read, ledger, evidence)).output.cached).toBe(true);
    // 构造包含超长 stdout 和精确文件行号错误的失败命令结果。
    const command: ToolResult = {
      ok: false, // 非零退出码对应失败。
      output: { exitCode: 1, stdout: 'x'.repeat(8000), stderr: 'src/a.ts:12 error broken' }, // 原始进程输出。
      error: { code: 'command_failed', message: '退出码 1' }, // 给状态机使用的结构化错误。
      durationMs: 10, // 模拟十毫秒耗时。
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    };
    // 将 run_command 结果按命令语义裁剪为模型 Observation。
    const compacted = JSON.parse(serializeObservation('run_command', { command: 'pnpm test' }, command, ledger, evidence));
    // 8000 个字符应触发截断标志。
    expect(compacted.output.truncated).toBe(true);
    // 即使正文被截断，包含文件和行号的诊断仍必须保留。
    expect(compacted.output.diagnostics).toContain('src/a.ts:12 error broken');
    // list_files 的 truncated/limit 是正确继续分页所需信息，不能在序列化时丢失。
    const listed = JSON.parse(serializeObservation('list_files', {}, { ok: true, output: { entries: ['README.md'], count: 1, truncated: true, limit: 200 }, durationMs: 1 }, ledger, evidence));
    // 断言目录列表的四个关键字段原样保存。
    expect(listed.output).toEqual({ entries: ['README.md'], count: 1, truncated: true, limit: 200 });
    // before 为 null 表示 write_file 创建了此前不存在的新文件。
    const created = JSON.parse(serializeObservation('write_file', {}, { ok: true, output: { kind: 'changes', files: [{ path: 'new.md', before: null, after: '# New' }] }, durationMs: 1 }, ledger, evidence));
    // before 有旧内容表示 write_file 更新了已有文件。
    const updated = JSON.parse(serializeObservation('write_file', {}, { ok: true, output: { kind: 'changes', files: [{ path: 'README.md', before: '# Old', after: '# New' }] }, durationMs: 1 }, ledger, evidence));
    // 序列化器应把 null before 归类为 created。
    expect(created.output.files[0].operation).toBe('created');
    // 序列化器应把非空 before 归类为 updated。
    expect(updated.output.files[0].operation).toBe('updated');
  }); // 结束 Observation 语义压缩测试。

  // 验证中文关键词和代码路径可检索，同时旧 revision 的验证不会被召回。
  it('retrieves Chinese terms and paths while excluding stale validations', () => {
    // 创建空的长期事实索引。
    const memory = new MemoryIndex();
    // 两条事实使用同一时间，避免时间差影响相关性排序。
    const now = new Date().toISOString();
    // 添加 revision 2 的活跃设计决定，正文同时包含中文和路径。
    memory.add({ kind: 'decision', text: '登录状态统一由 src/auth/store.ts 管理', sessionId: 't', revision: 2, timestamp: now, status: 'active' });
    // 添加 revision 1 的成功验证；对当前 revision 2 来说已经过期。
    memory.add({ kind: 'validation', text: '登录测试通过', sessionId: 't', revision: 1, timestamp: now, status: 'active' });
    // 用中文短语和精确路径检索当前 revision 2。
    const result = memory.retrieve('登录状态 src/auth/store.ts', 2);
    // 活跃决定应命中查询。
    expect(result.some((item) => item.kind === 'decision')).toBe(true);
    // 旧 revision 的验证不得被误当成当前代码仍通过。
    expect(result.some((item) => item.kind === 'validation')).toBe(false);
  }); // 结束中文与路径检索测试。

  // 验证构建当前 Turn 上下文时不会把同一 Turn 的消息又当作“历史记忆”召回。
  it('does not retrieve messages from the current turn as historical memory', () => {
    // 创建空 MemoryIndex。
    const memory = new MemoryIndex();
    // 固定两条测试事实的时间戳。
    const now = new Date().toISOString();
    // 添加属于 current Turn 的用户问题。
    memory.add({ kind: 'user', text: '后端启动入口在哪里', sessionId: 't', turnId: 'current', revision: 0, timestamp: now, status: 'active' });
    // 添加 older Turn 中已经形成的历史决定。
    memory.add({ kind: 'decision', text: '后端启动入口位于 backend/main.py', sessionId: 't', turnId: 'older', revision: 0, timestamp: now, status: 'active' });
    // 最后一个参数 current 告诉检索器排除当前 Turn。
    const result = memory.retrieve('后端启动入口', 0, 6, 4000, 'current');
    // 当前 Turn 的消息不应作为额外历史副本返回。
    expect(result.some((item) => item.turnId === 'current')).toBe(false);
    // 更早 Turn 的相关决定仍应正常召回。
    expect(result.some((item) => item.turnId === 'older')).toBe(true);
  }); // 结束当前 Turn 排除测试。

  // 验证最近上下文已经包含的自然语言不会再以 retrieved memory 形式重复注入。
  it('does not inject a retrieved copy of natural language already present in recent context', async () => {
    // 创建空索引。
    const memory = new MemoryIndex();
    // 为历史事实生成合法 ISO 时间。
    const now = new Date().toISOString();
    // 添加一条与最近 assistant 消息完全相同的旧记忆。
    memory.add({ kind: 'assistant', text: '启动入口位于 backend/main.py', sessionId: 't', turnId: 'older', revision: 0, timestamp: now, status: 'active' });
    // 构造一组协议完整的近期消息：assistant tool call、tool result、下一条 user。
    const messages: ModelMessage[] = [
      // assistant 正文已经包含旧记忆的内容，并调用 finish。
      { role: 'assistant', content: '启动入口位于 backend/main.py', toolCalls: [{ id: 'finish-1', name: 'finish', arguments: '{"summary":"完成"}' }] },
      // tool 消息与 finish-1 配对，保持模型协议合法。
      { role: 'tool', content: '{"ok":true}', toolCallId: 'finish-1', toolName: 'finish' },
      // 最新用户消息继续询问同一路径。
      { role: 'user', content: '请继续说明 backend/main.py' },
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    ];
    // 构建混合上下文；空间充足时不应触发摘要。
    const result = await buildHybridContext({ sessionId: 't', currentTurnId: 'current', messages, ledger: new ContextLedger(), evidence: new FileEvidenceStore(), memory, query: 'backend/main.py', model, force: false, summarize: async () => semantic });
    // 因为文本已在最近消息中，去重后 retrieved 应为空。
    expect(result.retrieved).toEqual([]);
  }); // 结束自然语言去重测试。

  // 验证同一文件被重复读取后，最终模型上下文只保留一份权威正文。
  it('keeps one authoritative file body after a duplicate read references Evidence', async () => {
    // 创建工具观察会更新的 Ledger。
    const ledger = new ContextLedger();
    // 创建用于重复正文识别的 EvidenceStore。
    const evidence = new FileEvidenceStore();
    // 使用独特正文，稍后可通过字符串分割精确计算出现次数。
    const body = 'const evidenceBody = 42;';
    // 构造两次 read_file 共用的成功结果。
    const toolResult: ToolResult = { ok: true, output: { path: 'src/a.ts', startLine: 1, endLine: 1, text: body }, durationMs: 1 };
    // 首次序列化保存正文并登记 Evidence。
    const first = serializeObservation('read_file', {}, toolResult, ledger, evidence);
    // 第二次序列化应生成指向首份 Evidence 的轻量引用。
    const second = serializeObservation('read_file', {}, toolResult, ledger, evidence);
    // 构造两组严格配对的 assistant/tool 消息。
    const messages: ModelMessage[] = [
      // 第一组 read_file 调用声明。
      { role: 'assistant', content: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: '{"path":"src/a.ts"}' }] },
      // 第一组结果包含权威正文。
      { role: 'tool', content: first, toolCallId: 'r1', toolName: 'read_file' },
      // 第二组重复 read_file 调用声明。
      { role: 'assistant', content: '', toolCalls: [{ id: 'r2', name: 'read_file', arguments: '{"path":"src/a.ts"}' }] },
      // 第二组结果只应引用 Evidence。
      { role: 'tool', content: second, toolCallId: 'r2', toolName: 'read_file' },
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    ];
    // 构建最终模型上下文，同时提供同一个 Ledger 和 Evidence 实例。
    const result = await buildHybridContext({ sessionId: 't', currentTurnId: 'current', messages, ledger, evidence, memory: new MemoryIndex(), query: 'a.ts', model, force: false, summarize: async () => semantic });
    // split 长度为 2 表示独特正文恰好出现一次。
    expect(JSON.stringify(result.messages).split(body)).toHaveLength(2);
  }); // 结束重复文件正文去重测试。

  // 验证超预算时使用语义摘要，同时保留完整工具协议组并达到目标预算。
  it('uses semantic summary, preserves tool groups and reaches the target budget', async () => {
    // 创建 Ledger 并写入不能被摘要覆盖的权威目标。
    const ledger = new ContextLedger();
    // 目标也会进入压缩后的权威上下文区。
    ledger.setGoal('修复问题');
    // 创建 16 条较长消息，确保接近 10k 上下文窗口并触发压缩。
    const messages: ModelMessage[] = Array.from({ length: 16 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `${index}-${'上下文'.repeat(300)}` }));
    // 在尾部加入 assistant 工具调用。
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }] });
    // 紧接对应工具结果，用于验证压缩不会拆散协议组。
    messages.push({ role: 'tool', content: '{"ok":true}', toolCallId: 'c1', toolName: 'read_file' });
    // summarize 返回预置 semantic，模拟模型摘要成功。
    const result = await buildHybridContext({ sessionId: 't', messages, ledger, evidence: new FileEvidenceStore(), memory: new MemoryIndex(), query: '修复问题', model, force: false, summarize: async () => semantic });
    // 长消息应实际触发压缩。
    expect(result.metrics.compacted).toBe(true);
    // 成功使用结构化摘要后，来源应标记为 model。
    expect(result.metrics.summarySource).toBe('model');
    // 压缩后 Token 应进入可用输入预算的 60% 目标线内。
    expect(result.metrics.afterTokens).toBeLessThanOrEqual(result.metrics.availableInput * 0.60);
    // 查找压缩后仍含 c1 调用的 assistant 消息。
    const assistant = result.messages.find((message) => message.role === 'assistant' && message.toolCalls?.[0]?.id === 'c1');
    // 查找与 c1 配对的 tool 结果。
    const tool = result.messages.find((message) => message.role === 'tool' && message.toolCallId === 'c1');
    // assistant 半组没有被摘要器删除。
    expect(assistant).toBeDefined();
    // tool 半组也同时保留，协议仍然合法。
    expect(tool).toBeDefined();
  }); // 结束语义摘要预算与协议组测试。

  // 验证模型摘要器失败时仍可用确定性摘要继续运行，并保留权威目标。
  it('falls back deterministically when semantic summary fails', async () => {
    // 创建空 Ledger。
    const ledger = new ContextLedger();
    // 写入即使模型摘要失败也不能丢失的任务目标。
    ledger.setGoal('不能丢失的目标');
    // 十条重复长消息提供足够内容供强制压缩。
    const messages: ModelMessage[] = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: '旧消息'.repeat(200) }));
    // force=true 强制走压缩；summarize 返回 null 模拟摘要请求失败。
    const result = await buildHybridContext({ sessionId: 't', messages, ledger, evidence: new FileEvidenceStore(), memory: new MemoryIndex(), query: '目标', model, force: true, summarize: async () => null });
    // 算法应明确记录使用了无需模型的后备摘要。
    expect(result.metrics.summarySource).toBe('deterministic-fallback');
    // 后备摘要必须包含 Ledger 中的权威目标。
    expect(result.summary).toContain('不能丢失的目标');
  }); // 结束确定性后备摘要测试。

  // 验证旧工具结果会先做廉价折叠，足够省空间时不额外调用模型摘要。
  it('uses cheap old-tool folding before requesting a semantic summary', async () => {
    // 从空消息数组开始构造大量完整工具组。
    const messages: ModelMessage[] = [];
    // 连续创建 20 组旧 read_file 调用和超长结果。
    for (let index = 0; index < 20; index += 1) {
      // 每个 assistant 调用使用独立 callId，便于协议分组。
      messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `tool-${index}`, name: 'read_file', arguments: '{}' }] });
      // 每个工具结果含 3000 字符，确保原始历史明显超预算。
      messages.push({ role: 'tool', content: JSON.stringify({ ok: true, output: 'x'.repeat(3000) }), toolCallId: `tool-${index}`, toolName: 'read_file' });
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    }
    // 用计数器确认 summarize 回调是否真的被调用。
    let summaryCalls = 0;
    // 构建混合上下文，并把窗口调大到“折叠后足够、折叠前不足”的范围。
    const result = await buildHybridContext({
      sessionId: 't', // Memory 的会话隔离 key。
      messages, // 上面构造的 20 组旧工具历史。
      ledger: new ContextLedger(), // 本用例不需要预置权威状态。
      evidence: new FileEvidenceStore(), // 本用例只测试旧结果折叠。
      memory: new MemoryIndex(), // 不加入额外召回内容。
      query: '', // 空查询避免 Memory 检索影响预算。
      model: { ...model, contextWindow: 20_000 }, // 覆盖窗口大小。
      force: false, // 让算法按预算自动选择最低成本压缩方式。
      // 设置 summarize 字段，把这一项数据传给目标对象、事件或函数。
      summarize: async () => {
        // 如果进入模型摘要阶段，就递增调用次数。
        summaryCalls += 1;
        // 返回合法结构，确保即使误调用也不会因测试桩报错。
        return semantic;
      // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
      },
    // 结束当前代码块、对象、数组或函数调用，返回上一层执行结构。
    });
    // 工具折叠也属于一次上下文压缩。
    expect(result.metrics.compacted).toBe(true);
    // 至少一组旧工具结果应被替换为轻量归档信息。
    expect(result.metrics.cheapPrunedGroups).toBeGreaterThan(0);
    // 廉价折叠已经达到预算，因此不应使用语义摘要。
    expect(result.metrics.summaryUsed).toBe(false);
    // 回调次数为 0，从行为上证明没有请求摘要模型。
    expect(summaryCalls).toBe(0);
    // 最终消息中应存在 archivedToolResult 标记，告诉模型该旧结果已折叠。
    expect(result.messages.some((message) => typeof message.content === 'string' && message.content.includes('archivedToolResult'))).toBe(true);
  }); // 结束廉价工具折叠测试。
}); // 结束 hybrid context 测试组。
