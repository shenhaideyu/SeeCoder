# SeeCoder Constitution

Version: 1.1.0 | Ratified: 2026-08-27

本次修订原因：SeeCoder 2.0 在不突破考核安全边界的前提下，增加 Plan 模式、Checkpoint、Git Review、交互终端、本地 Skills/Hooks、只读计划任务和 Codex 风格多任务工作区。

## I. 核心逻辑自研

Agent 循环、上下文、模型输出解析、工具协议、执行调度、错误处理和终止条件 MUST 由 SeeCoder 自己实现。允许使用模型厂商 API 客户端或原生 HTTP 接口，但 MUST NOT 引入 Agent 框架或服务端托管的文件/代码执行工具。

## II. 分层与可替换性

Agent Core MUST 与 Electron UI、模型 Provider、工具运行时和持久化解耦。每个公共边界 MUST 有 TypeScript 类型；模型和工具必须可由 fake 实现替换以支持测试。

## III. 安全默认值

Renderer MUST 无 Node 集成并通过类型化 IPC 工作。所有路径 MUST 经过 workspace 规范化检查。写文件、命令和网络动作 MUST 受到权限策略和审计事件约束。密钥 MUST NOT 持久化。

## IV. 可验证性与审计

每个 Turn MUST 产生可恢复的追加式事件轨迹，记录用户可见消息、工具请求/结果、审批、修改集、测试证据和错误；MUST NOT 保存私有思维链。核心模块行覆盖率目标不低于 80%。

## V. 用户体验一致性

所有状态必须有可见反馈：运行中、等待审批、成功、失败、取消和达到限制。UI 使用 SeeCoder 品牌紫 `#4D0099`，浅色 Codex 风格为默认并提供深色主题，关键操作满足 WCAG AA。所有可见按钮必须绑定真实动作、页面或明确的未配置说明。

## VI. 简单优先

实现优先选择模块化单体和少量依赖。没有可测试收益的复杂抽象、远程执行、远程插件市场、Worktree 并行写入和多写者并发不实现；本地 Skills/Hooks、只读计划任务和可选 `gh` 读取属于受控扩展。

## VII. 事件协议稳定性

所有跨进程事件 MUST 使用 V3 Session Envelope，携带版本、唯一 ID、单会话序号和明确的 `sessionId`；不得依赖从嵌套 payload 推导路由。

## 治理

constitution 是所有实现计划和评审的强制门禁。变更原则必须更新版本号、说明理由并同步更新规格、计划和测试追踪矩阵。任何未通过的安全或测试门禁都不得标记完成。
