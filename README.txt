SeeCoder - 可视化本地编程智能体

Git 仓库
https://github.com/shenhaideyu/SeeCoder

运行
环境：Windows 10/11、Node.js 22.12+、pnpm 10。

git clone https://github.com/shenhaideyu/SeeCoder.git
cd SeeCoder
pnpm install
pnpm dev

启动后在设置页添加 OpenAI 兼容模型，或通过 SEECODER_API_KEY 提供凭据。

核心特色

1. 自研执行闭环
SeeCoder 自行实现模型流解析、Tool Call 聚合、工具调度、循环、终止和错误处理。Agent Core 先保存 Tool Calls，再校验参数、权限与路径，执行工具并回填结果。纯文本、finish、取消、失败和 24 轮上限均有明确终态，未使用 Agent 框架。

2. 混合上下文管理
JSONL 保留原始事件，ContextLedger 维护目标、计划、代码 revision、验证和错误。FileEvidence 按哈希复用代码证据；工具输出按类型压缩；历史按路径、关键词和错误码召回。达到预算阈值后总结早期对话，失败时确定性回退。

3. 受控本地执行
Renderer 无 Node.js 权限，本地请求经 IPC 进入 Electron Main。WorkspacePolicy 限制路径并过滤凭据。Plan 只读，Guided 逐次审批，Auto 执行允许的工作区操作。修改生成 ChangeSet 和 Checkpoint，可查看或恢复；模型、命令和子 Agent 均可取消。

4. 可观察与可恢复
界面统一展示 Session、计划、审批、Diff、终端和 Trace。验证结果绑定代码 revision，修改后旧测试自动过期。Explore 与 Review 子 Agent 只读，主 Agent 是唯一写入者。应用重启后通过事件回放恢复历史、计划、变更和终态，不重放历史副作用。

说明
API Key 使用操作系统安全存储加密，不进入仓库、Session 事件或日志。当前安全机制属于应用层策略隔离，不宣称操作系统级沙箱。
