<div align="center">

# SeeCoder

**可视化、本地优先、执行可控的编程智能体**

用自然语言驱动代码检索、修改、测试与审查，并让计划、权限、Diff、终端和执行证据始终可见。

![Windows](https://img.shields.io/badge/Windows-10%20%2F%2011-4D0099?style=flat-square)
![Electron](https://img.shields.io/badge/Electron-38-4D0099?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-4D0099?style=flat-square)
![Agent Core](https://img.shields.io/badge/Agent%20Core-Self--built-6418B8?style=flat-square)

[快速开始](#快速开始) · [核心能力](#核心能力) · [核心机制图](#核心机制图) · [源码地图](#源码地图) · [技术文档](docs/README.md)

</div>

SeeCoder 是面向 Windows 的 Electron 桌面 Coding Agent。用户选择本地项目并描述目标后，SeeCoder 可以理解代码、制定计划、调用受控工具修改文件、运行测试，并根据结果继续修正。项目没有封装现有 Agent，也没有使用 Agent SDK；主循环、上下文、模型流解析、工具调度、终止、错误处理和恢复均由项目自行实现。

> SeeCoder 是本地模块化单体：React Renderer 是前端，Electron Main 是可信本地后端。项目不需要额外启动 HTTP 服务、数据库、Redis 或消息队列。

## 核心能力

### 自研 Agent 执行闭环

模型输出首先被解析成文本增量和结构化 Tool Call，不会直接成为本地操作。Agent Core 按 `callId` 聚合流式参数，保存完整的 Assistant Tool Calls，再校验工具名称、Zod 参数、执行模式、审批和工作区路径。工具完成后，结构化 Tool Result 会压缩成 Observation 返回模型，模型据此继续规划。纯文本完成、`finish`、用户取消、连续失败、输出截断和 24 轮上限都有明确终态。

### 面向长任务的混合上下文

Session 的原始事件追加保存在 JSONL 中，模型每轮只接收 ContextBuilder 生成的有限视图。ContextLedger 维护目标、计划、代码 revision、文件、验证和错误；FileEvidence 通过文件哈希复用有效代码证据；不同工具使用专用 Observation 压缩器；MemoryIndex 根据路径、关键词、中文二元组、错误码、状态和时间召回相关历史。输入达到可用预算的 75% 时，系统尝试用当前模型总结早期对话并压缩到 60% 以下；摘要失败则使用确定性回退，原始历史不会被删除。

### 受控且可回滚的本地执行

Renderer 关闭 Node.js 权限，本地请求只能通过 Preload 暴露的固定 IPC 接口进入 Electron Main。WorkspacePolicy 同时检查规范路径和符号链接真实路径，并过滤凭据、Token 与私钥。Plan 模式只读，Guided 模式逐次审批写入和命令，Auto 模式自动执行工作区内允许的操作。文件修改会产生 ChangeSet、Snapshot 和 Checkpoint；恢复前检查内容哈希，避免覆盖用户后续编辑。`AbortSignal` 贯穿模型请求、审批、子 Agent 和命令进程。

### 可观察、可验证、可恢复

Session、Turn、模型请求、工具调用、审批、变更和终态通过统一 AgentEvent 驱动。界面将事件投影为对话、计划、Diff、终端和 Trace，而不自行猜测后台状态。验证结果与代码 revision 绑定，文件再次修改后旧测试会显示为过期。应用重启时通过事件回放恢复已发生的事实，未结束的 Turn 会标记为中断，不会重放历史副作用。Explore 与 Review 子 Agent 使用独立只读上下文，主 Agent 保持唯一写入者。

## 快速开始

环境要求：Windows 10/11、Node.js 22.12 或更高版本、pnpm 10。

```powershell
git clone https://github.com/shenhaideyu/SeeCoder.git
cd SeeCoder
pnpm install
pnpm dev
```

启动后进入“设置 → 模型管理”，添加 OpenAI 兼容 Base URL、模型 ID 和 API Key。API Key 使用 Electron `safeStorage` 调用操作系统安全存储加密，也可以通过 `SEECODER_API_KEY` 环境变量提供；明文不会进入仓库、Session 事件或后台日志。

<details>
<summary>Electron 下载出现 ECONNRESET</summary>

在网络受限环境中，可以为本次 PowerShell 会话设置镜像后重新安装：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
pnpm install
pnpm dev
```

</details>

## 核心机制图

下面九张图从产品使用逐步进入核心机制。每张图只回答一个问题，点击图片可查看完整尺寸。

### 01 · 初识 SeeCoder

[![SeeCoder 产品工作台总览](docs/assets/seecoder-overview.svg)](docs/assets/seecoder-overview.svg)

用户在 Workspace 和 Session 中描述目标。AgentCore 协调模型与本地工具，界面持续展示执行过程和结果证据。

### 02 · 一次任务怎样完成

[![SeeCoder 单次任务 UML 时序图](docs/assets/seecoder-task-sequence.svg)](docs/assets/seecoder-task-sequence.svg)

用户提交目标后，AgentCore 构建上下文并调用模型。模型提出 Tool Call，本地工具执行并返回 Observation，系统据此继续处理或验证完成。

### 03 · 系统架构与信任边界

[![SeeCoder 系统组件架构](docs/assets/seecoder-system-architecture.svg)](docs/assets/seecoder-system-architecture.svg)

Renderer 负责界面，Preload 提供受限通信入口，Electron Main 负责可信执行。AgentCore 在主进程内协调 ModelProvider、ToolRuntime 和 SessionStore，模型不能直接操作本地系统。

### 04 · Session 与对话历史

[![SeeCoder Session 与对话历史](docs/assets/seecoder-session-history.svg)](docs/assets/seecoder-session-history.svg)

Workspace 表示本地项目，Session 保存连续对话，Turn 表示一次用户请求。执行事实以 AgentEvent 写入 SessionStore，应用重启后可以恢复历史和状态，但不会重复执行旧操作。

### 05 · 上下文管理与压缩

[![SeeCoder 混合上下文管理与压缩](docs/assets/seecoder-context-management.svg)](docs/assets/seecoder-context-management.svg)

ContextBuilder 从 ContextLedger、代码 Evidence 和最近历史中构建本轮工作视图。内容过长时使用语义摘要和历史检索减少重复信息，完整 Session 历史仍然保留。

### 06 · Agent 主循环

[![SeeCoder Agent 主循环](docs/assets/seecoder-agent-loop.svg)](docs/assets/seecoder-agent-loop.svg)

AgentCore 重复执行“构建上下文、调用模型、解析输出、执行工具、反馈结果”。每轮都会检查完成、取消、错误和迭代上限，只有满足明确条件才结束。

### 07 · 模型输出解析

[![SeeCoder 模型流输出解析](docs/assets/seecoder-model-parser.svg)](docs/assets/seecoder-model-parser.svg)

ModelProvider 将模型流解析为文本和 Tool Call。AgentCore 聚合并校验完整参数，未接收完整的工具调用不会进入本地执行。

### 08 · 工具与本地执行

[![SeeCoder 工具定义与本地执行](docs/assets/seecoder-tool-execution.svg)](docs/assets/seecoder-tool-execution.svg)

Tool Call 依次经过参数校验、权限模式、用户审批和工作区边界检查，再由 ToolRuntime 执行。完整 ToolResult 用于记录，紧凑 Observation 返回模型，文件修改形成可检查的 ChangeSet。

### 09 · 终止条件与错误处理

[![SeeCoder 终止条件与错误处理](docs/assets/seecoder-termination-errors.svg)](docs/assets/seecoder-termination-errors.svg)

可恢复错误会作为结构化结果返回模型，使其调整方案。任务完成、不可恢复错误、用户取消或达到迭代上限时，AgentCore 清理运行资源并记录唯一终态。

## 执行模式

| 模式 | 适用场景 | 文件写入与命令 |
| --- | --- | --- |
| Plan | 理解项目、讨论方案 | 只允许读取、搜索、Diff、计划和只读子 Agent |
| Guided | 第一次使用或高风险项目 | 写入、补丁和命令按策略请求用户批准 |
| Auto | 熟悉项目后的连续实现 | 工作区内允许的操作自动执行，高风险动作仍受限 |

## 工程边界

| 项目 | 当前实现 |
| --- | --- |
| 安全隔离 | IPC、路径策略、敏感文件过滤、审批和审计；不是操作系统级沙箱 |
| 本地终端 | 受控非交互式子进程；不支持 Vim 等完整 TUI |
| 历史检索 | 本地词法、中文二元组、路径和时间评分；没有向量数据库 |
| 持久化 | `%APPDATA%/SeeCoder` 下的 JSON、JSONL 和文件快照；没有数据库 |
| 任务恢复 | 恢复历史、计划、变更和终态；不会自动续跑重启前的进程 |
| 主要平台 | Windows 10/11 x64；保留 Electron 跨平台能力但未承诺完整验证 |

## 质量验证

```powershell
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:eval:unit
pnpm test:e2e
pnpm build
```

测试覆盖模型 SSE 与 Tool Call 聚合、Agent 状态转换、取消、审批、重复调用保护、混合上下文、JSONL 恢复、路径越界、补丁回滚、ChangeSet、Checkpoint、终端结果和 Electron 核心交互流程。

## 源码地图

| 模块 | 职责 |
| --- | --- |
| [`packages/protocol`](packages/protocol/src/index.ts) | Session、Turn、Item、AgentEvent、模型和工具共享协议 |
| [`packages/agent-core`](packages/agent-core/src/index.ts) | Agent 状态机、主循环、审批、子 Agent 与终止 |
| [`packages/agent-core/context.ts`](packages/agent-core/src/context.ts) | Ledger、Evidence、Observation、Memory 与上下文预算 |
| [`packages/model`](packages/model/src/index.ts) | OpenAI 兼容 HTTP、SSE、Tool Call 聚合和重试 |
| [`packages/tools`](packages/tools/src/index.ts) | 文件、搜索、补丁、命令、Git 和 WorkspacePolicy |
| [`packages/storage`](packages/storage/src/index.ts) | Session 元数据、JSONL、状态、快照和回放 |
| [`apps/desktop`](apps/desktop/src) | Electron Main、Preload 安全桥和 React Renderer |

进一步阅读：[技术文档导航](docs/README.md) · [系统设计与架构](docs/02-软件系统设计与架构.md) · [Agent 核心详细设计](docs/03-Agent核心详细设计.md) · [安全与威胁模型](docs/06-安全与威胁模型.md)
