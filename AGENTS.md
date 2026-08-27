# SeeCoder 实现约束

## 不可违反的规则

- 核心 Agent 循环、历史、上下文、工具执行、解析、终止和错误处理必须自行实现。
- 禁止 LangChain、LlamaIndex、OpenAI Agents SDK、Claude Agent SDK、AutoGen、CrewAI 等 Agent 框架。
- API Key 只来自环境变量或当前进程内存，不得写入仓库、日志或文档。
- Renderer 不得使用 Node.js 权限；所有本地能力必须通过 preload 的类型化 IPC。
- 文件工具不得越出当前 workspace；写入必须可回滚。
- 不得把模型私有思维链写入轨迹或展示给用户。

## 完成定义

每个任务必须同时提交：变更清单、验证命令、测试结果、已知限制。文档变更必须先于对应源码变更。源码变更必须通过 `pnpm lint`、`pnpm typecheck` 与相关测试。

