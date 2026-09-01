// 临时工作区测试需要创建目录、读写测试文件，并在 finally 中删除目录。
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
// tmpdir 提供不会污染项目仓库的系统临时目录。
import { tmpdir } from 'node:os';
// join 使用当前平台的路径分隔符组合目录和文件名。
import { join } from 'node:path';
// Vitest 提供测试分组、断言和异步用例函数。
import { describe, expect, it } from 'vitest';
// z 用来为测试专用工具声明运行时参数 Schema。
import { z } from 'zod';
// FakeModelProvider 按预设事件数组模拟模型的流式返回。
import { FakeModelProvider } from '@seecoder/model';
// 这些协议类型帮助测试桩严格实现真实 Provider、Hook 和请求接口。
import type { HookStage, ModelEvent, ModelProvider, ModelRequest } from '@seecoder/protocol';
// SessionStore 把事件、状态和 Artifact 写入临时目录，覆盖真实持久化路径。
import { SessionStore } from '@seecoder/storage';
// createToolDefinitions 提供内置工具，ToolRegistry 可注册测试专用工具。
import { createToolDefinitions, ToolRegistry } from '@seecoder/tools';
// AgentCore 是被测对外门面；两个类型用于构造 Hook 和拦截器测试替身。
import { AgentCore, type AgentInterceptor, type HookRuntime } from './index';

// 所有集成用例共用的假模型配置；Provider 均为内存测试桩，不访问该 URL。
const model = {
  baseUrl: 'http://fake', // 占位模型服务地址。
  model: 'fake', // 占位模型名。
  apiKeyEnv: 'UNUSED', // 测试不会读取环境变量。
  contextWindow: 20_000, // 默认上下文窗口，部分压缩测试会覆盖。
  temperature: 0, // 固定为零，表达测试期望确定性行为。
  maxOutputTokens: 2000, // 为模型输出预留的 Token 数。
// 结束当前对象、数组、回调或测试代码块。
};

// RecordingProvider 除了返回预设事件，还保存每次完整请求，便于检查提示词和消息链。
class RecordingProvider implements ModelProvider {
  // requests 依次保存所有主请求和上下文摘要请求的深拷贝。
  readonly requests: ModelRequest[] = [];
  // cursor 指向下一组主 Agent 流事件。
  private cursor = 0;
  // turns 的每个元素代表一次主模型请求要返回的事件序列。
  constructor(private readonly turns: ModelEvent[][]) {}
  // 测试通常只关心主 Agent 请求，因此过滤掉内部 context_summary 请求。
  get agentRequests(): ModelRequest[] {
    // purpose 为空或 agent 的请求都属于主 Agent 循环。
    return this.requests.filter((request) => request.purpose !== 'context_summary');
  // 结束当前对象、数组、回调或测试代码块。
  }
  // AsyncGenerator 模拟生产 Provider 的流式接口。
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    // structuredClone 防止 AgentCore 后续修改对象而污染测试记录。
    this.requests.push(structuredClone(request));
    // 摘要请求使用固定合法 JSON 响应，不消耗主请求 turns 游标。
    if (request.purpose === 'context_summary') {
      // textDelta 携带符合 SemanticSummary 结构的 JSON 字符串。
      yield { type: 'textDelta', text: JSON.stringify({ userIntent: '', requirements: [], activeDecisions: [], supersededDecisions: [], completedWork: [], unresolvedQuestions: [], narrative: '测试摘要' }) };
      // completed 通知摘要器流已正常结束。
      yield { type: 'completed', finishReason: 'stop' };
      // 摘要分支到此结束，不继续读取主请求事件。
      return;
    // 结束当前对象、数组、回调或测试代码块。
    }
    // 游标超过数组时复用最后一组，避免测试桩因额外请求直接越界。
    const events = this.turns[Math.min(this.cursor++, this.turns.length - 1)] ?? [];
    // 按数组顺序逐个 yield，模拟模型分片到达顺序。
    for (const event of events) {
      // 测试 Provider 向 Agent 循环发送这一条模型流事件。
      yield event;
    // 结束当前对象、数组、回调或测试代码块。
    }
  // 结束当前对象、数组、回调或测试代码块。
  }
// 结束当前对象、数组、回调或测试代码块。
}

// AgentCore 集成测试从对外 API 验证 Session、Turn、工具、上下文和持久化协作。
describe('AgentCore', () => {
  // 验证子分支只继承分叉点以前的历史，并且后续 rewind 不受父分支继续增长影响。
  it('creates incremental branches and keeps rewind independent from parent growth', async () => {
    // 为分支测试创建独立工作区，SessionStore 会把事件写在这里。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-core-branch-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // .sessions 目录模拟应用真实的本地 Session 存储。
      const store = new SessionStore(join(root, '.sessions'));
      // 本用例只操作 Session，不运行模型，因此使用空 FakeModelProvider。
      const core = new AgentCore({ workspace: root, provider: new FakeModelProvider([]), model, store, mode: 'auto' });
      // parent 是整棵分支树的根 Session。
      const parent = await core.createSession('父任务');
      // 手工追加分叉前事件，seq 会成为子分支可继承的历史。
      await store.append(parent.id, { event: { type: 'message.user', timestamp: '2026-01-01', turnId: 'manual', text: '分叉前', sessionId: parent.id } });
      // 从事件序号 2 创建增量子分支。
      const child = await core.forkFrom(parent.id, 2);
      // lineage 必须记录直接父节点、分叉序号以及根节点。
      expect(child.lineage).toMatchObject({ parentSessionId: parent.id, forkedFromSeq: 2, rootSessionId: parent.id });
      // 子分支状态由分叉点前事件重放得到，目标应是“分叉前”。
      expect(await store.readState<{ goal: string }>(child.id)).toMatchObject({ goal: '分叉前' });
      // 分叉完成后继续向父分支追加新消息。
      await store.append(parent.id, { event: { type: 'message.user', timestamp: '2026-01-02', turnId: 'later', text: '父分支后来内容', sessionId: parent.id } });
      // 读取子分支的合并视图：父前缀加子分支自己的增量。
      const childHistory = await core.readSessionEvents(child.id);
      // 分叉点以前的父事件应被继承。
      expect(childHistory.some((event) => event.type === 'message.user' && event.text === '分叉前')).toBe(true);
      // 分叉点以后父分支新增的事件不能渗入子分支。
      expect(childHistory.some((event) => event.type === 'message.user' && event.text === '父分支后来内容')).toBe(false);
      // rewind 从 child 当前视图的序号 2 再创建一个新分支，而不是原地删历史。
      const rewound = await core.rewindSession(child.id, 2);
      // 自动标题包含 Rewind，方便 UI 识别这是回退分支。
      expect(rewound.title).toContain('Rewind');
      // switchBranch 应能装载并返回指定 child，而不改变其 id。
      expect(await core.switchBranch(child.id)).toMatchObject({ id: child.id });
      // 向父分支写入 compaction 快照，建立可安全分叉的压缩下界。
      await store.append(parent.id, {
        // context.compacted 是实时/回放事件。
        event: { type: 'context.compacted', timestamp: '2026-01-03', turnId: 'compact', summary: '摘要', sessionId: parent.id },
        // compaction Item 保存恢复上下文所需的完整快照元数据。
        item: {
          // kind 区分普通消息和压缩记录；id/createdAt 满足 Item 协议。
          kind: 'compaction', id: 'compact-item', summary: '摘要', createdAt: '2026-01-03',
          // coveredEventSeq=3 表示更早事件已被摘要覆盖，不能从其内部任意分叉。
          snapshot: { id: 'snapshot', sessionId: parent.id, coveredEventSeq: 3, retainedGroupIds: [], ledgerRevision: 0, modelKey: 'fake', tokenScale: 1, createdAt: '2026-01-03' },
        // 结束当前对象、数组、回调或测试代码块。
        },
      // 结束当前对象、数组、回调或测试代码块。
      });
      // 序号 3 位于已压缩区域内，系统应提示最早只能从下界 4 分叉。
      await expect(core.forkFrom(parent.id, 3)).rejects.toThrow('压缩下界 4');
      // parent 仍有 child，直接删除会破坏分支树，因此必须拒绝。
      await expect(core.deleteSession(parent.id)).rejects.toThrow('子分支');
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally {
      // 无论断言是否通过，都删除本用例创建的临时工作区。
      await rm(root, { recursive: true, force: true });
    // 结束当前对象、数组、回调或测试代码块。
    }
  }); // 结束增量分支与 rewind 隔离测试。

  // 验证可信 Hook 会在工具前、文件修改后和 Turn 结束三个生命周期边界执行。
  it('runs trusted hooks at tool, file edit and turn end lifecycle points', async () => {
    // 创建 Hook 测试专用临时工作区。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-hooks-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // stages 按真实执行顺序记录 Hook 阶段。
      const stages: HookStage[] = [];
      // 构造始终成功的 Hook Runtime 测试替身。
      const hooks: HookRuntime = {
        // 每个阶段解析出一条唯一命名的测试 Hook。
        async resolve(stage) { return [{ id: `${stage}-hook`, command: 'test', timeoutMs: 1000 }]; },
        // execute 不运行外部命令，只记录阶段并返回成功。
        async execute(_command, context) { stages.push(context.stage); return { ok: true, durationMs: 1 }; },
      // 结束当前对象、数组、回调或测试代码块。
      };
      // 第一轮写文件，第二轮调用 finish，分别触发工具和 Turn 生命周期。
      const provider = new FakeModelProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'write-hooked', name: 'write_file', argsDelta: '{"path":"hooked.txt","content":"ok"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'finish-hooked', name: 'finish', argsDelta: '{"summary":"完成","verification":[]}' }, { type: 'completed', finishReason: 'tool_calls' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 将 Hook Runtime 注入 AgentCore。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto', hooks });
      // events 收集全部事件类型，用于计算 hook.started 次数。
      const events: string[] = [];
      // ended 只在 turnEnd Hook 完成时解决，确保所有 Hook 都已执行。
      const ended = new Promise<void>((resolve) => core.onEvent((event) => { events.push(event.type); if (event.type === 'hook.completed' && event.stage === 'turnEnd') resolve(); }));
      // 创建 Session 并启动写入任务。
      const session = await core.createSession('Hooks 生命周期');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '写入并完成');
      // 等待最后一个 Hook 完成，避免异步断言过早执行。
      await ended;
      // write_file 有 pre/post，finish 有 pre，最后还有 turnEnd，共四个阶段。
      expect(stages).toEqual(['preToolUse', 'postFileEdit', 'preToolUse', 'turnEnd']);
      // 每个 execute 前都应发布一次 hook.started。
      expect(events.filter((event) => event === 'hook.started')).toHaveLength(4);
      // Hook 成功时真实 write_file 仍应把 ok 写入磁盘。
      expect(await readFile(join(root, 'hooked.txt'), 'utf8')).toBe('ok');
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally {
      // 清理临时目录和测试文件。
      await rm(root, { recursive: true, force: true });
    // 结束当前对象、数组、回调或测试代码块。
    }
  }); // 结束 Hook 生命周期测试。

  // 验证 preToolUse Hook 失败会阻止真实写入，但 Turn 仍能收到失败结果并正常收尾。
  it('blocks a tool when preToolUse fails without damaging the turn state', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-hook-block-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 hooks 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const hooks: HookRuntime = {
        // 实现 Hook 配置解析函数，为当前生命周期阶段返回测试命令。
        async resolve(stage) { return stage === 'preToolUse' ? [{ id: 'guard', command: 'guard', timeoutMs: 1000 }] : []; },
        // 实现测试工具或 Hook 的执行函数，模拟真实运行结果。
        async execute() { return { ok: false, durationMs: 1, error: { code: 'command_failed', message: 'guard rejected' } }; },
      // 结束当前对象、数组、回调或测试代码块。
      };
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new FakeModelProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'blocked-write', name: 'write_file', argsDelta: '{"path":"blocked.txt","content":"bad"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '已停止写入。' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto', hooks });
      // 创建 blockedCode 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let blockedCode = '';
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'tool.completed' && event.callId === 'blocked-write') blockedCode = event.result.error?.code ?? ''; if (event.type === 'turn.completed') resolve(); }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('Hook 阻止');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '不要让 guard 失败');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(blockedCode).toBe('hook_blocked');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      await expect(readFile(join(root, 'blocked.txt'), 'utf8')).rejects.toThrow();
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证 textDelta 只实时推送给 UI，持久化层只保存拼接完成的 assistant 消息。
  it('streams text live but persists only the completed assistant message', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-stream-storage-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 store 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const store = new SessionStore(join(root, '.sessions'));
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new RecordingProvider([[
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        { type: 'textDelta', text: '第一段' },
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        { type: 'textDelta', text: '第二段' },
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        { type: 'completed', finishReason: 'stop' },
      // 结束当前对象、数组、回调或测试代码块。
      ]]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store, mode: 'auto' });
      // 创建 live 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const live: string[] = [];
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => {
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'message.delta') live.push(event.text);
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'turn.completed') resolve();
      // 结束当前对象、数组、回调或测试代码块。
      }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('流式持久化');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '回复我');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;

      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(live).toEqual(['第一段', '第二段']);
      // 创建 history 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const history = await store.readEvents(session.id);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(history.some((record) => record.event.type === 'message.delta')).toBe(false);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(history.some((record) => record.event.type === 'message.completed')).toBe(true);
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证系统提示明确要求简洁回答、批量读取和证据足够后停止探索。
  it('asks the model to keep natural tasks concise and avoid serial reads', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-efficient-prompt-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new RecordingProvider([[{ type: 'textDelta', text: '完成' }, { type: 'completed', finishReason: 'stop' }]]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), registry: new ToolRegistry(), mode: 'plan' });
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('自然任务');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '后端从哪里启动？请用几句话说明。');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;
      // 创建 system 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const system = provider.requests[0]?.messages[0]?.content;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(system).toContain('严格匹配用户要求的回答长度');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(system).toContain('一次调用 read_files');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(system).toContain('证据足以回答或实施就停止探索');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(system).toContain('所有用户可见的行动说明、计划、问题、错误解释和最终总结必须使用简体中文');
      // 创建 setPlan 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const setPlan = provider.requests[0]?.tools.find((tool) => tool.function.name === 'set_plan');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(setPlan?.function.parameters).toMatchObject({
        // 设置对象的 properties 字段，构造被测代码所需的输入或配置。
        properties: { steps: { items: { required: ['id', 'label', 'status'] } } },
      // 结束当前对象、数组、回调或测试代码块。
      });
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证显式激活的本地 Skill 会注入系统提示低优先级区域，并产生激活事件。
  it('injects an explicitly activated local skill below safety rules and records activation', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-skill-prompt-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new RecordingProvider([[{ type: 'textDelta', text: '已完成' }, { type: 'completed', finishReason: 'stop' }]]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'plan' });
      // 创建 events 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const events: string[] = [];
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { events.push(event.type); if (event.type === 'turn.completed') resolve(); }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('Skill 测试');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '请检查项目结构', undefined, [], {
        // 设置对象的 skill 字段，构造被测代码所需的输入或配置。
        skill: { id: 'seecoder:project-review', name: 'project-review', description: '项目审查', relativePath: '.seecoder/skills/project-review/SKILL.md' },
        // 设置对象的 content 字段，构造被测代码所需的输入或配置。
        content: '先读取入口文件，再用中文给出三点结论。',
      // 结束当前对象、数组、回调或测试代码块。
      });
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(provider.agentRequests[0]?.messages[0]?.content).toContain('[本轮已激活 Skill：project-review');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(provider.agentRequests[0]?.messages[0]?.content).toContain('先读取入口文件');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(events).toContain('skill.activated');
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证空闲 Session 可以删除，而有运行中 Turn 的 Session 必须先取消。
  it('deletes an idle session but rejects deletion while its turn is active', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-delete-session-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider: ModelProvider = { async *stream() { await new Promise((resolve) => setTimeout(resolve, 100)); yield { type: 'textDelta', text: '完成' }; yield { type: 'completed', finishReason: 'stop' }; } };
      // 创建 store 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const store = new SessionStore(join(root, '.sessions'));
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store, mode: 'plan' });
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('待删除');
      // 创建 turnId 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const turnId = await core.startTurn(session.id, '执行中');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      await expect(core.deleteSession(session.id)).rejects.toThrow('运行中的任务不能删除');
      // 取消指定 Turn，用来验证取消传播和运行态清理。
      core.cancelTurn(turnId);
      // 短暂等待异步回调获得执行机会，避免测试在目标事件到达前继续。
      await new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.cancelled') resolve(); }));
      // 等待 AgentCore 对外方法完成，保证相关内存状态和持久化操作已经生效。
      await core.deleteSession(session.id);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(await store.readSession(session.id)).toBeNull();
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证一次“模型调用工具、工具回填结果、模型自然结束”的完整 Agent 循环。
  it('runs a tool turn and reaches completed', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-core-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 在临时工作区写入测试前置文件，为后续工具读取或变更操作准备真实磁盘状态。
      await writeFile(join(root, 'hello.txt'), 'hello', 'utf8');
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new FakeModelProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [
          // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
          { type: 'toolCallDelta', callId: 'call-1', name: 'list_files', argsDelta: '{"path":"."}' },
          // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
          { type: 'completed', finishReason: 'tool_calls' },
        // 结束当前对象、数组、回调或测试代码块。
        ],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '我已检查工作区。' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), registry: new ToolRegistry(), mode: 'auto' });
      // 创建 events 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const events: string[] = [];
      // 创建 wait 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const wait = new Promise<void>((resolve) => core.onEvent((event) => { events.push(event.type); if (event.type === 'turn.completed') resolve(); }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('测试');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '查看项目');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await wait;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(events).toContain('tool.completed');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(events).toContain('message.completed');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(events).toContain('turn.completed');
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证 finish.summary 会先成为可见且可回放的助手消息，然后 Turn 才进入 completed。
  it('publishes the finish summary as the final assistant message before completing the turn', async () => {
    // 创建与其他测试隔离的临时工作区。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-finish-summary-'));
    // try/finally 确保测试失败时也会删除临时数据。
    try {
      // SessionStore 用于验证最终消息不仅实时发布，而且确实写入磁盘事件流。
      const store = new SessionStore(join(root, '.sessions'));
      // 模型第一轮直接调用 finish，并把用户最终应看到的内容放在 summary 参数中。
      const provider = new FakeModelProvider([
        // finishReason=tool_calls 模拟真实模型通过工具提交最终答案的行为。
        [{ type: 'toolCallDelta', callId: 'finish-visible', name: 'finish', argsDelta: '{"summary":"## 完整最终总结\\n\\n这是用户应看到的答案。","verification":[]}' }, { type: 'completed', finishReason: 'tool_calls' }],
      ]);
      // 创建使用真实 TurnRunner、ToolCallExecutor 与持久化层的 AgentCore。
      const core = new AgentCore({ workspace: root, provider, model, store, mode: 'auto' });
      // visibleMessages 收集 UI 实际会渲染的 message.completed 文本。
      const visibleMessages: string[] = [];
      // terminalOrder 记录最终消息和 Turn 完成事件的先后顺序。
      const terminalOrder: string[] = [];
      // completed Promise 等待后台 Turn 真正结束。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => {
        // message.completed 代表一条正式用户可见的助手消息。
        if (event.type === 'message.completed') {
          // 保存完整文本，验证 summary 没有丢失或被裁剪。
          visibleMessages.push(event.text);
          // 记录它发生在终态之前。
          terminalOrder.push(event.type);
        }
        // turn.completed 到达后，本用例可以安全读取持久化事件。
        if (event.type === 'turn.completed') {
          // 记录最终终态事件。
          terminalOrder.push(event.type);
          // 唤醒等待中的测试主体。
          resolve();
        }
      }));
      // 创建承载本次 Turn 的 Session。
      const session = await core.createSession('展示 finish 总结');
      // 启动模型脚本定义的 finish Turn。
      await core.startTurn(session.id, '请给出最终总结');
      // 等待 message.completed 和 turn.completed 都发布完毕。
      await completed;
      // UI 应收到一条包含 Markdown 标题和正文的完整最终消息。
      expect(visibleMessages).toEqual(['## 完整最终总结\n\n这是用户应看到的答案。']);
      // 最终消息必须先出现，完成横幅只能随后出现。
      expect(terminalOrder).toEqual(['message.completed', 'turn.completed']);
      // 重新读取磁盘事件，验证应用重启或切换 Session 后仍能回放最终答案。
      const persisted = await store.readEvents(session.id);
      // 持久化事件中应存在同样的 message.completed。
      expect(persisted.some((record) => record.event.type === 'message.completed'
        && record.event.text === '## 完整最终总结\n\n这是用户应看到的答案。')).toBe(true);
    // finally 在所有断言路径上执行。
    } finally {
      // 删除本用例产生的 Session 数据和临时工作区。
      await rm(root, { recursive: true, force: true });
    }
  }); // 结束 finish 最终消息回归测试。

  // 验证模型在调用 finish 的同一响应中已经给出正文时，不会再追加一条重复摘要。
  it('does not append the finish summary after a visible final response', async () => {
    // 创建与其他测试隔离的临时工作区。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-finish-no-duplicate-'));
    // try/finally 确保测试结束后清理临时 Session 数据。
    try {
      // 模型在同一响应中先给出完整正文，再用 finish 工具提交较短的结束摘要。
      const provider = new FakeModelProvider([
        [
          { type: 'textDelta', text: '## 完整答案\n\n这是用户只应看到一次的详细正文。' },
          { type: 'toolCallDelta', callId: 'finish-with-text', name: 'finish', argsDelta: '{"summary":"较短的结束摘要","verification":[]}' },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      ]);
      // 使用真实 AgentCore 跑完整 Turn，避免只测试局部条件而遗漏事件发布行为。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      // 收集 Renderer 会展示的所有助手消息。
      const visibleMessages: string[] = [];
      // 等待 Turn 完成后再断言，确保 finish 的收尾逻辑已经执行。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => {
        // message.completed 是前端真正渲染的助手正文事件。
        if (event.type === 'message.completed') visibleMessages.push(event.text);
        // turn.completed 表示本轮所有收尾事件都已发布。
        if (event.type === 'turn.completed') resolve();
      }));
      // 创建 Session 并启动测试 Turn。
      const session = await core.createSession('finish 不重复摘要');
      await core.startTurn(session.id, '请输出详细答案');
      // 等待运行完成。
      await completed;
      // 已有正文时只能展示正文，finish.summary 不得形成第二个气泡。
      expect(visibleMessages).toEqual(['## 完整答案\n\n这是用户只应看到一次的详细正文。']);
    // 无论断言成功还是失败，都删除临时目录。
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }); // 结束 finish 去重回归测试。

  // 验证 guided 模式的文件写入会暂停等待审批，允许后才继续执行。
  it('waits for and applies approval before writing', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-approval-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new FakeModelProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'write-1', name: 'write_file', argsDelta: '{"path":"new.txt","content":"ok"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '已写入。' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'guided' });
      // 创建 approvals 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const approvals: string[] = []; const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'approval.requested') approvals.push(event.approval.id); if (event.type === 'turn.completed') resolve(); }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('审批测试'); await core.startTurn(session.id, '写文件');
      // 短暂等待异步回调获得执行机会，避免测试在目标事件到达前继续。
      await new Promise((resolve) => setTimeout(resolve, 150));
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(approvals).toHaveLength(1);
      // 等待 AgentCore 对外方法完成，保证相关内存状态和持久化操作已经生效。
      await core.resolveApproval(approvals[0]!, 'allow'); await completed;
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证 finishReason=length 表示输出被截断，状态机必须追加恢复提示并继续请求。
  it('does not treat a truncated model response as task completion', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-output-limit-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new RecordingProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '未完成的长响应' }, { type: 'completed', finishReason: 'length' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '已恢复并完成' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('截断恢复');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '完成一个任务');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;

      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(provider.requests).toHaveLength(2);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(provider.requests[1]!.messages.some((message) => String(message.content).includes('上一响应达到输出上限'))).toBe(true);
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证第 46 次模型迭代前只注入一次收敛提醒，不提前或重复污染上下文。
  it('adds one convergence reminder before the final five model iterations', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-convergence-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 planningTurns 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const planningTurns = Array.from({ length: 45 }, (_, index) => [
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        {
          // 设置对象的 type 字段，构造被测代码所需的输入或配置。
          type: 'toolCallDelta' as const,
          // 设置对象的 callId 字段，构造被测代码所需的输入或配置。
          callId: `plan-${index}`,
          // 设置对象的 name 字段，构造被测代码所需的输入或配置。
          name: 'set_plan',
          // 设置对象的 argsDelta 字段，构造被测代码所需的输入或配置。
          argsDelta: JSON.stringify({ steps: [{ id: 'finish', label: '完成剩余工作', status: 'running' }] }),
        // 结束当前对象、数组、回调或测试代码块。
        },
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        { type: 'completed' as const, finishReason: 'tool_calls' },
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new RecordingProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        ...planningTurns,
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '已收敛完成' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({
        // 设置对象的 workspace 字段，构造被测代码所需的输入或配置。
        workspace: root,
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        provider,
        // 设置对象的 model 字段，构造被测代码所需的输入或配置。
        model: { ...model, contextWindow: 200_000 },
        // 设置对象的 store 字段，构造被测代码所需的输入或配置。
        store: new SessionStore(join(root, '.sessions')),
        // 设置对象的 mode 字段，构造被测代码所需的输入或配置。
        mode: 'auto',
      // 结束当前对象、数组、回调或测试代码块。
      });
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => {
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'turn.completed') resolve();
      // 结束当前对象、数组、回调或测试代码块。
      }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('长任务收敛');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '完成一个长任务');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;

      // 创建 reminder 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const reminder = '[迭代预算提醒]';
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(provider.agentRequests).toHaveLength(46);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(provider.agentRequests[44]!.messages.some((message) => String(message.content).includes(reminder))).toBe(false);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(provider.agentRequests[45]!.messages.filter((message) => String(message.content).includes(reminder))).toHaveLength(1);
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证第 50 轮只向模型暴露 finish，防止最后一轮再次读取、修改或仅更新计划。
  it('reserves the final model iteration for finishing the turn', async () => {
    // 创建最终收尾测试专用临时工作区。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-final-iteration-'));
    // try/finally 确保测试结束后删除临时 Session 数据。
    try {
      // 前 49 轮持续更新计划，模拟模型一直工作到预算末尾的极端场景。
      const workingTurns = Array.from({ length: 49 }, (_, index) => [
        // 每轮使用不同 callId，避免工具去重机制把它识别成重复调用。
        { type: 'toolCallDelta' as const, callId: `working-plan-${index}`, name: 'set_plan', argsDelta: '{"steps":[{"id":"work","label":"完成任务","status":"running"}]}' },
        // tool_calls 表示本轮需要先执行 set_plan，再进入下一次模型迭代。
        { type: 'completed' as const, finishReason: 'tool_calls' },
      ]);
      // 第 50 轮按系统要求调用 finish；同时故意模拟一个未展示的 set_plan，验证执行层也会阻止它。
      const provider = new RecordingProvider([
        // 展开前 49 轮工作响应。
        ...workingTurns,
        // set_plan 是模型幻觉出的越权调用，finish 是本轮唯一应实际执行的工具。
        [
          { type: 'toolCallDelta', callId: 'blocked-plan-on-final-iteration', name: 'set_plan', argsDelta: '{"steps":[{"id":"work","label":"不应再更新","status":"completed"}]}' },
          { type: 'toolCallDelta', callId: 'finish-on-final-iteration', name: 'finish', argsDelta: '{"summary":"任务已经完成","verification":[]}' },
          { type: 'completed', finishReason: 'tool_calls' },
        ],
      ]);
      // 使用足够大的上下文窗口，避免本测试被自动压缩逻辑干扰。
      const core = new AgentCore({ workspace: root, provider, model: { ...model, contextWindow: 200_000 }, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      // 等待完成事件，若仍触发 iteration_limit，本 Promise 不会被错误地当作成功。
      // 保存越权工具的错误码，确认它没有穿过最后一轮的执行边界。
      let blockedToolCode = '';
      const completed = new Promise<void>((resolve) => core.onEvent((event) => {
        // 记录最后一轮被拦截的 set_plan 结果。
        if (event.type === 'tool.completed' && event.callId === 'blocked-plan-on-final-iteration') blockedToolCode = event.result.error?.code ?? '';
        // 只有真正完成才结束等待。
        if (event.type === 'turn.completed') resolve();
      }));
      // 创建 Session 并启动需要占满迭代预算的测试任务。
      const session = await core.createSession('最终迭代收尾');
      await core.startTurn(session.id, '持续工作到最后一轮再结束');
      // 等待第 50 轮 finish 成功。
      await completed;
      // 模型应恰好收到 50 次请求。
      expect(provider.agentRequests).toHaveLength(50);
      // 最后一轮只能看到 finish，不能再选择 set_plan、读取或修改工具。
      expect(provider.agentRequests[49]!.tools.map((tool) => tool.function.name)).toEqual(['finish']);
      // 最后一轮上下文应包含明确的强制收尾指令。
      expect(provider.agentRequests[49]!.messages.some((message) => String(message.content).includes('[最终收尾指令]'))).toBe(true);
      // 即使异常模型返回了未展示的 set_plan，执行器也必须用稳定错误码拒绝它。
      expect(blockedToolCode).toBe('finalization_only');
    // 无论测试成功还是失败，都清理临时目录。
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }); // 结束最终迭代工具限制回归测试。

  // 验证连续只读探索达到上限后会得到结构化预算错误，而不是无限读取。
  it('turns repeated exploration into a bounded tool result instead of an endless read loop', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-exploration-budget-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 在临时工作区写入测试前置文件，为后续工具读取或变更操作准备真实磁盘状态。
      await writeFile(join(root, 'evidence.txt'), 'evidence', 'utf8');
      // 创建 reads 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const reads = Array.from({ length: 8 }, (_, index) => [
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        { type: 'toolCallDelta' as const, callId: `read-${index}`, name: 'read_file', argsDelta: '{"path":"evidence.txt"}' },
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        { type: 'completed' as const, finishReason: 'tool_calls' },
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new RecordingProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        ...reads,
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'plan-after-budget', name: 'set_plan', argsDelta: '{"steps":[{"id":"fix","label":"实施最小修复","status":"running"}]}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'read-after-plan', name: 'read_file', argsDelta: '{"path":"evidence.txt"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'write-after-budget', name: 'write_file', argsDelta: '{"path":"fixed.txt","content":"fixed"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '已修复并验证' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model: { ...model, contextWindow: 200_000 }, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      // 创建 errors 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const errors: string[] = [];
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => {
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'tool.completed' && event.result.error) errors.push(event.result.error.code);
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'turn.completed') resolve();
      // 结束当前对象、数组、回调或测试代码块。
      }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('探索预算');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '定位后做最小修复');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;

      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(errors).toContain('exploration_budget_exhausted');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(errors.filter((code) => code === 'exploration_budget_exhausted')).toHaveLength(2);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(await readFile(join(root, 'fixed.txt'), 'utf8')).toBe('fixed');
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证恢复旧消息链时会删除没有对应 assistant ToolCall 的孤立 tool 消息。
  it('drops orphan tool messages when hydrating an interrupted legacy chain', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-hydrate-chain-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 store 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const store = new SessionStore(join(root, '.sessions'));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = { id: 'legacy-session', title: '旧会话', workspacePath: root, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      // 直接操作测试用 SessionStore，准备或读取本用例所需的持久化数据。
      await store.saveSession(session);
      // 直接操作测试用 SessionStore，准备或读取本用例所需的持久化数据。
      await store.append(session.id, {
        // 设置对象的 event 字段，构造被测代码所需的输入或配置。
        event: { type: 'context.compacted', timestamp: new Date().toISOString(), turnId: 'old-turn', sessionId: session.id, summary: '旧摘要' },
        // 设置对象的 item 字段，构造被测代码所需的输入或配置。
        item: { kind: 'compaction', id: 'old-item', summary: '旧摘要', messages: [
          // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
          { role: 'user', content: '原任务' },
          // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
          { role: 'tool', content: '{"ok":true}', toolCallId: 'orphan' },
        // 结束当前对象、数组、回调或测试代码块。
        ], createdAt: new Date().toISOString() },
      // 结束当前对象、数组、回调或测试代码块。
      });
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new RecordingProvider([[{ type: 'textDelta', text: '恢复完成' }, { type: 'completed', finishReason: 'stop' }]]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store, mode: 'auto' });
      // 等待 AgentCore 对外方法完成，保证相关内存状态和持久化操作已经生效。
      await core.hydrateSession(session.id);
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '继续任务');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;

      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(provider.requests[0]!.messages.some((message) => message.role === 'tool')).toBe(false);
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证进程重启后，磁盘中遗留的 running Turn 会被标记为 interrupted。
  it('marks a persisted running turn as interrupted after process restart', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-interrupted-turn-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 store 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const store = new SessionStore(join(root, '.sessions'));
      // 创建 timestamp 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const timestamp = new Date().toISOString();
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = { id: 'interrupted-session', title: '中断任务', workspacePath: root, createdAt: timestamp, updatedAt: timestamp };
      // 创建 turn 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const turn = { id: 'interrupted-turn', sessionId: session.id, status: 'running' as const, startedAt: timestamp, iteration: 3 };
      // 直接操作测试用 SessionStore，准备或读取本用例所需的持久化数据。
      await store.saveSession(session);
      // 直接操作测试用 SessionStore，准备或读取本用例所需的持久化数据。
      await store.append(session.id, { event: { type: 'turn.started', timestamp, sessionId: session.id, turn } });
      // 直接操作测试用 SessionStore，准备或读取本用例所需的持久化数据。
      await store.append(session.id, { event: { type: 'model.requested', timestamp, sessionId: session.id, turnId: turn.id, iteration: 3 } });

      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider: new FakeModelProvider([]), model, store, mode: 'auto' });
      // 等待 AgentCore 对外方法完成，保证相关内存状态和持久化操作已经生效。
      await core.hydrateSession(session.id);
      // 等待 AgentCore 对外方法完成，保证相关内存状态和持久化操作已经生效。
      await core.hydrateSession(session.id);
      // 创建 events 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const events = await store.readEvents(session.id);
      // 创建 interrupted 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const interrupted = events.filter((record) => record.event.type === 'turn.failed' && record.event.error.code === 'interrupted');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(interrupted).toHaveLength(1);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(interrupted[0]!.event.type === 'turn.failed' && interrupted[0]!.event.turn.status).toBe('failed');
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证审批等待期间取消会释放 Promise，并且不会留下占用 Session 的僵尸 Turn。
  it('cancels a turn waiting for approval without leaving a zombie task', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-cancel-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new FakeModelProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'cancel-write', name: 'write_file', argsDelta: '{"path":"blocked.txt","content":"no"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '已重新开始。' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'guided' });
      // 创建 turnId 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let turnId = '';
      // 创建 approval 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const approval = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'approval.requested') resolve(); }));
      // 创建 cancelled 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const cancelled = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.cancelled') resolve(); }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('取消审批');
      // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
      turnId = await core.startTurn(session.id, '写文件');
      // 等待该异步操作完成后再继续，避免并发时序使断言过早执行。
      await approval;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      await expect(core.startTurn(session.id, '并发任务')).rejects.toThrow('已有执行中的 Turn');
      // 取消指定 Turn，用来验证取消传播和运行态清理。
      core.cancelTurn(turnId);
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await cancelled;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      await expect(readFile(join(root, 'blocked.txt'), 'utf8')).rejects.toThrow();
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      await expect(core.startTurn(session.id, '取消后可再次执行')).resolves.toBeTypeOf('string');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证被 AbortSignal 中止的模型请求只能进入 cancelled，不能误报 completed。
  it('does not report an aborted model request as completed', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-model-cancel-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider: ModelProvider = {
        // 实现模型 Provider 的异步流接口，按测试脚本逐条产出事件。
        async *stream(_request, signal) {
          // 测试 Provider 向 Agent 循环发送这一条模型流事件。
          yield { type: 'textDelta', text: '处理中' };
          // 短暂等待异步回调获得执行机会，避免测试在目标事件到达前继续。
          await new Promise<void>((resolve) => {
            // 检查当前测试运行条件，只有满足条件时才进入该分支。
            if (signal.aborted) resolve();
            // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
            else signal.addEventListener('abort', () => resolve(), { once: true });
          // 结束当前对象、数组、回调或测试代码块。
          });
        // 结束当前对象、数组、回调或测试代码块。
        },
      // 结束当前对象、数组、回调或测试代码块。
      };
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'plan' });
      // 创建 events 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const events: string[] = [];
      // 创建 streamedResolve 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let streamedResolve!: () => void;
      // 创建 streamed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const streamed = new Promise<void>((resolve) => { streamedResolve = resolve; });
      // 创建 cancelled 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const cancelled = new Promise<void>((resolve) => core.onEvent((event) => { events.push(event.type); if (event.type === 'message.delta') streamedResolve(); if (event.type === 'turn.cancelled') resolve(); }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('模型取消');
      // 创建 turnId 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const turnId = await core.startTurn(session.id, '开始长任务');
      // 等待该异步操作完成后再继续，避免并发时序使断言过早执行。
      await streamed;
      // 取消指定 Turn，用来验证取消传播和运行态清理。
      core.cancelTurn(turnId);
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await cancelled;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(events).not.toContain('model.completed');
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证文件工具产生的 ChangeSet 可以通过对外 API 恢复到修改前内容。
  it('can restore a recorded ChangeSet', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-revert-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 在临时工作区写入测试前置文件，为后续工具读取或变更操作准备真实磁盘状态。
      await writeFile(join(root, 'a.txt'), 'before', 'utf8');
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new FakeModelProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'write-restore', name: 'write_file', argsDelta: '{"path":"a.txt","content":"after"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '完成' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      // 创建 changeSetId 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let changeSetId = '';
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'changes.created') changeSetId = event.changeSet.id; if (event.type === 'turn.completed') resolve(); }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('撤销测试'); await core.startTurn(session.id, '修改文件'); await completed;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('after');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect((await core.revertChangeSet(changeSetId)).ok).toBe(true);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('before');
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证一个 Turn 即使连续修改同一文件多次，也只生成一个恢复点并回到本轮开始前。
  it('creates one checkpoint per turn and restores repeated edits in reverse order', async () => {
    // 创建真实临时文件，让测试同时覆盖 ChangeSet 聚合、磁盘哈希和恢复顺序。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-turn-checkpoint-'));
    // finally 保证测试成功或失败都删除临时目录。
    try {
      // 本轮开始前文件内容为 before。
      await writeFile(join(root, 'a.txt'), 'before', 'utf8');
      // 模型分两轮工具调用把同一文件依次改成 middle 和 after，最后正常结束。
      const provider = new FakeModelProvider([
        [{ type: 'toolCallDelta', callId: 'write-middle', name: 'write_file', argsDelta: '{"path":"a.txt","content":"middle"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'toolCallDelta', callId: 'write-after', name: 'write_file', argsDelta: '{"path":"a.txt","content":"after"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        [{ type: 'textDelta', text: '修改完成' }, { type: 'completed', finishReason: 'stop' }],
      ]);
      // Auto 模式允许测试文件写入，无需模拟审批。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      // checkpointEvents 记录对外实际发布次数，避免只检查内存 Map 而漏掉重复 UI 事件。
      let checkpointEvents = 0;
      // completed 在 Turn 终态到达后再执行断言。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => {
        // 每个 checkpoint.created 都会被 Renderer 收到。
        if (event.type === 'checkpoint.created') checkpointEvents += 1;
        // Turn 完成表示聚合恢复点已经先行创建。
        if (event.type === 'turn.completed') resolve();
      }));
      // 创建 Session 并启动一次包含两次写入的 Turn。
      const session = await core.createSession('整轮恢复');
      // startTurn 只等待启动，真实完成由上面的 Promise 等待。
      await core.startTurn(session.id, '连续修改同一个文件');
      // 等到完整 Turn 收口。
      await completed;
      // 磁盘应保持本轮最终内容。
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('after');
      // 对外只能发布一个逻辑恢复点。
      expect(checkpointEvents).toBe(1);
      // 内存索引同样只有一个 Checkpoint，并关联本轮两次 ChangeSet。
      const checkpoints = core.listCheckpoints(session.id);
      // 检查点数量体现“一轮一个”的核心不变量。
      expect(checkpoints).toHaveLength(1);
      // 两次真实修改都必须包含在聚合恢复点中。
      expect(checkpoints[0]?.changeSetIds).toHaveLength(2);
      // 同一路径只保存一组从 before 到 after 的聚合哈希。
      expect(checkpoints[0]?.files).toHaveLength(1);
      // 执行整轮回退。
      expect((await core.restoreCheckpoint(checkpoints[0]!.id)).ok).toBe(true);
      // 逆序恢复两次 ChangeSet 后必须回到本轮最初内容，而不是中间版本 middle。
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('before');
      // 公开历史经过 tombstone 过滤后不能再包含该 Turn 的用户消息或助手回答。
      const visibleHistory = await core.readSessionEvents(session.id);
      // 用户发起内容已经从对话历史删除。
      expect(visibleHistory.some((event) => event.type === 'message.user' && event.turnId === checkpoints[0]!.turnId)).toBe(false);
      // 本轮 ChangeSet 已从右侧变更数据源删除。
      expect(visibleHistory.some((event) => event.type === 'changes.created' && event.changeSet.turnId === checkpoints[0]!.turnId)).toBe(false);
      // 内存恢复点索引也已按可见历史重建，不再提供重复回退入口。
      expect(core.listCheckpoints(session.id)).toEqual([]);
    // 无论测试成功或失败都清理临时工作区。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束整轮 Checkpoint 回归测试。
  });

  // 验证 Plan 模式硬性阻止副作用，同时仍把 assistant ToolCall 与失败结果完整持久化。
  it('blocks side effects in Plan mode and preserves assistant tool calls', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-plan-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new FakeModelProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'plan-write', name: 'write_file', argsDelta: '{"path":"blocked.txt","content":"nope"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '计划已完成，等待批准。' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 store 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const store = new SessionStore(join(root, '.sessions'));
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store, mode: 'plan' });
      // 创建 results 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const results: string[] = [];
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'tool.completed') results.push(event.result.error?.code ?? 'ok'); if (event.type === 'turn.completed') resolve(); }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('Plan 只读');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '请不要写文件');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      await expect(readFile(join(root, 'blocked.txt'), 'utf8')).rejects.toThrow();
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(results).toContain('plan_read_only');
      // 创建 history 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const history = await store.readEvents(session.id);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(history.some((record) => record.item?.kind === 'assistant_message' && record.item.toolCalls?.[0]?.id === 'plan-write')).toBe(true);
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证恢复 Checkpoint 前会比较当前文件内容，发生外部变化时报告冲突而不覆盖。
  it('detects checkpoint conflicts before restoring files', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-checkpoint-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 在临时工作区写入测试前置文件，为后续工具读取或变更操作准备真实磁盘状态。
      await writeFile(join(root, 'a.txt'), 'before', 'utf8');
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new FakeModelProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'checkpoint-write', name: 'write_file', argsDelta: '{"path":"a.txt","content":"after"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '完成' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      // 创建 checkpointId 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let checkpointId = '';
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'checkpoint.created') checkpointId = event.checkpoint.id; if (event.type === 'turn.completed') resolve(); }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('冲突检查'); await core.startTurn(session.id, '修改文件'); await completed;
      // 在临时工作区写入测试前置文件，为后续工具读取或变更操作准备真实磁盘状态。
      await writeFile(join(root, 'a.txt'), '外部修改', 'utf8');
      // 创建 result 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const result = await core.restoreCheckpoint(checkpointId);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(result.ok).toBe(false);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(result.error?.code).toBe('checkpoint_conflict');
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证切换工作区后，新 Session 与旧工作区 Session 的内存和磁盘数据互相隔离。
  it('isolates sessions by workspace after a workspace switch', async () => {
    // 创建 rootA 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const rootA = await mkdtemp(join(tmpdir(), 'seecoder-workspace-a-'));
    // 创建 rootB 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const rootB = await mkdtemp(join(tmpdir(), 'seecoder-workspace-b-'));
    // 创建 store 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const store = new SessionStore(join(tmpdir(), `seecoder-shared-${Date.now()}`));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 coreA 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const coreA = new AgentCore({ workspace: rootA, provider: new FakeModelProvider([]), model, store, mode: 'plan' });
      // 创建 sessionA 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const sessionA = await coreA.createSession('A');
      // 创建 coreB 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const coreB = new AgentCore({ workspace: rootB, provider: new FakeModelProvider([]), model, store, mode: 'plan' });
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(await coreB.listSessions()).toEqual([]);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(await coreB.hydrateSession(sessionA.id)).toBeNull();
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(await coreB.readSessionEvents(sessionA.id)).toEqual([]);
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally {
      // 等待该异步操作完成后再继续，避免并发时序使断言过早执行。
      await rm(rootA, { recursive: true, force: true });
      // 等待该异步操作完成后再继续，避免并发时序使断言过早执行。
      await rm(rootB, { recursive: true, force: true });
    // 结束当前对象、数组、回调或测试代码块。
    }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证 compact_context 会持久化压缩 Item，并报告压缩前后的 Token 指标。
  it('persists an explicit context compaction and reports token reduction', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-compact-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 textTurn 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const textTurn = (index: number) => [{ type: 'textDelta' as const, text: `第 ${index} 轮 ${'上下文'.repeat(200)}` }, { type: 'completed' as const, finishReason: 'stop' }];
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new FakeModelProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        ...Array.from({ length: 5 }, (_, index) => textTurn(index)),
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'compact-now', name: 'compact_context', argsDelta: '{}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '上下文已整理。' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 store 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const store = new SessionStore(join(root, '.sessions'));
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store, mode: 'auto' });
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('压缩测试');
      // 创建 run 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const run = async (prompt: string) => {
        // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
        const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
        // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
        await core.startTurn(session.id, prompt);
        // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
        await completed;
      // 结束当前对象、数组、回调或测试代码块。
      };
      // 按既定顺序遍历测试数据，模拟连续事件或多轮 Agent 执行。
      for (let index = 0; index < 5; index += 1) await run(`用户任务 ${index} ${'内容'.repeat(200)}`);
      // 创建 metrics 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let metrics: { compacted?: boolean; beforeTokens?: number; afterTokens?: number } = {};
      // 创建 unsubscribe 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const unsubscribe = core.onEvent((event) => {
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'context.compacted' && event.metrics) metrics = event.metrics;
      // 结束当前对象、数组、回调或测试代码块。
      });
      // 等待该异步操作完成后再继续，避免并发时序使断言过早执行。
      await run('请主动压缩上下文');
      // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
      unsubscribe();
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(metrics.compacted).toBe(true);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(metrics.afterTokens).toBeLessThan(metrics.beforeTokens!);
      // 创建 history 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const history = await store.readEvents(session.id);
      // 创建 compaction 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const compaction = history.find((record) => record.item?.kind === 'compaction')?.item;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(compaction?.kind).toBe('compaction');
      // 检查当前测试运行条件，只有满足条件时才进入该分支。
      if (compaction?.kind === 'compaction') {
        // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
        expect(compaction.snapshot).toMatchObject({ sessionId: session.id, ledgerRevision: 0 });
        // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
        expect(compaction.snapshot?.coveredEventSeq).toBeGreaterThan(0);
        // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
        expect(compaction.snapshot?.retainedGroupIds.length).toBeGreaterThan(0);
      // 结束当前对象、数组、回调或测试代码块。
      }

      // 创建 restoredProvider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const restoredProvider = new RecordingProvider([[{ type: 'textDelta', text: '恢复完成' }, { type: 'completed', finishReason: 'stop' }]]);
      // 创建 restored 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const restored = new AgentCore({ workspace: root, provider: restoredProvider, model, store, mode: 'auto' });
      // 等待该异步操作完成后再继续，避免并发时序使断言过早执行。
      await restored.hydrateSession(session.id);
      // 创建 restoredCompleted 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const restoredCompleted = new Promise<void>((resolve) => restored.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
      // 等待该异步操作完成后再继续，避免并发时序使断言过早执行。
      await restored.startTurn(session.id, '恢复后继续');
      // 等待该异步操作完成后再继续，避免并发时序使断言过早执行。
      await restoredCompleted;
      // 创建 restoredMessages 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const restoredMessages = restoredProvider.agentRequests[0]?.messages ?? [];
      // 创建 serialized 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const serialized = JSON.stringify(restoredMessages);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(serialized).toContain('[历史压缩摘要]');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(serialized).toContain('上下文摘要');
      // 创建 compactCallIndex 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const compactCallIndex = restoredMessages.findIndex((message) => message.role === 'assistant' && message.toolCalls?.some((call) => call.id === 'compact-now'));
      // 创建 compactResultIndex 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const compactResultIndex = restoredMessages.findIndex((message) => message.role === 'tool' && message.toolCallId === 'compact-now');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(compactCallIndex).toBeGreaterThanOrEqual(0);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(compactResultIndex).toBeGreaterThan(compactCallIndex);
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证自动压缩不会拆散同一 assistant 发出的多个 ToolCall 及其结果组。
  it('keeps multi-tool assistant calls intact during automatic compaction', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-tool-chain-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 在临时工作区写入测试前置文件，为后续工具读取或变更操作准备真实磁盘状态。
      await writeFile(join(root, 'large.txt'), 'x'.repeat(30_000), 'utf8');
      // 创建 toolTurn 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const toolTurn = (prefix: string) => [
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        ...Array.from({ length: 4 }, (_, index) => ({ type: 'toolCallDelta' as const, callId: `${prefix}-${index}`, name: 'read_file', argsDelta: '{"path":"large.txt"}' })),
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        { type: 'completed' as const, finishReason: 'tool_calls' },
      // 结束当前对象、数组、回调或测试代码块。
      ];
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new RecordingProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        toolTurn('first'),
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        toolTurn('second'),
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '完成' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 compactModel 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const compactModel = { ...model, contextWindow: 1_000 };
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model: compactModel, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('多工具压缩');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '读取大文件');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;

      // 创建 compactedRequest 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const compactedRequest = provider.agentRequests[2]!.messages.slice(1);
      // 创建 pending 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let pending = new Set<string>();
      // 按既定顺序遍历测试数据，模拟连续事件或多轮 Agent 执行。
      for (const message of compactedRequest) {
        // 检查当前测试运行条件，只有满足条件时才进入该分支。
        if (message.role === 'assistant') pending = new Set(message.toolCalls?.map((call) => call.id) ?? []);
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        else if (message.role === 'tool') {
          // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
          expect(pending.has(message.toolCallId!)).toBe(true);
          // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
          pending.delete(message.toolCallId!);
          // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
          expect(String(message.content).length).toBeLessThan(16_000);
        // 结束当前对象、数组、回调或测试代码块。
        } else pending.clear();
      // 结束当前对象、数组、回调或测试代码块。
      }
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(compactedRequest.some((message) => message.role === 'tool')).toBe(true);
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证同一 Turn 重复相同 callId 时复用首个结果，副作用只执行一次。
  it('does not replay a side effect when a model repeats the same call id', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-idempotent-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 repeated 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const repeated = [{ type: 'toolCallDelta' as const, callId: 'same-write', name: 'write_file', argsDelta: '{"path":"once.txt","content":"once"}' }, { type: 'completed' as const, finishReason: 'tool_calls' }];
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new FakeModelProvider([repeated, repeated, [{ type: 'textDelta', text: '完成' }, { type: 'completed', finishReason: 'stop' }]]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      // 创建 executionCount 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let executionCount = 0;
      // 创建 executionResult 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let executionResult: boolean | undefined;
      // 创建 executionError 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let executionError = '';
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'tool.completed' && event.callId === 'same-write') { executionCount += 1; executionResult = event.result.ok; executionError = event.result.error?.message ?? ''; } if (event.type === 'turn.completed') resolve(); }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('幂等测试');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '只写一次');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(executionCount).toBe(1);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(executionResult, executionError).toBe(true);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(await readFile(join(root, 'once.txt'), 'utf8')).toBe('once');
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证 callId 幂等缓存仅限当前 Turn，新 Turn 可以合法复用同一字符串 id。
  it('scopes repeated call ids to one turn instead of leaking results across turns', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-turn-call-scope-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new FakeModelProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'provider-reused-id', name: 'write_file', argsDelta: '{"path":"value.txt","content":"first"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '第一轮完成' }, { type: 'completed', finishReason: 'stop' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'provider-reused-id', name: 'write_file', argsDelta: '{"path":"value.txt","content":"second"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '第二轮完成' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('跨 Turn 幂等隔离');
      // 创建 run 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const run = async (prompt: string) => {
        // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
        const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
        // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
        await core.startTurn(session.id, prompt);
        // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
        await completed;
      // 结束当前对象、数组、回调或测试代码块。
      };
      // 等待该异步操作完成后再继续，避免并发时序使断言过早执行。
      await run('写入 first');
      // 等待该异步操作完成后再继续，避免并发时序使断言过早执行。
      await run('写入 second');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(await readFile(join(root, 'value.txt'), 'utf8')).toBe('second');
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证只读子 Agent 也保存 assistant ToolCall 与 tool result 的完整协议链。
  it('preserves the assistant tool-call chain inside read-only subagents', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-subagent-chain-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 在临时工作区写入测试前置文件，为后续工具读取或变更操作准备真实磁盘状态。
      await writeFile(join(root, 'evidence.txt'), 'evidence', 'utf8');
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new RecordingProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'delegate-1', name: 'delegate', argsDelta: '{"role":"explore","task":"查找证据"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'child-read-1', name: 'read_file', argsDelta: '{"path":"evidence.txt"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '子 Agent 找到证据。' }, { type: 'completed', finishReason: 'stop' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '主任务完成。' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'plan' });
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('子 Agent 消息链');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '委派探索');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;
      // 创建 childFollowUp 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const childFollowUp = provider.requests[2]!;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(childFollowUp.messages).toEqual(expect.arrayContaining([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        expect.objectContaining({ role: 'assistant', toolCalls: [expect.objectContaining({ id: 'child-read-1', name: 'read_file' })] }),
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        expect.objectContaining({ role: 'tool', toolCallId: 'child-read-1', toolName: 'read_file' }),
      // 结束当前对象、数组、回调或测试代码块。
      ]));
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证语义摘要失败时使用确定性后备摘要，整个 Turn 仍可完成。
  it('falls back deterministically when semantic summarization fails without failing the turn', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-summary-fallback-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 textTurn 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const textTurn = (index: number) => [{ type: 'textDelta' as const, text: `历史 ${index} ${'内容'.repeat(220)}` }, { type: 'completed' as const, finishReason: 'stop' }];
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new FakeModelProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        ...Array.from({ length: 5 }, (_, index) => textTurn(index)),
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'compact-fallback', name: 'compact_context', argsDelta: '{}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '降级后仍完成' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ], [[{ type: 'error', code: 'network_error', message: '摘要服务不可用', retryable: true }]]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      // 创建 events 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const events: string[] = [];
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('摘要失败降级');
      // 创建 run 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const run = async (prompt: string) => {
        // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
        const completed = new Promise<void>((resolve) => core.onEvent((event) => { events.push(event.type); if (event.type === 'turn.completed') resolve(); }));
        // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
        await core.startTurn(session.id, prompt);
        // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
        await completed;
      // 结束当前对象、数组、回调或测试代码块。
      };
      // 按既定顺序遍历测试数据，模拟连续事件或多轮 Agent 执行。
      for (let index = 0; index < 5; index += 1) await run(`用户历史 ${index}`);
      // 等待该异步操作完成后再继续，避免并发时序使断言过早执行。
      await run('压缩后继续');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(events).toContain('context.summary.failed');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(events).toContain('context.compacted');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(events.at(-1)).toBe('turn.completed');
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证成功测试后再次修改代码会使验证过期，finish 结果必须带 warning。
  it('warns when finish follows a newer change than the latest successful validation', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-stale-validation-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new FakeModelProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'write-before-test', name: 'write_file', argsDelta: '{"path":"value.ts","content":"one"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'test-revision-1', name: 'run_command', argsDelta: '{"command":"node --test"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'write-after-test', name: 'write_file', argsDelta: '{"path":"value.ts","content":"two"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'finish-stale', name: 'finish', argsDelta: '{"summary":"完成","verification":["node --test"]}' }, { type: 'completed', finishReason: 'tool_calls' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      // 创建 finishOutput 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let finishOutput: unknown;
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => {
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'tool.completed' && event.callId === 'finish-stale') finishOutput = event.result.output;
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'turn.completed') resolve();
      // 结束当前对象、数组、回调或测试代码块。
      }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('验证 revision');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '修改、测试、再次修改后完成');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(finishOutput).toMatchObject({ verificationStatus: 'warning', warning: expect.stringContaining('没有成功验证') });
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证当前 revision 只有 README 等文档变化时，finish 不要求代码验证。
  it('does not warn when the current revision only changes documentation', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-documentation-validation-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new RecordingProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'write-doc', name: 'write_file', argsDelta: '{"path":"README.md","content":"# Updated"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'finish-doc', name: 'finish', argsDelta: '{"summary":"README 已更新","verification":[]}' }, { type: 'completed', finishReason: 'tool_calls' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      // 创建 finishOutput 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let finishOutput: unknown;
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => {
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'tool.completed' && event.callId === 'finish-doc') finishOutput = event.result.output;
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'turn.completed') resolve();
      // 结束当前对象、数组、回调或测试代码块。
      }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('文档更新');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '更新 README');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(finishOutput).toMatchObject({ verificationStatus: 'verified' });
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(finishOutput).not.toHaveProperty('warning');
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证压缩摘要请求进行中仍可取消，并能立即在同一 Session 启动下一 Turn。
  it('cancels an in-flight summary request and leaves no active turn', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-cancel-summary-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 scripted 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const scripted = [
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        ...Array.from({ length: 5 }, (_, index) => [{ type: 'textDelta' as const, text: `历史 ${index} ${'内容'.repeat(220)}` }, { type: 'completed' as const, finishReason: 'stop' }]),
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta' as const, callId: 'compact-cancel', name: 'compact_context', argsDelta: '{}' }, { type: 'completed' as const, finishReason: 'tool_calls' }],
      // 结束当前对象、数组、回调或测试代码块。
      ];
      // 创建 cursor 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let cursor = 0;
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider: ModelProvider = {
        // 实现模型 Provider 的异步流接口，按测试脚本逐条产出事件。
        async *stream(request, signal) {
          // 根据模型请求用途区分主 Agent 响应与内部上下文摘要响应。
          if (request.purpose === 'context_summary') {
            // 检查当前测试运行条件，只有满足条件时才进入该分支。
            if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
            // 测试 Provider 向 Agent 循环发送这一条模型流事件。
            yield { type: 'error', code: 'cancelled', message: '摘要已取消', retryable: false };
            // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
            return;
          // 结束当前对象、数组、回调或测试代码块。
          }
          // 按既定顺序遍历测试数据，模拟连续事件或多轮 Agent 执行。
          for (const event of scripted[Math.min(cursor++, scripted.length - 1)] ?? []) yield event;
        // 结束当前对象、数组、回调或测试代码块。
        },
      // 结束当前对象、数组、回调或测试代码块。
      };
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('取消摘要');
      // 创建 run 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const run = async (prompt: string) => {
        // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
        const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
        // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
        await core.startTurn(session.id, prompt);
        // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
        await completed;
      // 结束当前对象、数组、回调或测试代码块。
      };
      // 按既定顺序遍历测试数据，模拟连续事件或多轮 Agent 执行。
      for (let index = 0; index < 5; index += 1) await run(`历史 ${index}`);
      // 创建 turnId 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let turnId = '';
      // 创建 cancelled 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const cancelled = new Promise<void>((resolve) => core.onEvent((event) => {
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'context.summary.requested') { turnId = event.turnId; core.cancelTurn(event.turnId); }
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'turn.cancelled' && event.turn.id === turnId) resolve();
      // 结束当前对象、数组、回调或测试代码块。
      }));
      // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
      turnId = await core.startTurn(session.id, '现在压缩，但我要取消');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await cancelled;
      // 短暂等待异步回调获得执行机会，避免测试在目标事件到达前继续。
      await new Promise((resolve) => setTimeout(resolve, 0));
      // 创建 nextTurnId 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const nextTurnId = await core.startTurn(session.id, '取消后可以重新开始');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(nextTurnId).not.toBe(turnId);
      // 取消指定 Turn，用来验证取消传播和运行态清理。
      core.cancelTurn(nextTurnId);
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证自然结束前到达的 steering 会进入同一个 Turn，并触发下一轮模型请求。
  it('consumes steering before terminal completion and continues the same turn', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-steering-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new RecordingProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '准备结束' }, { type: 'completed', finishReason: 'stop' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '已按调整继续' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      // 创建 queued 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let queued = false;
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => {
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'message.delta' && !queued) {
          // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
          queued = true;
          // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
          void core.steerTurn(event.turnId, '请继续检查边界条件');
        // 结束当前对象、数组、回调或测试代码块。
        }
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'turn.completed') resolve();
      // 结束当前对象、数组、回调或测试代码块。
      }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('动态调整');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '开始检查');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(provider.agentRequests).toHaveLength(2);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(provider.agentRequests[1]?.messages.some((message) =>
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        typeof message.content === 'string' && message.content.includes('请继续检查边界条件'))).toBe(true);
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证 follow-up 等当前 Turn 完成后以新 turnId 启动，而不是修改原 Turn。
  it('starts follow-up as a new turn after the current turn completes', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-follow-up-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new RecordingProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '第一轮完成' }, { type: 'completed', finishReason: 'stop' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '后续完成' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), mode: 'auto' });
      // 创建 queued 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let queued = false;
      // 创建 completedTurns 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completedTurns: string[] = [];
      // 创建 done 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const done = new Promise<void>((resolve) => core.onEvent((event) => {
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'message.delta' && !queued) {
          // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
          queued = true;
          // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
          void core.queueFollowUp(event.turnId, '开始后续任务');
        // 结束当前对象、数组、回调或测试代码块。
        }
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'turn.completed') {
          // 把本次观察到的值加入数组，稍后通过顺序或数量断言验证行为。
          completedTurns.push(event.turn.id);
          // 检查当前测试运行条件，只有满足条件时才进入该分支。
          if (completedTurns.length === 2) resolve();
        // 结束当前对象、数组、回调或测试代码块。
        }
      // 结束当前对象、数组、回调或测试代码块。
      }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('Follow-up');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '第一项任务');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await done;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(new Set(completedTurns).size).toBe(2);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(provider.agentRequests[1]?.messages.some((message) =>
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        typeof message.content === 'string' && message.content.includes('开始后续任务'))).toBe(true);
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证整批 parallelSafe 工具真实并发，同时回填顺序仍与模型调用顺序一致。
  it('runs a fully parallel-safe tool batch concurrently and preserves result order', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-parallel-tools-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 active 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let active = 0;
      // 创建 maximumActive 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let maximumActive = 0;
      // 创建 tool 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const tool = (name: string) => ({
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        name, description: name, parameters: z.object({}), sideEffect: false, parallelSafe: true, timeoutMs: 1_000, risk: 'low' as const,
        // 实现测试工具或 Hook 的执行函数，模拟真实运行结果。
        async execute() {
          // 更新测试计数器，用于记录请求轮次、并发数量或回调次数。
          active += 1;
          // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
          maximumActive = Math.max(maximumActive, active);
          // 短暂等待异步回调获得执行机会，避免测试在目标事件到达前继续。
          await new Promise((resolve) => setTimeout(resolve, 100));
          // 更新测试计数器，用于记录请求轮次、并发数量或回调次数。
          active -= 1;
          // 返回当前测试替身生成的值，供被测代码继续执行。
          return { ok: true, output: name, durationMs: 100 };
        // 结束当前对象、数组、回调或测试代码块。
        },
      // 结束当前对象、数组、回调或测试代码块。
      });
      // 创建 registry 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const registry = new ToolRegistry([tool('read_a'), tool('read_b')]);
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new RecordingProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [
          // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
          { type: 'toolCallDelta', callId: 'a', name: 'read_a', argsDelta: '{}' },
          // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
          { type: 'toolCallDelta', callId: 'b', name: 'read_b', argsDelta: '{}' },
          // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
          { type: 'completed', finishReason: 'tool_calls' },
        // 结束当前对象、数组、回调或测试代码块。
        ],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '完成' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), registry, mode: 'auto' });
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => {
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'turn.completed') resolve();
      // 结束当前对象、数组、回调或测试代码块。
      }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('并行工具');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '并行读取');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(maximumActive).toBe(2);
      // 创建 toolMessages 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const toolMessages = provider.agentRequests[1]?.messages.filter((message) => message.role === 'tool') ?? [];
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(toolMessages.map((message) => message.toolCallId)).toEqual(['a', 'b']);
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证批次中只要有一个工具不安全并发，整个批次就按顺序执行。
  it('runs the whole batch sequentially when one tool is not parallel-safe', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-sequential-tools-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 active 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let active = 0;
      // 创建 maximumActive 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let maximumActive = 0;
      // 创建 tool 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const tool = (name: string, parallelSafe: boolean, sideEffect: boolean) => ({
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        name, description: name, parameters: z.object({}), sideEffect, parallelSafe, timeoutMs: 1_000, risk: 'low' as const,
        // 实现测试工具或 Hook 的执行函数，模拟真实运行结果。
        async execute() {
          // 更新测试计数器，用于记录请求轮次、并发数量或回调次数。
          active += 1;
          // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
          maximumActive = Math.max(maximumActive, active);
          // 短暂等待异步回调获得执行机会，避免测试在目标事件到达前继续。
          await new Promise((resolve) => setTimeout(resolve, 10));
          // 更新测试计数器，用于记录请求轮次、并发数量或回调次数。
          active -= 1;
          // 返回当前测试替身生成的值，供被测代码继续执行。
          return { ok: true, output: name, durationMs: 10 };
        // 结束当前对象、数组、回调或测试代码块。
        },
      // 结束当前对象、数组、回调或测试代码块。
      });
      // 创建 registry 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const registry = new ToolRegistry([tool('safe_read', true, false), tool('write_action', false, true)]);
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new RecordingProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [
          // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
          { type: 'toolCallDelta', callId: 'safe', name: 'safe_read', argsDelta: '{}' },
          // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
          { type: 'toolCallDelta', callId: 'write', name: 'write_action', argsDelta: '{}' },
          // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
          { type: 'completed', finishReason: 'tool_calls' },
        // 结束当前对象、数组、回调或测试代码块。
        ],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '完成' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), registry, mode: 'auto' });
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => { if (event.type === 'turn.completed') resolve(); }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('混合工具');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '顺序执行');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(maximumActive).toBe(1);
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证通用工具超时被捕获成 code=timeout 的 ToolResult，而不是炸毁 Turn。
  it('turns a generic tool timeout into a structured result', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-tool-timeout-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 registry 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const registry = new ToolRegistry([{
        // 设置对象的 name 字段，构造被测代码所需的输入或配置。
        name: 'hang', description: '超时工具', parameters: z.object({}), sideEffect: false, parallelSafe: true, timeoutMs: 20, risk: 'low',
        // 实现测试工具或 Hook 的执行函数，模拟真实运行结果。
        async execute() { return new Promise(() => undefined); },
      // 结束当前对象、数组、回调或测试代码块。
      }]);
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new RecordingProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'hang-1', name: 'hang', argsDelta: '{}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '超时已处理' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), registry, mode: 'auto' });
      // 创建 errorCode 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let errorCode = '';
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => {
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'tool.completed') errorCode = event.result.error?.code ?? '';
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'turn.completed') resolve();
      // 结束当前对象、数组、回调或测试代码块。
      }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('工具超时');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '调用超时工具');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(errorCode).toBe('timeout');
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证工具抛错被限制在工具边界内，拦截器替换也不会污染持久化历史。
  it('contains tool exceptions and interceptor replacements inside the turn', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-tool-boundary-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 registry 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const registry = new ToolRegistry([{
        // 设置对象的 name 字段，构造被测代码所需的输入或配置。
        name: 'explode', description: '抛错工具', parameters: z.object({ value: z.string() }), sideEffect: false, parallelSafe: true, timeoutMs: 1_000, risk: 'low',
        // 实现测试工具或 Hook 的执行函数，模拟真实运行结果。
        async execute() { throw new Error('boom'); },
      // 结束当前对象、数组、回调或测试代码块。
      }]);
      // 创建 interceptor 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const interceptor: AgentInterceptor = {
        // 设置对象的 id 字段，构造被测代码所需的输入或配置。
        id: 'replace-input',
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        async intercept(context) {
          // 检查当前测试运行条件，只有满足条件时才进入该分支。
          if (context.stage === 'beforeToolCall') {
            // 创建 call 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
            const call = context.value as { id: string; name: string; args: unknown };
            // 返回当前测试替身生成的值，供被测代码继续执行。
            return { action: 'replace', value: { ...call, args: { value: 'rewritten' } } as typeof context.value };
          // 结束当前对象、数组、回调或测试代码块。
          }
          // 检查当前测试运行条件，只有满足条件时才进入该分支。
          if (context.stage === 'beforeModelCall') {
            // 返回当前测试替身生成的值，供被测代码继续执行。
            return { action: 'replace', value: [...context.value as ModelRequest['messages'], { role: 'user', content: '临时提示' }] as typeof context.value };
          // 结束当前对象、数组、回调或测试代码块。
          }
          // 返回当前测试替身生成的值，供被测代码继续执行。
          return { action: 'continue' };
        // 结束当前对象、数组、回调或测试代码块。
        },
      // 结束当前对象、数组、回调或测试代码块。
      };
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider = new RecordingProvider([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'toolCallDelta', callId: 'explode-1', name: 'explode', argsDelta: '{"value":"original"}' }, { type: 'completed', finishReason: 'tool_calls' }],
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        [{ type: 'textDelta', text: '已处理失败' }, { type: 'completed', finishReason: 'stop' }],
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store: new SessionStore(join(root, '.sessions')), registry, mode: 'auto', interceptors: [interceptor] });
      // 创建 errorCode 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let errorCode = '';
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => {
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'tool.completed') errorCode = event.result.error?.code ?? '';
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'turn.completed') resolve();
      // 结束当前对象、数组、回调或测试代码块。
      }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('工具异常边界');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '调用异常工具');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(errorCode).toBe('tool_exception');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(provider.agentRequests[0]?.messages.at(-1)?.content).toBe('临时提示');
      // 创建 history 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const history = await core.readSessionEvents(session.id);
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(JSON.stringify(history)).not.toContain('临时提示');
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });

  // 验证超大工具输出被外置成 Artifact，模型可用引用分页读回且 Session 间隔离。
  it('externalizes a large tool result and reads it back through read_artifact', async () => {
    // 创建 root 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
    const root = await mkdtemp(join(tmpdir(), 'seecoder-artifact-'));
    // 进入受保护的测试主体；临时目录会在 finally 中无条件清理。
    try {
      // 创建 requests 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const requests: ModelRequest[] = [];
      // 创建 cursor 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let cursor = 0;
      // 创建 provider 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const provider: ModelProvider = {
        // 实现模型 Provider 的异步流接口，按测试脚本逐条产出事件。
        async *stream(request) {
          // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
          requests.push(structuredClone(request));
          // 检查当前测试运行条件，只有满足条件时才进入该分支。
          if (cursor === 0) {
            // 更新测试计数器，用于记录请求轮次、并发数量或回调次数。
            cursor += 1;
            // 测试 Provider 向 Agent 循环发送这一条模型流事件。
            yield { type: 'toolCallDelta', callId: 'large-1', name: 'large_output', argsDelta: '{}' };
            // 测试 Provider 向 Agent 循环发送这一条模型流事件。
            yield { type: 'completed', finishReason: 'tool_calls' };
            // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
            return;
          // 结束当前对象、数组、回调或测试代码块。
          }
          // 检查当前测试运行条件，只有满足条件时才进入该分支。
          if (cursor === 1) {
            // 更新测试计数器，用于记录请求轮次、并发数量或回调次数。
            cursor += 1;
            // 创建 observation 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
            const observation = request.messages.find((message) => message.role === 'tool' && message.toolCallId === 'large-1');
            // 创建 artifactRef 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
            const artifactRef = JSON.parse(String(observation?.content)).artifactRef as string;
            // 测试 Provider 向 Agent 循环发送这一条模型流事件。
            yield { type: 'toolCallDelta', callId: 'artifact-read-1', name: 'read_artifact', argsDelta: JSON.stringify({ artifactRef, offset: 0, limit: 100 }) };
            // 测试 Provider 向 Agent 循环发送这一条模型流事件。
            yield { type: 'completed', finishReason: 'tool_calls' };
            // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
            return;
          // 结束当前对象、数组、回调或测试代码块。
          }
          // 测试 Provider 向 Agent 循环发送这一条模型流事件。
          yield { type: 'textDelta', text: '已读取大型结果' };
          // 测试 Provider 向 Agent 循环发送这一条模型流事件。
          yield { type: 'completed', finishReason: 'stop' };
        // 结束当前对象、数组、回调或测试代码块。
        },
      // 结束当前对象、数组、回调或测试代码块。
      };
      // 创建 registry 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const registry = new ToolRegistry([
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        ...createToolDefinitions(),
        // 执行这一行测试步骤，为当前场景准备输入、推进状态或保存后续断言所需结果。
        {
          // 设置对象的 name 字段，构造被测代码所需的输入或配置。
          name: 'large_output', description: '返回大型结果', parameters: z.object({}), sideEffect: false, parallelSafe: true, timeoutMs: 1_000, risk: 'low',
          // 实现测试工具或 Hook 的执行函数，模拟真实运行结果。
          async execute() { return { ok: true, output: { payload: 'z'.repeat(25_000) }, durationMs: 1 }; },
        // 结束当前对象、数组、回调或测试代码块。
        },
      // 结束当前对象、数组、回调或测试代码块。
      ]);
      // 创建 store 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const store = new SessionStore(join(root, '.sessions'));
      // 创建 core 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const core = new AgentCore({ workspace: root, provider, model, store, registry, mode: 'auto' });
      // 创建 artifactId 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      let artifactId = '';
      // 创建 completed 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const completed = new Promise<void>((resolve) => core.onEvent((event) => {
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'artifact.created') artifactId = event.artifact.id;
        // 只在收到指定 Agent 事件时记录数据或结束当前等待 Promise。
        if (event.type === 'turn.completed') resolve();
      // 结束当前对象、数组、回调或测试代码块。
      }));
      // 创建 session 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const session = await core.createSession('Artifact');
      // 启动当前 Session 的 Turn；方法先返回 turnId，真正的 Agent 循环在后台继续运行。
      await core.startTurn(session.id, '读取大型结果');
      // 等待目标终态事件到达，确保异步 Agent 流程结束后再执行后续断言。
      await completed;
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(artifactId).toMatch(/^[a-f0-9-]{36}$/i);
      // 创建 observation 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const observation = requests[1]?.messages.find((message) => message.role === 'tool' && message.toolCallId === 'large-1');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(JSON.parse(String(observation?.content)).artifactRef).toBe(artifactId);
      // 创建 readResult 变量，保存本步骤生成的测试数据或异步状态，供后续操作和断言使用。
      const readResult = requests[2]?.messages.find((message) => message.role === 'tool' && message.toolCallId === 'artifact-read-1');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      expect(String(readResult?.content)).toContain('payload');
      // 断言这一步得到的状态、事件或数据符合当前测试场景的预期。
      await expect(store.readArtifact('another-session', artifactId)).rejects.toThrow();
    // 无论测试成功或失败都进入 finally，防止临时文件残留。
    } finally { await rm(root, { recursive: true, force: true }); }
  // 结束当前对象、数组、回调或测试代码块。
  });
}); // 结束 AgentCore 集成测试组。
