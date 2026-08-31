# SeeCoder Agent 核心详细设计

本文回答考核中最重要的问题：SeeCoder 如何在不使用 Agent 框架的前提下，把一次模型调用变成可持续执行、可暂停、可恢复、可审计的编程任务。文档以当前源码为唯一事实依据，重点解释五条自行实现的链路：对话历史与上下文管理、工具定义与本地执行、模型输出解析、循环终止条件、错误处理。阅读本文不要求了解大语言模型或 Electron，但需要先接受一个基本事实：模型本身不是 Agent，模型只是在一次请求中返回文本或工具调用建议；真正让系统“连续工作”的是外围控制程序，也就是 Agent Harness。

本文中的“保证”表示代码在模型之外强制执行，例如路径不能越出工作区；“引导”表示通过系统提示影响模型选择，例如建议先搜索再读取；“限制”表示当前版本没有提供更强保证，例如 SeeCoder 只有应用层隔离，没有操作系统沙箱。三者必须分开。答辩时如果把 Prompt 中的一句话说成安全保证，评委只要让模型忽略它，就能证明设计不成立。

## 1. 先理解 Agent Harness

大语言模型可以根据输入生成代码，但它不能自行读取电脑文件，也不会自动保存上一次请求的内容。它在每次 API 请求中只能看到调用方发送的消息。所谓 Coding Agent，本质上是一个持续控制循环：系统准备当前任务需要的上下文，把上下文和工具说明发给模型；模型决定回答还是请求工具；系统校验并执行工具；系统把真实结果反馈给模型；模型依据新证据继续决策。这个循环直到出现明确终止条件。

Agent Harness 是包围模型的工程运行环境。它负责状态、权限、工具、上下文、重试、取消、日志和持久化。模型负责提出下一步，Harness 负责判断这一步能不能做、怎样做、结果是否可信、什么时候必须停止。SeeCoder 的 Harness 由 packages/agent-core、packages/model、packages/tools、packages/storage 和 packages/protocol 共同组成，没有使用 LangChain、OpenAI Agents SDK、Claude Agent SDK 等编排框架。

可以把一次执行写成下面的闭环：

~~~text
用户任务
  ↓
创建 Turn 并记录目标
  ↓
构建受预算约束的模型上下文
  ↓
流式调用模型并解析文本、Tool Call、usage、finish reason
  ↓
没有 Tool Call ───────────────→ 结束 Turn
  ↓ 有 Tool Call
保存完整 Assistant Tool Calls
  ↓
参数校验、权限判断、审批、Hook
  ↓
本地执行工具并生成 Tool Result
  ↓
保存事件、ChangeSet、Checkpoint、Observation
  ↓
把结果加入下一轮上下文，再次调用模型
~~~

这不是固定工作流。模型可以先搜索、再批量读取、再修改，也可以在测试失败后重新定位。固定的是控制边界：每次模型请求都经过 ContextBuilder，每个工具都经过 executeCall，每个副作用都经过权限策略，每个 Turn 都经过统一终止和清理路径。

## 2. 设计目标、非目标与核心不变量

Agent Core 的第一目标不是让模型“看起来聪明”，而是保证任务状态不会因为模型输出不稳定而损坏。系统必须允许模型犯错，同时把错误限制在可观察、可恢复的范围内。例如模型可能请求不存在的工具，Core 返回 unknown_tool；模型可能给出不完整 JSON，Core 返回 invalid_args；模型可能连续探索，Core 通过探索预算迫使它收敛；模型可能请求危险命令，Core 进入审批或拒绝。

当前设计追求五项性质。第一，确定性边界：同一 Tool Call ID 不重复产生副作用。第二，协议完整性：Assistant Tool Calls 与对应 Tool Result 成组保存和发送。第三，工作区隔离：文件路径必须留在当前 Workspace。第四，状态可恢复：应用重启后能够从 JSONL 和状态文件重建 Session。第五，成本有上界：主 Agent 最多 24 次模型迭代，子 Agent 最多 6 次，模型重试最多 3 次，命令有超时。

以下规则是实现中的核心不变量：

| 不变量 | 强制位置 | 意义 |
| --- | --- | --- |
| 一个 Session 同时只有一个活动 Turn | activeSessionTurns | 防止同一任务并发写入与状态串线 |
| 一个 Tool Result 必须对应先前的 Assistant Tool Call | 消息分组与事件回放 | 保证下一次模型请求符合协议 |
| 同一 Turn 内相同 callId 只执行一次 | executedCalls | 防止重试造成重复写入或重复命令 |
| Plan 模式不能执行副作用工具 | executeCall | 不依赖模型自觉遵守只读要求 |
| 文件路径不能越出 Workspace | WorkspacePolicy | 限制模型可接触的本地范围 |
| 子 Agent 只能读取 | 子 Agent 工具白名单 | 保证主 Agent 是唯一写入者 |
| 验证只证明相同 changeRevision | ContextLedger V2 | 防止用修改前的测试证明修改后的代码 |
| 一个 Turn 只发布一个终态 | runTurn 统一出口 | 防止 UI 同时看到 completed 和 failed |
| 取消必须传播到模型、工具和子 Agent | AbortSignal | 避免 UI 停止但后台继续运行 |

当前版本不是操作系统级沙箱，也不是云端多租户服务。它不承诺阻止当前 Windows 用户通过任意可执行程序访问全部系统资源。安全来自工具面收缩、路径规范化、敏感文件过滤、命令风险识别、审批和审计。这个边界必须在答辩中主动说明。

## 3. 模块边界：每个包只负责一种问题

packages/protocol 定义跨模块共享的数据契约，包括 Session、Turn、Item、AgentEvent、ModelMessage、ToolCall 和 ToolResult。它不执行任务。把协议单独成包的原因是 Main、Core、Model、Tools、Storage 和 Renderer 都要理解同一组对象；若各层自行声明近似类型，字段和状态会逐渐不一致。TypeScript 类型只能约束编译期，因此 IPC、模型参数和文件配置仍需要运行时校验。

packages/model 只处理 OpenAI 兼容 Chat Completions 协议。它把内部 ModelMessage 转成 API 消息，使用 fetch 发起流式请求，把 SSE 分片解析为统一 ModelEvent，并完成有限重试。它不知道 Workspace、审批或任务是否完成。

packages/tools 定义本地能力。每个 ToolDefinition 包含名称、描述、Zod 参数、sideEffect、risk 和 execute。该包还实现 WorkspacePolicy、文件事务写入、补丁解析、命令执行、输出截断和敏感路径过滤。工具返回结构化 ToolResult，不直接改变 Agent 状态。

packages/storage 使用追加式 JSONL 保存事件，用 meta.json 保存 Session 元数据，用 state.json 保存 ContextLedger，用 snapshot 文件保存修改前内容。它还提供纯事件回放函数。Storage 不调用模型、不执行历史工具。

packages/agent-core 是协调者。它持有 Session、Turn、消息视图、审批、AbortController、ChangeSet、Checkpoint、Ledger、Evidence 和 MemoryIndex，把 Model、Tools 与 Storage 串成主循环。Core 不负责窗口和页面。

Electron Main 是本地可信后端。它创建 Core、读取加密模型配置、注册 IPC、选择 Workspace、管理 Git 和计划任务，并把 AgentEvent 推给 Renderer。Renderer 是 React 前端，只能通过 preload 暴露的类型化 IPC 请求本地操作；nodeIntegration 关闭，Renderer 不能直接调用 Node.js 文件系统。

这种模块化单体没有远程后端、数据库、Redis 或队列。对本地 Demo 而言，单进程内调用比远程服务更少故障点，也更容易保证文件操作发生在用户电脑。代价是任务不能在应用退出后继续执行，未完成 Turn 重启后只能标记为 interrupted，而不能恢复到某条机器指令的中间位置。

## 4. 核心数据模型：Session、Turn、Item 与 Event

Session 是长期对话容器，对应左侧栏中的一个任务。它包含 id、标题、Workspace 路径、创建时间、更新时间以及置顶、归档、未读等展示字段。Session 可以包含多个 Turn，因此用户完成一次修改后继续追问，不需要丢弃之前的任务背景。Session 与 Workspace 绑定，Core 列表查询会按规范化路径过滤，避免切换项目后看到或恢复其他项目的任务。

Turn 是一次用户请求的运行周期。用户发送 Prompt 时创建 Turn；模型可能在这个 Turn 内被调用多次。Turn 保存 id、sessionId、状态、开始和完成时间、当前迭代数。Session 解决“这段长期对话属于谁”，Turn 解决“这一次执行是否仍在运行”。

Item 是需要参与恢复或模型历史重建的业务记录。user_message 保存用户原文；assistant_message 保存完整回答及 Tool Calls；tool_result 保存调用结果；plan、changes、approval、subagent、compaction 和 error 保存相应事实。Item 比 Event 更接近可恢复业务内容。

Event 表示系统在某个时间发生了什么。message.delta 用于 UI 流式显示；model.requested、model.completed 描述模型请求；tool.requested、tool.output、tool.completed 描述工具生命周期；turn.completed、turn.failed、turn.cancelled 描述终态。Event 使用 V3 信封持久化，信封包含 version、唯一 id、递增 seq、type、sessionId、可选 turnId、timestamp 和 payload。

Item 与 Event 并不重复。一次 tool.completed Event 告诉 UI “工具结束了”，同一条记录中的 tool_result Item 让重启后的 Context 恢复工具观察。message.delta 不逐片写入 JSONL，因为一次长回复可能产生数千次磁盘写入；流结束后，完整 Assistant 消息才持久化。这是在实时体验和存储规模之间的取舍。

## 5. Session 管理与恢复语义

创建 Session 时，Core 生成 UUID，写入当前 Workspace、标题和时间，同时初始化空消息数组、ContextLedger、FileEvidenceStore 和 MemoryIndex。SessionStore 先创建目录，再以临时文件加 rename 的方式保存 meta.json，避免设置文件只写到一半。

加载 Session 时执行 hydrateSession。它先读取 meta.json，并检查记录的 Workspace 与当前 Workspace 是否一致；不一致则拒绝加载。随后读取 state.json 恢复 ContextLedger，再读取 events.jsonl 并调用 replaySessionEvents。回放函数按 seq 排序，识别重复序号、倒序、跨 Session 事件、孤立 Tool Result 和重复终态。合法 Item 被转换为 ModelMessage，ChangeSet 与 Checkpoint 放回内存索引，MemoryIndex 从历史重建。

回放是纯 reducer：输入历史记录，输出恢复结果，不读写磁盘、不调用模型、不执行工具。这样设计是为了避免“恢复会话”意外重放副作用。假设历史中记录了 run_command 或 write_file，但应用在结果落盘前崩溃，系统无法可靠判断操作是否完成。SeeCoder 不猜测，也不重新执行；它把没有终态的 Turn 标记为 interrupted，并要求用户重新尝试。

Compaction Item 在恢复时具有特殊含义。它保存压缩后的模型消息视图。Core 遇到它时会替换更早的模型消息视图，而不是删除原始 events.jsonl。原始轨迹仍可审计，模型只接收较小历史。之后出现的新 Item 继续追加到压缩视图之后。

删除 Session 会删除 SeeCoder 数据目录中的会话、Ledger 和 Snapshot，并清理内存 Map；不会删除 Workspace 源码。运行中的 Session 不允许删除，必须先取消 Turn。重命名只改变 meta.json 的标题，不改变 goal。归档和置顶是导航属性，不改变模型上下文。Fork 复制对话事件形成新 Session，但当前实现不创建 Git worktree，也不复制独立 Workspace，因此它是“对话历史分叉”，不是“代码环境隔离”。

## 6. Turn 状态机

当前 TurnStatus 为 queued、running、waitingApproval、waitingInput、completed、failed、cancelled、limitReached。queued 表示已经接受但循环尚未开始；running 表示 Core 正在准备上下文、请求模型或执行不需要等待用户的步骤；waitingApproval 表示某个副作用工具等待许可；waitingInput 表示 ask_user 等待回答；其余四个是终态。

模型请求中、工具执行中和验证中没有各自的 TurnStatus。它们由 model.requested、tool.requested、tool.output、review.started 等事件描述。这样避免状态枚举过细，但 UI 必须结合 TurnStatus 与最新事件展示“正在调用模型”“正在运行测试”等阶段。若只看 running，无法判断具体进度。

状态转换如下：

~~~text
queued
  → running
      → waitingApproval → running
      → waitingInput    → running
      → completed
      → failed
      → cancelled
      → limitReached
~~~

Renderer 不拥有业务状态机。点击取消时，前端只发 turn.cancel 请求；只有 Core 完成 Abort 与清理并发布 turn.cancelled 后，UI 才显示最终取消。这防止“页面已经停止、后台仍在执行”。同理，审批按钮只提交决策，Core 才负责从 waitingApproval 回到 running。

activeSessionTurns 保存 sessionId 到 turnId 的唯一映射。startTurn 在创建 Turn 前检查它；存在活动 Turn 时，新的正文不能另起并发 Turn，只能作为 Follow-up 排队或先取消。这个约束比在 UI 禁用按钮更可靠，因为 IPC 仍可能被重复触发。

## 7. 从 startTurn 到 runTurn

startTurn 是一次任务的入口。它确认 Session 存在且属于当前 Workspace，拒绝同 Session 并发 Turn，记录本轮模式，并根据用户文本是否包含中文设置输出语言规则。若用户选择了 Skill，Skill 内容在本轮保存并限制到 20000 字符。附件最多取前四个；图片转成 data URL 内容块，文本附件最多读取 40000 字符，读取前仍经过 WorkspacePolicy。

用户消息同时进入三个位置。第一，加入 Session 的 ModelMessage 历史，为下一次模型请求提供原文；第二，作为 user_message Item 写入 JSONL，支持重启恢复；第三，写入 ContextLedger.goal，成为当前权威目标。随后 Core 发布 turn.started 和 message.user，并以异步方式进入 runTurn。

runTurn 为本轮创建 AbortController，将状态设为 running，初始化无进展计数、只读探索计数、收敛提醒标记和输出截断计数，然后进入最多 24 次的 for 循环。每轮不是简单地把上轮文本继续发送，而是重新读取 Session 当前消息、注入 Follow-up、根据预算构建上下文、重新计算模型请求并处理所有工具结果。

选择“每轮重建上下文”是因为状态一直在变：文件修改会增加 revision，测试会新增 validation，用户可能追加要求，旧 Evidence 可能失效，历史可能达到压缩阈值。如果把第一次构建的请求对象不断追加，权威状态、预算和消息配对都容易失真。

## 8. 主循环的逐步控制逻辑

每轮开始先检查 AbortSignal。若已经取消，立即抛出 code 为 cancelled 的 AgentRunError。随后取出 Follow-up 队列，把每条追加要求变成新的 user 消息和 message.user 事件。Follow-up 只在模型调用边界注入，因为模型请求已经发出后无法修改其输入，在 Assistant Tool Calls 与 Tool Result 之间插入 user 消息也会破坏工具协议。

Core 接着检查探索预算。连续四轮只有只读探索时，会加入一条执行约束提醒，要求基于已有证据实施最小修复或指出唯一阻塞点。第 22 轮会加入迭代预算提醒，告诉模型只剩三轮。提醒属于引导，不是硬保证；第七个连续只读探索轮以后，新的探索型工具会直接得到 exploration_budget_exhausted，才是硬限制。

compactMessages 调用混合 ContextBuilder。它计算系统提示、工具 Schema、Ledger、Evidence、检索和历史的估算 token，必要时生成摘要，最终返回合法 ModelMessage。Core 在前面加入动态系统提示，然后构造 purpose 为 agent 的 ModelRequest。

模型响应通过 AsyncIterable 持续到达。textDelta 追加到本轮文本并实时发布 message.delta；toolCallDelta 按 callId 合并工具名和参数字符串；usage 更新 token；retry 更新重试次数；completed 保存 finishReason；error 暂存结构化错误。流结束后发布 model.completed。若有模型错误，Core 抛出 AgentRunError，不执行不完整工具。

接着把所有聚合后的 Tool Calls 与文本组成一条 Assistant 消息。关键顺序是先将完整 Assistant Tool Calls 加入模型历史并持久化，再执行工具。工具逐个按模型给出的顺序运行，每个结果形成 tool 消息并引用原 callId。顺序执行保证写入、ChangeSet、Checkpoint、revision 与事件 seq 的因果关系确定。

如果模型没有 Tool Call，正常情况下 Turn 结束。若 finishReason 是 length 且没有工具，表示文本达到输出上限，不能视为成功。Core 注入恢复提示、主动压缩并重试；连续三次被截断则以 output_limit 失败。若有工具，Core 依次调用 executeCall；finish 成功会设置 finished，当前工具组处理完成后退出循环。

本轮如果没有任何成功工具，并累计三次工具失败，就以“连续三次工具调用失败，判定为无进展”结束。当前实现统计连续失败次数，不计算参数指纹；因此文档不能声称它只识别“完全相同的失败调用”。任何成功工具都会把计数清零，exploration_budget_exhausted 作为收敛控制信号也不会增加无进展计数。

## 9. 对话历史：为什么不能把整个 JSONL 直接发给模型

对话历史有两种不同用途。审计历史要完整回答“用户说了什么、模型请求了什么工具、工具实际返回什么、任务为何结束”，因此采用追加式事件保存。模型工作历史只需要回答“当前目标是什么、已做过什么、下一步依据是什么”，并受到 Context Window 限制。这两种用途不能使用同一个无限增长数组。

如果每轮把整个 JSONL 原样发送，会产生四个问题。旧命令日志会挤掉当前代码；重复文件读取会反复付费；已经被新决策推翻的内容仍与当前事实竞争；历史中的孤立 Tool Result 或损坏记录可能导致 API 400。简单保留最近 N 条也不可靠，因为一条 Assistant 消息可能请求多个工具，按条裁剪会把协议组截断。

SeeCoder 因此保留三层数据。events.jsonl 是不可变事实轨迹；ContextLedger V2 是当前权威任务状态；ModelMessage[] 是可压缩的模型视图。模型视图可以被 Compaction Item 替换，但原始事件不删除。Ledger 通过 state.json 独立持久化，即使自然语言摘要遗漏细节，目标、revision、验证和错误仍可恢复。

## 10. Context Window、Token 与预算

Context Window 是一次模型请求可接收的输入与输出总容量。模型不是把整个硬盘装进记忆，而是只能看到本次请求中的 system、user、assistant、tool 消息和工具 Schema。Token 是模型处理文本的单位，不等于字符。英文短词可能接近一个 token，中文字符通常消耗更多；不同模型 tokenizer 不同。

SeeCoder 没有绑定供应商 tokenizer，而使用保守 Unicode 估算：ASCII 字符约计 0.25 token，非 ASCII 字符约计 1 token，每条消息再加固定开销。它不是精确计费值，作用是提前触发压缩，避免在服务端才发现超限。真实 usage 仍以模型 SSE 返回的 prompt_tokens 与 completion_tokens 为准。

可用输入预算按下式计算：

~~~text
availableInput
= contextWindow
- maxOutputTokens
- max(2048, contextWindow × 5%)
~~~

maxOutputTokens 为模型回答预留空间；安全余量吸收估算误差、消息序列化开销和工具 Schema 变化。总估算超过 availableInput 的 75% 时自动压缩，压缩目标是 60% 以下。75% 与 60% 之间的间隔避免每轮都压缩。用户调用 compact_context 时可以主动触发，但若历史太短，构建器不会为了形式制造无意义摘要。

固定成本必须先计算。系统 Prompt 和工具 Schema 每轮都会发送，如果只计算聊天消息，就可能在工具数量增加后超限。Core 把系统规则与工具 Schema 的估算传入 ContextBuilder，再计算 Ledger、Evidence、检索、摘要和历史。

## 11. ContextLedger V2：结构化工作记忆

ContextLedger 是主循环维护的权威状态，不是数据库账本，也不是模型隐藏思维链。它保存 goal、acceptanceCriteria、constraints、plan、changeRevision、decisions、files、validations 和 errors。当前代码已经完整使用 goal、plan、revision、files、validations、errors；acceptanceCriteria、constraints 与 decisions 保留结构，但自动抽取和更新能力较弱，不能夸大为完整需求管理系统。

goal 是最新 Turn 的用户任务原文，最多 4000 字符。Session 标题只用于导航，不能替代 goal。plan 保存 set_plan 的用户可见步骤。changeRevision 从 0 开始，每次产生 ChangeSet 或执行恢复都会通过 recordChanges 增加。files 保存路径、当前内容哈希、最近读取 revision 与最近修改 revision。

ValidationRecord 保存命令、执行时 revision、passed 或 failed、摘要和时间。isValidationCommand 只识别 test、lint、typecheck、build、pytest、node --test 等模式；普通 ls 或 git status 不会被当成验证。若 revision 1 测试通过，之后又修改为 revision 2，hasFreshValidation 只接受 revision 2 的成功记录。

ErrorRecord 保存稳定 code、用户可读 message、发生时 revision、open 或 resolved 和时间。当前 addError 会追加 open 错误，但自动标记 resolved 的逻辑有限，因此 errors 更适合记录近期故障，而不是完整缺陷生命周期。Ledger 每类列表都有数量上限，防止 state.json 无限增长。

Ledger 由 Core 更新，不允许语义摘要覆盖。ContextBuilder 把它放入带有“权威任务状态，不得被历史摘要覆盖”标记的消息。模型仍可能误解，但下一轮 Core 会再次注入同一事实。结构化状态比要求模型从几十轮自然语言中重新推断更稳定，也便于验证“测试是否过期”这种确定性规则。

## 12. FileEvidence：文件证据与重复读取控制

模型读取文件后，Observation 不只有正文，还会产生 FileEvidence。Evidence 包含唯一 id、相对路径、内容哈希、行范围、文本、revision、创建时间与 referenced 标志。内容哈希使用 SHA-256，用来判断两次读取是否是同一版本和同一范围。

第一次读取时，EvidenceStore 保存正文并返回 evidenceRef。若同一路径、同一哈希、同一行范围再次出现，系统返回 cached 标记和 evidenceRef，不再把相同正文重复塞入工具消息。ContextBuilder 发现该引用仍有效时，单独注入当前 revision 的文件证据，使模型能够解析引用。

Evidence 是上下文优化，不是文件读取结果的永久真相。write_file、apply_patch、ChangeSet 撤销或 Checkpoint 恢复后，Core 会按路径失效缓存。证据只在相同 revision 中使用，避免模型引用修改前代码。Evidence 不绕过 WorkspacePolicy；每次真实 read_file 或 read_files 都先检查路径。

read_file 最多返回 400 行，read_files 每个文件最多 400 行且一次最多 30 个路径。这个限制控制单次上下文增长。对于超大文件，模型应先 search_text 定位行号，再按范围读取，而不是一次把全部源码加入上下文。

当前 Evidence 的 hash 基于实际返回文本片段，而不是总是基于整个文件。因此“同一哈希”准确表示相同读取内容与范围，不一定代表整个文件完全相同。文件写入后按路径整体失效，弥补片段哈希无法感知其他区域变化的问题。

## 13. Observation：把工具结果变成模型可用证据

ToolResult 是完整的程序结果，Observation 是发送给模型的压缩表达。两者分离的原因是命令可能输出 1 MiB，Diff 可能很大，模型只需要退出码、关键错误和相关片段。完整结果用于事件、UI 或调试，Observation 用于下一轮决策。

serializeObservation 按工具类型处理。read_file 和 read_files 记录 Evidence；重复读取改为 evidenceRef。search_text 对完全相同条目去重，最多保留 50 条，并记录 total 与 truncated。run_command 保留 command、exitCode、stdout 头尾、stderr 尾部、诊断行以及是否裁剪。诊断行通过 error、failed、exception、warning 和常见源码后缀筛选。git_diff 保留受预算限制的 Diff 头尾与 stderr。

write_file 与 apply_patch 不把 before 和 after 全文再次发给模型，只返回文件路径和修改前后字符数。完整变更已经保存在 ChangeSet。未知工具先 JSON 序列化；小于 16000 字符原样返回，过长则保留前 10000 和后 4000 字符，并明确说明完整结果在轨迹中。

所有 Observation 都保留 ok、error 和 durationMs。ok 表示工具执行是否成功，不代表任务完成。error.code 是程序可判断的稳定分类，message 是用户和模型可读说明。模型可以根据 command_failed、patch_failed 或 approval_denied 选择下一步，而不是从一段自由文本猜测。

Observation 压缩不能只保留“失败”二字。测试失败的退出码和最后诊断通常决定能否修复；读取结果必须保留路径和行范围；补丁结果必须保留修改文件。SeeCoder 的压缩策略是按工具语义保留决策信息，而不是统一按字符截断。

## 14. MemoryIndex：轻量历史检索

长期 Session 中，某个早期决定可能在最近消息之外仍然相关。MemoryIndex 从 user、assistant、change、error、validation 和 decision 记录建立最多 500 条内存项。每条包含文本、路径、关键词、Session、可选 Turn、revision、时间和状态。

关键词提取对英文、数字、下划线、路径字符保留连续词，对中文去掉非汉字后生成二元组。例如“上下文压缩”会产生“上下”“下文”“文压”“压缩”。路径通过简单模式提取。检索查询由 Ledger goal 与最新 user 消息组成，按关键词匹配、路径命中、当前 revision、active 状态和时间衰减打分。

检索最多返回 6 条，总文本不超过 4000 字符，并排除当前 Turn、resolved 错误、superseded 决策和旧 revision 的验证。ContextBuilder 还会去掉与最近自然语言完全相同的结果，避免同一消息重复出现。

当前不使用 Embedding 与向量数据库。原因不是向量检索无价值，而是此项目的高价值线索通常是文件路径、符号名、命令和错误码，词法检索可解释、可从 JSONL 重建、没有索引服务和模型费用。缺点是无法很好召回语义相近但词面不同的描述，这属于后续可选优化，不影响当前考核要求。

## 15. 混合上下文构建算法

buildHybridContext 先调用 sanitizeModelMessages 清除不完整工具组，再将重复 Evidence 正文折叠为引用。随后构造三类临时消息：权威 Ledger、按需历史检索、当前 revision 的 referenced Evidence。它们只存在于模型请求，不会作为新的用户对话永久追加。

若估算未超过 75% 且用户没有强制压缩，最终上下文为临时消息加当前安全历史。若需要压缩，构建器先把消息按协议组划分。普通 user 或 assistant 文本各自成组；带 Tool Calls 的 assistant 与随后引用其 callId 的全部 tool 消息组成一个不可拆分组。孤立 tool 消息会被丢弃。

压缩时默认保护最后一个消息组、最近一个完整工具组和最近六组。其他旧消息交给 summarizeContext。语义摘要只覆盖旧的 user 与 assistant 叙事，不拥有 Ledger、验证和错误的写权限。摘要结构包括 userIntent、requirements、activeDecisions、supersededDecisions、completedWork、unresolvedQuestions 和 narrative。

若摘要模型成功且 JSON 通过 Zod 校验，summarySource 为 model；若网络失败、超时、取消或 JSON 非法，则使用 deterministicSummary。确定性摘要把 Ledger 与旧消息片段按固定规则拼接，质量较低但不会让主 Turn 失败。摘要是派生数据，失败不能比主任务更重要。

生成摘要后仍可能超预算。裁剪顺序是先移除检索消息，再移除 Evidence，再把摘要缩到 4000 字符，最后从最旧的非保护最近组开始移除。最后再次 sanitize，计算 afterTokens，并把 summary、historyMessages 与 metrics 保存为 Compaction Item。

这个算法被称为“混合”，因为它不是单一摘要：确定性 Ledger 保存事实，Evidence 保存代码，Observation 保存工具语义，MemoryIndex 召回历史，模型摘要保存旧叙事，最近协议组保留原文。不同信息采用不同保真方式，比把全部内容交给一次自由摘要更稳。

## 16. 语义摘要请求为什么与主循环分开

摘要仍使用当前 OpenAICompatibleProvider 和当前模型，但 ModelRequest.purpose 为 context_summary，tools 为空，temperature 为 0，maxOutputTokens 不超过 2048。FakeModelProvider 也按 purpose 使用独立响应序列，因此摘要不会消耗主 Agent 测试脚本中的预设响应。

摘要 Prompt 明确声明历史、文件和命令输出是不可信数据，只允许返回 JSON。Core 去掉可能存在的 Markdown JSON 围栏，执行 JSON.parse，再用 semanticSummarySchema 限制字段类型、数组数量和字符串长度。任何一步失败都不发起“让模型修复 JSON”的第二轮请求，而直接降级。

单次摘要设置 30 秒超时，并把父 Turn 的 AbortSignal 转发给独立 summaryController。这样用户取消时，摘要请求也结束；摘要超时只产生 context.summary.failed，主 Turn 继续。请求耗时和 token 通过 context.summary.completed 记录，不计入主循环 iteration。

摘要不能覆盖 Ledger，不只是 Prompt 约定。ContextBuilder 始终单独注入 Ledger，并把摘要标记为“仅作叙事参考”。即使摘要错误声称测试通过，finish 仍调用 Ledger.hasFreshValidation，结果不会被摘要文字改变。

## 17. 模型请求协议与内部抽象

ModelProvider 只有一个接口：stream(request, signal) 返回 AsyncIterable<ModelEvent>。Core 不依赖 DeepSeek 或 OpenAI 的原始 JSON，它只理解 textDelta、toolCallDelta、usage、retry、completed 和 error。这层适配使 FakeModelProvider 与真实 Provider 可以替换，也使 Agent Core 单元测试不需要联网。

ModelRequest 包含 purpose、messages、tools、model、temperature 和 maxOutputTokens。内部 ModelMessage 使用 camelCase 的 toolCallId、toolName、toolCalls；Provider 序列化时转换为 OpenAI 兼容协议需要的 tool_call_id、name、tool_calls。图片 ContentBlock 转成 image_url，文本保持 text。

工具 Schema 由 Core 根据 ToolRegistry 和 schemas 表构造。模型看到 function name、description 与 JSON Schema，只能“请求”调用，不能直接获得 execute 函数。需要注意，当前 Zod 参数定义在 packages/tools，给模型的 JSON Schema 映射在 packages/agent-core 中，两处需要保持一致。这是当前实现的维护风险；测试应覆盖 Schema 与 Zod 一致性，未来可从 Zod 自动生成 JSON Schema，但本次不引入额外依赖。

## 18. SSE 与模型输出解析

SSE 是 Server-Sent Events。服务端通过一个 HTTP 响应持续发送形如 data: JSON 的行。网络 reader.read 返回的是任意字节块，一个 JSON 行可能被拆成多块，多行也可能合并在一块，因此不能把每个 chunk 直接 JSON.parse。

OpenAICompatibleProvider 使用 TextDecoder 和 buffer。每次收到字节后追加到 buffer，按换行分割，只处理完整行，把最后一个不完整片段留给下一次读取。data: [DONE] 表示流结束。parseJsonLine 忽略空行和非 data 行，解析失败的单行返回 null。当前实现对畸形 SSE 行采取跳过策略，没有累计协议错误阈值；若供应商持续返回损坏行，最终可能表现为没有内容。这是已知限制，后台日志中的 empty_response 或无输出诊断仍可继续加强。

每个 SSE JSON 的 choices[0].delta.content 变成 textDelta。delta.tool_calls 可能只包含 index、可能后续才给 id 或 function.name，也可能把 arguments 拆成多个字符串片段。Provider 维护 index 到 callId 的 Map；若首个片段没有 id，暂用 call-index，后续收到真实 id 时更新。Core 再按 callId 聚合 name 与 argsDelta。

usage 通常在最后一个 chunk 中返回，Provider将 prompt_tokens 和 completion_tokens 转成 usage。finish_reason 转成 completed。finish reason 是模型生成结束原因，不是业务成功状态：tool_calls 表示需要执行函数；stop 表示本次生成自然结束；length 表示达到输出上限；其他供应商特定值会原样记录。

参数只能在整个流结束后解析。Core 的 parseArgs 对完整 arguments 执行 JSON.parse；空参数视为对象。非法 JSON 转成带 __invalid 的对象，随后 Zod 校验失败并产生 invalid_args。这样半段 JSON 永远不能进入工具 execute。

## 19. 模型重试、超时与取消

Provider 最多进行三次尝试。HTTP 429、502、503、504 被视为可重试；其他非 2xx 直接产生 http_状态码。网络异常在还有次数时重试。退避为 250 毫秒乘以二的 attempt 次方，再加 0 到 100 毫秒抖动。抖动防止多个任务在同一时间重试形成同步洪峰。

每次重试前产生 retry 事件，Core 记录最大的 attempt，并在 model.completed 中展示 retries。HTTP 错误正文最多读取 1000 字符，避免服务端返回大页面进入日志。Provider 不把 authorization Header 或 API Key写入事件。

AbortSignal 同时传给 fetch 和 sleep。用户取消时，fetch 抛出 AbortError，Provider产生 cancelled；Core 在流结束后再次检查 signal，确保不会继续执行已缓冲 Tool Calls。摘要请求、子 Agent 和命令工具也使用同一父取消链。

当前主模型请求没有额外应用层定时器，依赖 fetch、网络栈与用户取消；命令和摘要有明确超时。这意味着长时间无响应的兼容网关仍可能占用 Turn，属于后续应补的 P1 能力。文档必须如实区分“命令超时已实现”和“主模型请求总超时尚未单独实现”。

## 20. Assistant Tool Calls 与 Tool Result 配对

OpenAI 兼容协议要求 Assistant 消息中的每个 Tool Call 都有唯一 id，后续 tool 消息使用 tool_call_id 引用它。若工具结果没有来源，或一个多工具组只保留部分结果，下次请求可能返回 HTTP 400。SeeCoder 曾经出现 missing tool_call_id 类问题，因此当前设计把协议配对作为硬不变量。

Core 的 `sanitizeModelMessages` 负责按协议组裁剪上下文，Provider 在真正发送 HTTP 请求前再做一次线性规范化。规范化只保留“一个 Assistant Tool Call 组及其全部匹配 Tool Result”，丢弃孤立 Tool Result、不完整工具组和重复结果，并按 Assistant 声明的调用顺序排列结果。这道发送前门禁不能替代 Core 的正确性，但能阻止恢复数据、第三方兼容消息或历史裁剪错误直接形成无效请求。

DeepSeek 的思考模式会在工具调用轮次产生 `reasoning_content`，后续请求要求回传该字段。SeeCoder 的安全规则禁止持久化和展示模型私有思维链，因此不能把该字段写入 Session 历史。对 DeepSeek 官方 Chat Completions 地址，Provider 在工具任务中显式关闭思考模式，只使用公开文本与 Tool Calls；这样既满足接口协议，也保持“私有思维链不入轨迹”的产品边界。其他 OpenAI 兼容服务不接收这一供应商专用字段。

正确结构如下：

~~~text
assistant:
  content: ""
  toolCalls:
    - id: call-A
      name: read_file
      arguments: {"path":"a.ts"}
    - id: call-B
      name: read_file
      arguments: {"path":"b.ts"}

tool:
  toolCallId: call-A
  content: 读取 a.ts 的 Observation

tool:
  toolCallId: call-B
  content: 读取 b.ts 的 Observation
~~~

Core 先保存 Assistant，再执行 call-A 和 call-B，结果分别保存。messageGroups 扫描历史时，遇到带 Tool Calls 的 Assistant 就收集后续 tool 消息，只有所有 callId 都出现才保留该组。孤立 tool 被跳过。sanitizeModelMessages 在恢复、压缩前后都会运行。

同一模型响应中的工具在主 Agent 内顺序执行。这样做牺牲一部分只读调用速度，但换来事件 seq、ChangeSet、revision 和错误观察的确定顺序。只读分析的并行性通过最多两个独立子 Agent 实现，避免主写链并发。

## 21. ToolDefinition：工具不是一段 Prompt

ToolDefinition 是工具的运行时合同。name 是模型调用标识；description 说明适用时机；parameters 是 Zod Schema；sideEffect 表示是否可能改变文件、进程或外部状态；risk 为审批展示提供 low、medium、high；execute 接收已校验参数和 ToolContext，返回 Promise<ToolResult>。

ToolContext 包含 Workspace、可选 AbortSignal、stdout/stderr 回调和环境变量覆盖。ToolResult 统一包含 ok、可选 output、可选 error 以及 durationMs。error 中 code 稳定、message 可读、retryable 可选。统一结果使主循环不需要理解每个工具的异常类型。

工具注册在 ToolRegistry 的 name 到 definition Map 中。未知名称返回 undefined，Core 转成 unknown_tool。Core 不直接信任模型参数：先 parseArgs，再执行 definition.parameters.safeParse。只有 parsed.data 进入 execute。Zod 在这里承担运行时边界，因为 TypeScript 类型在网络 JSON 到达时已经不存在。

delegate、ask_user、checkpoint、review_changes 和 compact_context 属于 Core 工具。它们在 Registry 中仍有 Schema 和描述，但真实行为由 executeCall 分派，因为它们需要访问 Turn、审批 Map、子 Agent 或 ContextBuilder。若绕过 Core 直接执行，会返回 unhandled，防止出现第二套调度逻辑。

## 22. executeCall 的完整门禁链

executeCall 首先取得当前 Turn 的 callId 结果缓存。已存在则直接返回第一次 ToolResult，不再次发布副作用。这个幂等范围是单 Turn；重启恢复不会自动重新执行历史 Tool Call，因此不需要跨进程重放幂等。

然后发布 tool.requested 并保存 tool_call Item，查找 ToolDefinition，执行 Zod 校验。Plan 模式下，只要 definition.sideEffect 为 true，就直接返回 plan_read_only。接着 WorkspacePolicy.canAutoApprove 根据本轮模式、工具名、路径和命令风险决定是否需要审批。

需要审批时，Core 创建 Approval，Turn 进入 waitingApproval，发布 approval.requested，并等待一个 Promise。Promise resolver 存在 approvals Map 中。用户允许后回到 running；拒绝则得到 approval_denied ToolResult。等待过程不轮询、不占用模型请求或子进程。

审批通过后执行 preToolUse Hook。Hook 失败得到 hook_blocked，真实工具不执行。随后构造 ToolContext，把 AbortSignal 与 tool.output 回调交给工具。Core 工具在本地分派，普通工具调用 definition.execute。

complete 函数是统一收尾点。它保存 callId 结果、发布 tool.completed、记录 Tool Result Item；若结果包含 changes，则调用 recordChanges；set_plan 更新 Ledger 与 plan.updated；验证命令写入 validation；失败写入 Ledger error。文件已成功修改后，postFileEdit Hook 的失败只记录 Hook 结果，不把已经发生的 ChangeSet伪装成工具失败。

## 23. WorkspacePolicy：文件系统边界

模型给出的路径是不可信输入。WorkspacePolicy 先把 Workspace 转成绝对 root，再用 resolve(root, input) 得到 candidate。relative(root, candidate) 若以 .. 开头或成为绝对路径，说明词法上越界，立即拒绝。

仅做字符串检查仍挡不住符号链接。例如 Workspace 内 link 指向外部目录，读取 link/secret 会在字符串上位于 root 内。path 方法因此对 Workspace 执行 realpath，并使用 canonicalizeFuturePath：从目标向上寻找最近存在祖先，对祖先 realpath，再把尚不存在的子路径拼回。这样既检查已有符号链接，也允许创建新文件。

策略还拒绝敏感路径。.env、.env 的非模板变体、名称中包含 secret、credential、token、apikey、private 的文件，以及 pem、key、p12、pfx、kdbx 和常见 SSH 私钥不会进入 Agent 上下文。.env.example、.env.sample、.env.template 可以读取，因为它们通常不包含真实凭据。

WorkspacePolicy 是每次真实文件工具的前置检查，不是一次性授权。FileEvidence 只优化上下文，不绕过策略。命令 cwd 也必须经过 policy.path。但是命令字符串内部仍可能访问绝对路径，当前主要依赖风险识别与审批，不能等同于 OS 沙箱。

## 24. 文件读取、搜索与目录遍历

list_files 默认深度 2，最大深度 5，最多收集 200 个文件。遍历采用广度优先：先返回请求目录的直属文件，再进入下一层目录，避免某个大型日志目录耗尽额度后把根目录 README 等高价值文件漏掉。结果不是裸数组，而是 `{ entries, count, truncated, limit }`；`truncated=true` 表示列表不完整，Agent 不得据此断言某个文件不存在，应对已知路径调用 read_file，或缩小 path 后重新列举。遍历仍跳过 .git、node_modules、虚拟环境、缓存、构建输出、符号链接和敏感文件。

search_text 优先启动 rg。参数通过数组传入 spawn，不经过 Shell 字符串拼接；使用 -- 把 query 与选项分开，并添加敏感文件排除 glob。命中包含相对路径、行号和最多 300 字符文本。若系统没有 rg，则回退到 Node 遍历，最多扫描 1000 个文件，跳过二进制内容。

read_file 支持 startLine 与 endLine，单次最多 400 行。read_files 一次最多 30 个路径，每个最多 400 行；单个文件失败不会让整个批量读取失败，而在该条目返回 error。模型已经知道多个文件时使用批量读取，可以减少模型往返次数。

这些工具都是只读低风险，但“只读”不代表可以读取任何内容。Workspace 与敏感路径限制始终适用。搜索结果只是定位证据，模型仍应按需读取上下文，不能把搜索片段当成完整源码。

## 25. write_file 与 apply_patch

write_file 用于完整替换或创建文本文件。它先读取 before，写入同目录临时文件，再 rename 到目标。rename 在同一文件系统上通常是原子替换，避免目标只写入一半。成功返回 kind 为 changes 的 output，包含相对路径、before 和 after。发送给模型的 Observation 额外提供 `operation=created|updated|deleted`，使模型能准确区分“新建文件”和“覆盖已有文件”，而不是从字符数自行猜测。

apply_patch 自行解析标准 unified diff，或 SeeCoder 支持的 Begin Patch / Update File 格式。当前 Codex 风格解析只支持 Update File；新增文件可使用 write_file。补丁应用时，系统从 hunk 提取删除与上下文行，先在预期位置匹配；若不匹配，会在限定范围内寻找唯一候选。没有候选或多个候选都失败，防止补丁误贴到相似代码。

多文件补丁先计算所有 after，并准备所有临时文件。提交阶段把原文件 rename 为 backup，再把 temporary 安装为目标。中途失败时按逆序删除已安装目标并恢复 backup。若补偿恢复本身失败，抛出 AggregateError 并保留备份，避免进一步破坏证据。

这是一种轻量文件事务，不是数据库 ACID 事务。它能处理普通进程异常和注入的 rename 故障，但不能保证断电、磁盘故障或外部程序同时修改时绝对一致。Checkpoint 恢复前的哈希冲突检查用于防止后续覆盖外部变化。

## 26. run_command 与本地进程执行

Windows 下 run_command 启动 powershell.exe，参数为 NoProfile、NonInteractive、Command；其他平台使用 sh -lc。cwd 必须在 Workspace 内，环境基于当前进程并加入 CI=1，减少测试命令进入交互模式。当前 Windows 规则提示模型不要使用 && 或 ||，因为实际目标是 Windows PowerShell 5.1。

stdout 与 stderr 使用不同监听器，并通过 tool.output 实时发送给 UI。内存中每个流只保留最后约 1 MiB，单个 chunk 也会截断，防止无限输出耗尽内存。模型上下文中的 Observation 会进一步缩小到关键头尾与诊断。

默认超时为 60 秒，Schema 允许 1 秒到 120 秒。超时时 Windows 使用 taskkill /pid /t /f 终止进程树，其他平台发送 SIGKILL。用户取消时 Windows 同样终止进程树，其他平台发送 SIGTERM，并返回 cancelled。

commandRisk 把删除、格式化、关机、注册表、git reset/clean/push、网络下载和安装依赖识别为高风险；git status/diff/log/show/branch、常见 test/lint/typecheck/build 被识别为低风险；其余为中风险。正则风险识别不是 Shell 语义分析器，复杂转义和间接脚本仍可能绕过，因此未知命令不应在 Auto 中无条件执行。

当前不是原生 PTY，不能可靠运行 Vim、交互式 REPL 或需要持续 stdin 的 TUI。Terminal 面板的命令仍走同一权限与 commandRunner，不是独立全权限控制台。

## 27. Plan、Guided 与 Auto

ExecutionMode 在 Turn 启动时保存到 turnModes，避免用户运行中修改全局设置导致本轮权限突然变化。Plan 模式用于调研和计划，所有 sideEffect 工具在 Core 中硬拒绝。系统 Prompt 也告诉模型只能读取，但真正保证来自 executeCall。

Guided 模式下写文件、补丁和命令默认等待审批。审批卡展示工具、参数、原因和风险。拒绝不会直接令 Turn 失败，而是形成 approval_denied Observation，模型可以提出替代方案或说明无法继续。

Auto 模式允许工作区内 write_file、合法 apply_patch 和策略认可的低风险命令自动执行。网络、安装、删除、提交、推送和未知高风险行为仍需审批。Auto 的含义是减少低风险确认，不是 Full Access。

当前 canAutoApprove 对工具和命令使用启发式规则，没有操作系统令牌隔离。答辩时应表述为“应用层权限策略”。若未来加入真正沙箱，应在 Windows 使用 AppContainer、受限令牌或容器，并把命令、网络、文件系统权限下沉到 OS 层，而不是继续扩充正则。

## 28. ChangeSet、Snapshot 与 Checkpoint

文件工具成功返回 changes 后，recordChanges 创建 ChangeSet，记录 Session、Turn、文件 before、after 和时间。Ledger 增加 revision，Evidence 按路径失效，before 内容写入 SeeCoder 数据目录的 Snapshot。随后发布 changes.created。

系统还自动创建 Checkpoint，记录 ChangeSet ID，以及每个文件修改前后内容的 SHA-256。Checkpoint 不是 Git commit，也不修改项目历史。它是针对 SeeCoder 本轮修改的恢复点。

恢复 Checkpoint 前，系统重新读取每个目标并计算当前哈希。只有当前哈希等于 checkpoint.afterHash，才说明文件仍保持 Agent 修改后的版本。若用户、IDE 或其他进程改过文件，返回 checkpoint_conflict，不覆盖新内容。通过检查后，按 ChangeSet 恢复 before，并使 Evidence 失效、更新 Ledger。

撤销 ChangeSet 同样调用 restoreChangeSet，以事务写入恢复 before。当前 Checkpoint 的 changeSetIds 通常只有自动创建时的一个变更集，手动 checkpoint 可以为空。该机制适合演示和单 Agent 修改，不替代 Git 分支与提交。

## 29. 验证新鲜度与 finish

代码“改完”与“验证通过”是两件事。run_command 只有匹配验证命令模式时才写入 ValidationRecord，记录当时 changeRevision。每次新的 ChangeSet 都提高 revision，因此之前的成功测试自然过期。

finish 是无副作用 Core 工具，参数包含 summary 和 verification 字符串数组。ToolDefinition 只确认数据结构；Core 在 finish 成功后读取 Ledger。如果从未修改文件、当前 revision 只修改 Markdown/纯文本文档，或当前 revision 存在 passed validation，则记录为 verified。只有可执行代码或配置发生变化且没有当前 revision 的成功验证时才在内部 ToolResult 中记录 warning。该字段供质量统计和调试使用，不在普通对话界面显示独立提醒。

SeeCoder 没有强制所有任务必须测试，因为有些请求只是解释代码、修改文档或项目没有测试环境。文档豁免只覆盖 `.md`、`.mdx`、`.txt`、`.rst` 和 `.adoc`；JSON、YAML、脚本和源码仍可能改变运行行为，不能豁免。内部状态必须区分 verified 与 warning，不能把模型在 verification 字段里写的一条命令当成真实执行证据；Renderer 对 finish 工具统一隐藏，避免在完成消息后重复显示验证提醒。

finish 不是唯一完成路径。模型返回正常文本且没有 Tool Call 时，Core 也会结束 Turn。这支持纯问答与 Plan 模式。对于产生代码变更的任务，系统 Prompt 鼓励调用 finish，因为它能进行 revision 检查；当前 Core 尚未硬性要求“有变更必须调用 finish”，这是可进一步强化的规则。

## 30. 循环终止条件

终止设计要回答两个问题：什么时候认为正常完成，什么时候必须停止继续消耗资源。SeeCoder 的正常终止包括模型返回无工具的自然文本，以及 finish 工具成功。异常终止包括用户取消、24 轮上限、连续工具失败、连续输出截断和不可恢复模型或内部错误。

| 条件 | Turn 终态 | 设计原因 |
| --- | --- | --- |
| 无 Tool Call 的正常模型响应 | completed | 纯问答和计划无需强制工具 |
| finish 成功 | completed | 生成完成摘要并检查验证新鲜度 |
| AbortSignal 已触发 | cancelled | 用户意图优先，阻止继续副作用 |
| 循环达到 24 次 | limitReached | 控制成本和无限循环 |
| 连续三次工具失败 | failed | 说明当前策略没有进展 |
| 连续三次 length 且无工具 | failed | 防止无限生成长文本 |
| Provider 返回不可继续错误 | failed | 无法获得下一步决策 |
| 未知内部异常 | failed | 统一收口并保留错误证据 |

第 24 轮结束后若仍未 finished，Core 抛出 iteration_limit 并把状态映射为 limitReached。模型服务自己的 finishReason 不能直接决定 Turn 成功；length 明确进入恢复流程，error 明确失败，tool_calls 必须执行完工具。

终止判断全部在 Core，而不是只写在 Prompt。Prompt 说“最多 24 轮”只帮助模型收敛，for 循环才是硬上限。探索提醒同理：提醒属于软约束，exploration_budget_exhausted 才是硬约束。

## 31. 错误模型：Tool Error 与 Turn Error

工具失败不等于任务失败。编程任务经常通过失败获得信息：测试退出码 1 指出 Bug，搜索无结果说明路径假设错误，补丁冲突说明文件已变化，审批拒绝说明要换方案。如果任何工具失败都结束 Turn，Agent 就没有自主修复能力。

ToolResult.error 包含 code、message 和可选 retryable。常见 code 包括 unknown_tool、invalid_args、plan_read_only、approval_denied、path_denied、read_failed、search_failed、write_failed、patch_failed、command_failed、timeout、cancelled、checkpoint_conflict、hook_blocked 与 subagent_failed。Core 把这些结果加入 Observation，让模型决定下一步。

Turn Error 表示主循环无法可靠继续。AgentRunError 保存 code、message、retryable；模型协议错误、网络重试耗尽、iteration_limit、output_limit 和 cancelled 会映射到它。其他 Error 在 catch 中转为 turn_failed。错误被写入 Ledger，发布 turn.failed，UI 使用稳定 code 和可读 message 构造提示。

当前 code 是字符串而不是封闭枚举，模块间仍可能新增错误码。优点是扩展简单，缺点是编译器不能保证 UI 覆盖所有错误。测试和日志规范承担一致性检查。错误分类不依赖 message 中是否包含“error”，避免中英文和供应商文本变化破坏逻辑。

## 32. 分层错误处理流程

输入边界错误应尽早返回。IPC 检查 sessionId、标题和 URL；ToolDefinition 的 Zod 拒绝非法参数；WorkspacePolicy 拒绝越界路径。这些错误没有执行副作用，通常可以回填给模型或用户。

执行错误必须保留证据。命令非零退出同时保留 exitCode、stdout、stderr；补丁失败返回冲突原因；多文件事务补偿失败保留 backup 并抛出 AggregateError。不能使用 catch 后空处理，因为那会让 Agent 误以为动作成功。

模型层错误由 Provider 判断是否可重试。429 和网关暂时失败自动重试；认证失败、模型不存在和普通 4xx 不盲目重试。重试耗尽才传给 Core。摘要模型错误是例外，因为摘要有确定性回退，不应拖垮主任务。

主循环 catch 负责确定终态，finally 负责资源清理。即使 turnEnd Hook 自身失败，活动 Turn、AbortController、审批和幂等缓存也必须释放。错误事件和用户界面分离：普通用户看到影响与下一步，Main 日志保留 sessionId、turnId、callId、duration、status 和 error code，不记录 API Key 或完整敏感文件。

## 33. 取消传播与资源清理

cancelTurn 首先 abort 本轮 controller，然后遍历 children 中属于该 Turn 的子 Agent 并 abort。等待审批的 Promise 以“用户取消了任务”解决，等待 ask_user 的 Promise 也被解决。这样取消不会因为一个永远没人点击的 Promise 卡住。

模型 Provider 的 fetch 使用同一 signal；重试 sleep 注册 abort；工具 ToolContext 携带 signal；commandRunner 在取消时终止进程树；summaryController 监听父 signal；子 Agent controller 也监听父 signal。取消是一条传播链，而不是一个 UI 标志。

runTurn 在流结束后、每个 Tool Result 后再次检查 signal，防止取消与网络分片同时到达时继续执行下一个工具。catch 将 signal.aborted 优先映射为 cancelled，而不是把 AbortError显示成 failed。

finally 删除 controllers、turnModes、turnSkills、turnLanguages、executedCalls，并解决属于本 Turn 的遗留审批。activeSessionTurns 在完成、失败与 finally 都进行幂等删除，保证异常路径也不会让 Session 永久处于运行中。

cancelAll 用于切换 Workspace 或关闭窗口。它中止所有主 Turn 和子 Agent，拒绝所有审批与输入。这样旧 Workspace 不会在用户切到新项目后继续写文件。

## 34. 并发策略与幂等

主 Agent 是唯一写入者，模型一次返回多个工具时按顺序执行。相同 Session 禁止并发 Turn。这个策略避免两个写入同时读取同一个 before，再互相覆盖 after。对于桌面 Demo，确定性比最大吞吐更重要。

子 Agent 最多两个并发，但只获得 list_files、read_file、search_text 和 git_diff。它们各自持有独立 ModelMessage 数组与最多 6 轮循环，不继承主 Session 全部历史，只接收角色系统提示和明确任务。返回主 Agent的是 summary 与最多 20 条 evidence，而不是全部工具日志。

executedCalls 是 Map<turnId, Map<callId, ToolResult>>。模型或 UI 重复触发相同 callId 时，直接返回首次结果。这解决单个 Turn 内的副作用幂等。历史恢复不重放工具，因此跨重启采用“绝不自动重试副作用”而不是永久幂等表。

并发子 Agent 的 inputTokens、outputTokens、iteration、duration 和 currentAction 通过 subagent.updated 展示。父 Turn取消时所有子任务取消。子 Agent 禁止 delegate，因此委派深度固定为一，避免递归树失控。

## 35. Explore 与 Review 子 Agent

Explore 适合定位入口、依赖和相关测试；Review 适合检查 Diff、测试缺口和潜在缺陷。角色区别主要来自任务 Prompt，安全区别来自同一只读工具白名单。Prompt 不是安全边界，即使子模型请求 write_file，Core 因未提供该工具且检查 sideEffect，会返回 subagent_tool_denied。

子 Agent 每轮也解析文本与 Tool Call，先保存自己的 Assistant 消息，再执行只读工具并加入 tool 消息。它的消息当前只存在内存，完整状态通过 subagent.updated 摘要进入主 Session 事件；不像主 Agent 那样拥有独立持久化 JSONL 文件。这一点与最初“完整子轨迹单独保存”的规划有差距，文档按现状说明。

review_changes 先发布 review.started，再运行 Review 子 Agent。当前 ReviewFinding 主要把子 Agent summary 包装成一个 finding，严重度细分与逐行结构化解析能力有限。它展示了审查闭环，但不能声称已达到成熟静态分析器的精度。

采用只读、不可嵌套策略的理由是：多 Agent 的主要价值是隔离大规模探索上下文，不是制造更多写入者。单写者减少冲突，也使 ChangeSet 与验证 revision 容易解释。

## 36. Skill、AGENTS.md 与 Hook 的区别

AGENTS.md 是 Workspace 根目录的长期项目规则，systemPrompt 每轮读取根文件并限制到 20000 字符。当前实现不会按子目录自动发现嵌套 AGENTS.md，因此只能声称“加载根规则”。规则被标记为低于系统安全规则，文件内容被视为不可信数据。

Skill 是用户导入并在本轮激活的 SKILL.md。它提供特定领域知识或操作流程，最多注入 20000 字符。Skill 影响模型决策，但不能新增工具，也不能绕过 ExecutionMode、WorkspacePolicy 或审批。

Hook 是确定性生命周期命令。preToolUse 在工具前运行，可阻止操作；postFileEdit 在文件修改后运行；turnEnd 在终态发布前运行。Hook 配置用 Zod 校验版本、id、命令、数量和超时。项目 Hook 首次启用需要由 Main 确认配置哈希。

三者解决不同问题：AGENTS.md 告诉模型项目长期约定；Skill 告诉模型本次如何完成某类任务；Hook 在确定时机执行程序。必须保证的规则应放在 Core、Policy 或 Hook，而不能只写在 Skill。

## 37. 事件持久化与 JSONL

JSONL 是“一行一个 JSON 对象”的追加文件。它适合事件轨迹，因为每次只需 append，不必重写整个历史；最后一行损坏时，之前记录仍可读取；开发者可以直接检查。

SessionStore 为每个 Session 保存独立 append Promise 队列。同一 Session 的下一次写入等待上一次完成，生成递增 seq，再追加 events.jsonl。不同 Session 可以独立写入。readEvents 逐行 JSON.parse，损坏行被跳过，合法行继续；然后按 seq 排序，并更新内存中的最高序号。

meta.json 与 state.json 使用临时文件加 rename，避免部分写入。Snapshot 按 sessionId、changeSetId 和转义后的路径保存。API Key 不存入这里；Main 使用 Electron safeStorage 加密模型凭据，并在激活配置时把解密值放入主进程环境，Provider只从指定环境变量读取。

JSONL 没有数据库事务、索引和查询语言。Session 数量与事件规模较小时简单可靠；规模很大时，全文搜索与启动回放会变慢。考核 Demo 不引入 SQLite，是为了避免原生依赖和迁移复杂度。后续若需要数万 Session，可保持 Event 协议不变，把 Store 实现替换为数据库。

## 38. 事件回放与异常恢复

replaySessionEvents 先检查输入原始 seq 是否回退，再稳定排序。seenSeq 森别重复序号；eventSessionId 与目标不同则记录 cross_session_event 并跳过；Turn 的 started 与终态用于找 unfinishedTurns；Assistant Tool Calls 建立合法 callId 集；孤立 tool_result 被诊断并跳过。

遇到 Compaction Item 时，模型 Items 被替换为该压缩点，之前历史仍在 records 中。ChangeSet 和 Checkpoint 以 id 去重恢复。回放结果是 records、modelItems、changeSets、checkpoints、unfinishedTurns 和 diagnostics。

hydrateSession 对 unfinished Turn 创建 failed 终态，code 为 interrupted，message 说明应用在结束前退出、后台执行已停止。它不会试图恢复正在等待的 Promise、网络流或子进程，因为这些资源跨进程不存在。

恢复过程还重新生成 Tool Observation。Assistant Item 恢复 Tool Calls 并记住 callId 到 toolName；tool_result 根据 toolName 使用 serializeObservation。这样恢复后的模型上下文与正常运行遵循同一压缩策略。

## 39. 可观测性

一次任务至少可关联 sessionId、turnId、Tool Call ID、事件 timestamp、duration、status 和 error code。model.requested 到 model.completed 给出模型耗时、usage、重试和 finish reason；tool.requested 到 tool.completed 给出工具耗时与结果；tool.output 提供实时 stdout/stderr；context.compacted 记录 beforeTokens、afterTokens、availableInput、summarySource、retrievedEntries 与 droppedEvidence。

事件用于 UI 状态和 Session 恢复，MainLogger 用于开发诊断。日志只记录事件类型、标识、耗时与错误码，不记录 API Key 和完整文件正文。普通用户默认看到“读取了几个文件、修改了几个文件、测试是否通过”，需要时在 Terminal 或工具 Details 展开必要信息；原始事件不提供独立查看页面。

可观测性不是把所有数据打印出来。模型请求正文可能包含源码和用户隐私，工具输出可能包含凭据。SeeCoder 优先记录可关联元数据，并对正文执行敏感路径限制与长度控制。

## 40. 一条真实任务如何穿过全部模块

假设用户在 Guided 模式输入：“修复空标题仍可提交的问题，并补充测试。”startTurn 创建 Turn，记录中文输出偏好，把原文写入 ModelMessage、Item 与 Ledger goal。第一轮 ContextBuilder 发送系统规则、工具 Schema、Ledger 和用户消息。

模型请求 search_text。Provider 从 SSE 聚合 Tool Call，Core 先保存 Assistant Tool Calls。search_text 通过 Zod、WorkspacePolicy 和 rg 返回命中；完整 ToolResult 写入事件，压缩 Observation 加入消息。

第二轮请求 read_files。工具批量读取实现与测试，EvidenceStore 记录哈希。第三轮模型请求 apply_patch。Guided 模式判断它有副作用，Turn 进入 waitingApproval；用户允许后执行补丁事务。成功产生 ChangeSet、Snapshot 和 Checkpoint，Ledger revision 从 0 变成 1，旧 Evidence 失效。

第四轮模型请求 run_command。审批后执行测试，退出码 1。ToolResult.ok 为 false，stderr 尾部与诊断进入 Observation，Ledger 记录 command_failed。主 Turn 不终止。模型第五轮根据错误修改测试或实现，新 ChangeSet 让 revision 变为 2。

第六轮测试通过，ValidationRecord 保存 revision 2 与 passed。模型调用 finish，Core 检查当前 revision 有新鲜验证，输出 verified。runTurn 执行 turnEnd Hook，释放 activeSessionTurns 和所有临时资源，再发布 turn.completed。用户之后追问会在同一 Session 创建新 Turn，并从 Ledger、历史与检索中继承必要事实。

## 41. 一个失败任务如何恢复

假设模型读取文件后生成了上下文不匹配的补丁。apply_patch 在应用前发现旧行不匹配，返回 patch_failed，没有文件被部分修改。Observation 保留错误原因。下一轮模型可以重新 read_file 获得当前内容，再生成更小补丁。

如果模型又请求安装依赖，Auto 模式的风险识别会要求审批。用户拒绝后返回 approval_denied，模型可以选择使用已有依赖。若之后测试超时，commandRunner 终止进程树并返回 timeout。所有这些都是 Tool Error，只要模型仍能选择替代步骤，Turn 继续。

若模型连续三次只产生失败工具，没有任何成功观察，Core 判定无进展并结束为 failed。若用户在命令运行时取消，AbortSignal 终止命令树与模型，Turn 为 cancelled。若应用直接退出，重启回放将未完成 Turn 标记为 interrupted。

这条路径说明错误处理不是 try/catch 后显示一条红字，而是把可恢复失败变成下一轮 Observation，把不可恢复失败变成唯一终态，并确保每种路径都清理资源。

## 42. 为什么没有采用现成 Agent SDK

考核明确要求历史、上下文、工具执行、解析、终止和错误处理自行实现。采用 Agent SDK 会直接隐藏主循环、工具配对、压缩和恢复逻辑，无法证明对关键机制负责。因此 SeeCoder 只使用 fetch、Node.js 标准能力、Zod 与 Electron，不把编排交给框架。

自行实现的代价是要处理 SSE 分片、Tool Call 参数拼接、协议组裁剪、重试和取消等大量边界。好处是每条机制可在源码中定位，可用 FakeModelProvider 确定性测试，也能针对本地文件安全和 UI 事件流做定制。

公开产品只用于设计参照。Codex App Server 的公开文档展示了对话、Turn、Item、事件和审批的分层；Claude Code 的公开文档强调 Agent Loop、上下文压缩、子 Agent 隔离与 Hook 生命周期；TRAE Agent 公开仓库强调工具生态和轨迹记录。SeeCoder 没有复制它们的代码，也没有把这些产品当后端。

## 43. 为什么采用事件流而不是让 Renderer读取 Core

Renderer 如果直接读取 Core 内部 Map，就必须理解所有状态转移，也容易在页面刷新或多 Session 切换时拿到过期引用。事件流把后台发生的事实变成稳定协议：Core 发布，Main 路由，Renderer 归并展示。

事件信封显式携带 sessionId，使 UI 能丢弃不属于当前 Session 的事件；turnId 区分同一 Session 的多次执行；seq 用于重放顺序；event id 用于诊断重复。Renderer 的 Zustand 只保存视图状态，不复制工具权限和 Agent 状态机。

缺点是 UI 需要正确处理乱序、恢复和未知事件。V3 协议通过显式版本和稳定 type 降低风险，Renderer 对新增字段应安全忽略。业务真相仍在 Main/Core 与 Storage，不以页面当前显示为准。

## 44. 当前实现的已知限制

SeeCoder 的主要限制需要明确说明。第一，没有 OS 级沙箱，命令可在当前用户权限下运行。第二，主模型请求没有独立总超时，兼容网关长时间不返回时主要依赖用户取消。第三，SSE 畸形行会被忽略，没有协议损坏阈值。第四，JSON Schema 与 Zod 分两处维护，存在漂移风险。

第五，根 AGENTS.md 会加载，但嵌套规则不会按路径加载。第六，Review Finding 的结构化程度有限。第七，子 Agent 完整消息轨迹未单独持久化。第八，ContextLedger 中 acceptanceCriteria、constraints、decisions 的自动维护不完整。第九，finish 不是代码变更后的强制唯一路径，只是推荐路径。第十，命令风险判断基于正则，不是 Shell AST 或操作系统权限隔离。

这些限制不否定当前架构。核心协议、执行与恢复链路已闭环，限制主要位于更强安全、精确检索和产品成熟度。答辩时应说明“为什么首版选择应用层边界、哪些能力已经用测试证明、下一步怎样增强”，而不是把限制隐藏起来。

## 45. 测试如何证明核心逻辑

Agent Core 单元测试使用 FakeModelProvider 预设 ModelEvent 序列，验证多轮工具循环、审批、拒绝、取消、迭代上限、Tool Call 配对、压缩、摘要回退、Evidence 失效和 validation revision。Fake Provider 的 context_summary 序列与 agent 序列分开，避免压缩改变主测试脚本游标。

Model 测试把 SSE 拆成任意片段，检查文本和 arguments 重组；覆盖 usage、finish reason、HTTP 重试和消息序列化。Tools 测试在临时目录中验证 ..、符号链接、敏感文件、补丁冲突、多文件回滚、命令超时和取消。Storage 测试覆盖损坏 JSONL 尾行、事件排序、孤立 Tool Result、重复终态与未完成 Turn。

集成测试应构造“读取 → 修改 → 测试失败 → 再修改 → 测试通过 → finish”的完整链路，并检查每一步 Event、Item、Ledger 和文件状态一致。E2E 再通过 Electron 点击发送、审批、取消、恢复和查看 Diff，证明 UI 与 Core 状态一致。

真实 DeepSeek 测试用于发现兼容 API、语言、长流程和模型行为问题，但它有随机性，不能替代确定性测试。正确质量策略是：底层不变量用 Fake 与临时目录自动验证，真实模型用自然 Prompt 做系统评估。

## 46. 源码阅读顺序

第一次阅读建议从 packages/protocol/src/index.ts 理解数据结构，再看 packages/agent-core/src/index.ts 的 startTurn、runTurn、executeCall。掌握控制流后看 packages/agent-core/src/context.ts 的 Ledger、Evidence、Observation、MemoryIndex 与 buildHybridContext。随后看 packages/model/src/index.ts 的 SSE 解析、packages/tools/src/index.ts 的执行边界、packages/storage/src/index.ts 的回放。

不要先从 React 页面理解 Agent，因为 UI 只消费事件。也不要先钻进补丁解析器，否则会看到大量局部细节却不知道它在主循环中的位置。

~~~text
推荐调用链

Renderer send
  → preload IPC
  → Main session/turn handler
  → AgentCore.startTurn
  → AgentCore.runTurn
  → buildHybridContext
  → ModelProvider.stream
  → AgentCore.executeCall
  → ToolDefinition.execute
  → SessionStore.append
  → AgentEvent 回到 Renderer
~~~

## 47. 答辩时如何解释主循环

可以先用一句话说明：“模型只决定下一步，Agent Core 负责反复调用模型、受控执行工具并把结果反馈回去。”随后按一次真实任务讲 startTurn、ContextBuilder、SSE、Tool Call、executeCall、Observation 和 finish，不需要背全部类名。

评委问“为什么模型不能自己循环”，回答是 API 的一次调用会结束，模型没有本地权限，也不会自动保存历史；循环必须由应用控制。问“怎样防止无限循环”，回答 24 轮上限、连续失败、输出截断、探索预算和取消。问“怎样保证工具结果对应”，回答 callId 配对、Assistant 先持久化、消息组裁剪和事件回放诊断。

问“上下文满了怎么办”，回答原始 JSONL 保留，模型视图使用 Ledger、Evidence、Observation、检索、语义摘要和最近协议组的混合压缩；75% 触发，60% 目标，摘要失败确定性回退。问“测试通过后又改代码怎么办”，回答每次变更增加 revision，验证绑定 revision，finish 只接受当前 revision。

问“安全吗”，回答 Renderer 无 Node 权限，文件经过 WorkspacePolicy 和敏感路径过滤，副作用经过模式与审批，命令有超时和取消；但首版没有操作系统沙箱，因此不能声称完全隔离。能准确描述边界本身就是设计可信度的一部分。

## 48. 设计依据与项目差异

SeeCoder 的文档组织借鉴公开一手资料的表达方式：先定义核心实体，再描述生命周期、事件、审批和错误，最后给真实执行链。OpenAI Codex App Server 公开文档采用会话层、Turn 层、Item 层与流式通知的分层方式；SeeCoder 在项目内统一使用 Session 名称，但保留“长期对话包含多个 Turn、Turn 包含多种 Item”的思想。

Claude Code 公开文档把 Agent Loop 解释为模型响应、工具执行与结果反馈的多轮过程，并强调 max turns、独立子 Agent Context、Compaction 与 Hook。SeeCoder 自己实现相应机制，但具体数据结构、预算、权限和存储均以本项目源码为准。TRAE Agent 公开仓库强调可修改的模块化工具与 trajectory recording；SeeCoder 使用 V3 事件和 JSONL实现本地轨迹。

参考资料：

- OpenAI Codex App Server：https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- Claude Code Agent Loop：https://code.claude.com/docs/en/agent-sdk/agent-loop
- Claude Code Context Window：https://code.claude.com/docs/en/context-window
- Claude Code 扩展机制：https://code.claude.com/docs/en/features-overview
- TRAE Agent：https://github.com/bytedance/trae-agent

这些资料用于对照架构问题，不是 SeeCoder 的运行依赖。SeeCoder 未封装 Codex、Claude Code 或 TRAE，也没有使用其 Agent SDK。

## 49. 最终结论

SeeCoder 的核心不是一次能生成代码的模型请求，而是一套自行实现的 Harness。对话历史通过 Session、Item、Event 与 JSONL 持久化；模型上下文通过 Ledger、Evidence、Observation、检索、语义摘要和协议组进行预算分配；模型输出通过 SSE 缓冲与 callId 聚合解析；工具通过 Schema、Zod、WorkspacePolicy、权限、审批、Hook 和 AbortSignal 在本地执行；主循环通过完成、取消、迭代上限、无进展、输出截断与错误分类停止。

这些机制共同回答了考核的核心要求：历史不是简单数组，工具不是让模型直接运行 Shell，解析不是对半段 JSON 立即执行，终止不是只相信模型说“完成”，错误也不是 catch 后统一显示失败。模型可以不稳定，但系统边界必须稳定；这正是 Coding Agent 工程设计与普通聊天应用的区别。
