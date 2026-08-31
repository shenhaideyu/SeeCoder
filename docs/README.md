# SeeCoder 技术文档

本目录只保留答辩真正需要的七类文档。每份文档都对应考核要求或高频技术追问，不再为同一个机制维护多份重复说明。

## 阅读顺序

第一次接触 Coding Agent，建议按下面顺序阅读：

1. [需求分析](01-需求分析.md)：SeeCoder 要解决什么问题，怎样判断完成。
2. [软件系统设计与架构](02-软件系统设计与架构.md)：前端、可信后端、Core、模型和工具如何连接。
3. [Agent 核心详细设计](03-Agent核心详细设计.md)：主循环、Session、上下文、工具、解析、终止和错误处理。
4. [测试计划与测试用例](04-测试计划与测试用例.md)：怎样证明 Agent 不只是偶然成功。
5. [软件质量保证计划](05-软件质量保证计划.md)：变更、评审、发布、性能和故障管理。
6. [安全与威胁模型](06-安全与威胁模型.md)：模型为什么不可信，本地执行怎样受控。
7. [答辩设计决策](07-答辩设计决策.md)：技术选型、产品交互、高频问题和当前限制。

## 一页理解 SeeCoder

SeeCoder 是 Windows 本地 Electron 编程智能体。React Renderer 是前端，Electron Main 是本机可信后端。它不是“没有后端”，也不需要额外启动 HTTP 服务、数据库或 Redis。Renderer 通过 Preload 的类型化 IPC 向 Main 发出请求，所有文件、命令、密钥和 Agent 执行都留在 Main。

```text
用户输入
  → Renderer 发起 turn.start
  → Agent Core 构建受预算约束的上下文
  → ModelProvider 流式调用 OpenAI 兼容模型
  → 模型返回文本或 Tool Call
  → Core 校验参数、路径和权限
  → Tool Runtime 执行文件或命令操作
  → Tool Result 作为 Observation 返回模型
  → 继续循环，直到完成、失败、取消或达到上限
```

模型只负责提出下一步。Agent Core 负责状态机、消息协议、权限、执行、终止和恢复。模型不能直接访问 Node.js，也不能绕过工具调用本地能力。

系统的长期对话称为 Session。一次用户请求及其执行称为 Turn。完整历史以 V3 JSONL 追加保存，当前任务事实保存在 ContextLedger，文件修改前内容保存在 Snapshot。模型每轮只接收 ContextBuilder 根据预算构建的临时上下文，因此历史完整性和 token 控制可以同时满足。

## 关键事实

| 问题 | 当前实现 |
|---|---|
| Agent 是否自研 | 主循环、上下文、解析、工具、终止和错误处理全部自研 |
| 是否使用 Agent SDK | 不使用 LangChain、Agents SDK、Claude Agent SDK 等框架 |
| 是否有前后端 | 有；Renderer 是前端，Electron Main 是本地后端 |
| 模型协议 | OpenAI 兼容 Chat Completions、SSE 和原生 Tool Calling |
| 数据存储 | 本地 JSONL、JSON 状态和文件快照，无数据库 |
| 权限模式 | Plan、Guided、Auto |
| 子 Agent | Explore、Review；只读、不可嵌套、最多并发 2 个 |
| 上下文 | Ledger、Evidence、Observation、检索、语义摘要和最近消息 |
| 安全级别 | 应用层策略隔离，不是操作系统级沙箱 |
| API Key | 环境变量或系统安全存储，明文不进入仓库和日志 |

## 源码地图

| 模块 | 入口 | 职责 |
|---|---|---|
| Protocol | `packages/protocol/src/index.ts` | Session、Turn、Item、Event、模型与工具协议 |
| Agent Core | `packages/agent-core/src/index.ts` | 状态机、循环、审批、工具调度和终止 |
| Context | `packages/agent-core/src/context.ts` | Ledger、Evidence、检索、Observation 和预算 |
| Model | `packages/model/src/index.ts` | HTTP、SSE、Tool Call 增量和重试 |
| Tools | `packages/tools/src/index.ts` | 文件、搜索、补丁、命令、Git 与路径策略 |
| Storage | `packages/storage/src/index.ts` | Session 元数据、JSONL、状态、快照和回放 |
| Main | `apps/desktop/src/main/main.ts` | Electron 生命周期、IPC、设置、密钥和工作区 |
| Preload | `apps/desktop/src/preload/preload.ts` | Renderer 最小权限桥 |
| Renderer | `apps/desktop/src/renderer/main.tsx` | 对话、任务管理、审批、Diff 和终端 |

文档和源码冲突时，以已测试源码为准，并应立即修正文档。

## 初学者术语表

**模型（Model）** 是 DeepSeek 等大语言模型。它一次只根据输入生成文本或 Tool Call，没有本地文件权限。

**Agent Harness** 是模型外部的控制程序。在 SeeCoder 中主要是 Agent Core、ContextBuilder、ModelProvider、ToolRegistry、权限策略和 SessionStore。它决定模型能看什么、动作能否执行、结果怎样返回以及任务何时停止。

**Workspace** 是用户允许 SeeCoder 操作的本地项目根目录。路径策略以它作为安全边界。

**Session** 是左侧栏的一条长期任务对话。关闭应用后仍然保存。一个 Session 可以包含多次用户请求。

**Turn** 是一次用户请求从启动到终态的执行。一个 Turn 内可能多次调用模型和工具。

**Tool Call** 是模型提出的结构化动作，例如读取文件或运行测试。它只是请求，必须经过 Core 校验才能执行。

**Tool Result** 是工具执行的完整结构化结果，用于审计。**Observation** 是从 Tool Result 提取的模型所需信息，用于控制 token。

**ContextLedger** 保存当前目标、计划、revision、文件、验证和错误，是任务的权威工作状态。**FileEvidence** 保存模型读过的代码证据及内容哈希。

**ChangeSet** 描述一次文件变化。**Snapshot** 保存修改前内容。**Checkpoint** 把一组变更组织成可恢复节点，并使用哈希避免覆盖用户后续编辑。

**AgentEvent** 是后台发生的事实，例如模型请求开始、工具完成或 Turn 失败。Renderer 根据事件显示状态，不自行推断后台结果。

理解这些术语后，可以把 SeeCoder 概括为：Core 在 Session 中启动 Turn，构建上下文调用模型，执行经过保护的 Tool Call，把 Observation 返回模型，并用 Event 和 Snapshot 保存整个过程。

## 这些概念怎样连接起来

用户选择的项目目录首先成为 Workspace。Workspace 不是普通设置项，而是全部文件工具的根边界。随后用户在该 Workspace 中创建 Session。Session 负责长期保存任务，不代表后台一直运行。每次发送消息会在 Session 内建立 Turn，Turn 才拥有运行状态、迭代计数、取消信号和开始结束时间。

Turn 开始后，Agent Core 从 Session 中取出历史和 ContextLedger。ContextLedger 不是聊天记录，而是一份结构化任务状态，其中的目标、计划、代码 revision、验证和错误用于避免模型在长对话中遗忘事实。ContextBuilder 再把 Ledger、最近消息、当前 FileEvidence、检索结果和摘要组成 ModelRequest。这个过程称为上下文构建。

ModelProvider 把 ModelRequest 转换成兼容模型需要的 HTTP 请求。返回内容通过 SSE 流式到达。普通文本可以直接显示；Tool Call 必须先完整聚合并保存。Tool Call 只表示模型希望执行动作，Core 仍要经过 ToolRegistry、Zod、WorkspacePolicy 和权限策略。工具完成后产生 Tool Result，Core 再生成更精简的 Observation 送回模型。

如果工具修改文件，系统产生 ChangeSet、Snapshot 和 Checkpoint。ChangeSet 用于展示“改了什么”，Snapshot 保存“修改前是什么”，Checkpoint 用于恢复一组修改。ContextLedger 的 revision 同时增加，因此修改前通过的测试会自动变成旧验证。模型再次运行测试并通过后，验证记录才与当前 revision 一致。

所有过程通过 AgentEvent 形成内部事件记录。Renderer 只把用户需要的事实转换成消息卡、状态、Diff 和终端。SessionStore 将重要事件写入 JSONL。应用重启后，通过回放事件恢复已经发生的事实，但不会重新启动已经消失的网络请求和命令进程。

## 常见概念误区

Session 和 Context 不相同。Session 保存完整历史，Context 只是某次模型请求携带的有限视图。压缩 Context 不会删除 Session。

Tool Result 和 Observation 不相同。Tool Result 是完整执行事实，适合事件和审计；Observation 是面向模型的压缩结果。两者分开后，系统既能保留证据，又不会让长日志占满 token。

Plan 和计划文本也不相同。Plan 是一种禁止副作用的 ExecutionMode；计划文本是 Agent 给用户看的 PlanStep。即使模型在 Plan 模式错误请求写文件，Core 仍会在执行边界拒绝。

Checkpoint 和 Git Commit 不相同。Checkpoint 服务于本次 Agent 修改，独立于 Git，也不会污染提交历史。Git Commit 是用户显式执行的版本控制动作。

应用层安全策略和操作系统沙箱不相同。路径限制、审批和命令分类可以阻止常见危险动作，但被允许的进程仍以用户权限运行。真正的 OS 沙箱需要容器、虚拟机、Windows Sandbox 或受限 Token。

## 怎样从文档进入源码

先从 Protocol 查看 Session、Turn、Item、AgentEvent、ModelMessage 和 ToolResult 的类型。这些类型是模块之间共同使用的语言。随后进入 Agent Core 的 `startTurn`，看一次用户请求怎样建立；继续阅读 `runTurn`，看循环怎样调用 ContextBuilder 和 ModelProvider；再阅读 `executeCall`，理解工具校验、审批和结果回填。

理解控制流后，再进入 `context.ts`。ContextLedger 解释“哪些事实必须保留”，FileEvidence 解释“怎样避免重复代码”，MemoryIndex 解释“怎样召回旧信息”，`buildHybridContext` 解释“怎样分配 token”。如果先从压缩细节开始，很容易看见很多算法却不知道它们服务于哪一轮模型调用。

最后阅读 Tools 和 Storage。Tools 展示本地副作用怎样受到 WorkspacePolicy 控制；Storage 展示事件如何持久化与回放。Renderer 应最后看，因为它主要消费已经定义好的协议和事件。按照这个顺序，能够把界面现象映射回后端事实，而不是把 UI 当作 Agent 本身。

## 一次答辩的逻辑主线

答辩先说明问题：单次模型聊天不能安全完成真实本地编程任务。再说明架构：Renderer 表达意图，Main 是可信边界，Core 维护循环。随后说明核心：模型提出 Tool Call，Core 校验执行，把 Observation 回填，并用明确终态限制循环。接着说明长任务：Session 保留完整历史，ContextBuilder 控制模型视图。最后说明证据：ChangeSet、验证 revision、JSONL 和自动测试证明系统实际做过什么。

这条主线比逐项介绍按钮更重要。按钮只是入口，Agent Harness 才是项目的技术主体。
