SeeCoder - 可视化本地编程智能体

SeeCoder 是面向 Windows 的桌面编程智能体。用户用自然语言描述任务后，它可以在指定项目中搜索和读取代码、修改文件、执行命令、运行测试，并清楚展示计划、操作过程、代码差异和验证结果。

核心特色

1. 自研 Agent 执行引擎
Agent Core 以 Turn 为单位运行闭环：构建当前上下文，流式调用模型，按 callId 还原文本和 Tool Call，校验工具名称、参数、权限与路径，执行本地操作，再把结构化结果交给模型重新规划。无工具调用或 finish 成功时结束；输出截断、连续失败、取消和 24 轮上限均有独立处理。整个循环、SSE 解析和 Tool Calling 协议均自行实现，未依赖 Agent 框架。

2. 长任务上下文与记忆
JSONL 保存完整原始事件，ContextLedger 单独维护目标、约束、计划、变更版本、验证和错误。读取的代码按文件哈希保存为 FileEvidence，重复读取可复用证据，文件修改后自动失效。上下文接近预算时，系统保留安全规则、当前任务和完整工具消息组，压缩工具输出，用当前模型总结较早对话，并通过路径、关键词和错误码召回相关历史；摘要失败时使用确定性回退，原始记录不会删除。

3. 安全、可回滚的本地执行
Renderer 没有 Node.js 权限，所有文件和命令操作经 Preload 类型化 IPC 进入 Electron Main。WorkspacePolicy 同时检查规范路径和符号链接真实路径，并过滤凭据、Token 与私钥。Plan 只读，Guided 逐次审批，Auto 仅放行工作区内低风险操作。文件采用临时文件原子替换，多文件补丁先验证全部旧内容，失败时恢复备份；每次修改生成 ChangeSet 和 Checkpoint。AbortSignal 可中断模型、审批、子 Agent 和命令进程树。

4. 可观察、可验证、可恢复
Session、Turn、消息、工具调用和变更统一通过事件驱动，界面实时展示计划、审批、Diff、终端与 Trace。测试结果绑定代码 revision，再次修改后旧验证会标记过期，避免用旧测试证明新代码。Explore 与 Review 子 Agent 使用独立上下文且只能读取，主 Agent 保持唯一写入者。应用重启后通过事件回放恢复历史、计划、ChangeSet 和 Checkpoint；未结束任务标记为中断，不会重新执行历史副作用。

Git 仓库
https://github.com/shenhaideyu/SeeCoder

运行

环境：Windows 10/11、Node.js 22.12+、pnpm 10。

git clone https://github.com/shenhaideyu/SeeCoder.git
cd SeeCoder
pnpm install
pnpm dev

启动后在设置页添加 OpenAI 兼容模型与凭据，或预先设置 SEECODER_API_KEY。凭据不会写入仓库和执行轨迹。
