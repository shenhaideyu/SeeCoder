# SeeCoder 2.0 任务清单

每项任务必须在完成时报告输入、输出、依赖和验证命令。

| ID | 任务 | 依赖 | 验证 |
|---|---|---|---|
| T201 | 冻结 V2 Protocol 与 IPC 类型 | 无 | `pnpm typecheck` |
| T202 | 实现 V1 JSONL 迁移、线程索引和 Checkpoint 恢复 | T201 | `pnpm test:unit -- storage` |
| T203 | 修复 SSE tool-call 与 assistant/tool 消息链 | T201 | `pnpm test:unit -- model` |
| T204 | 实现 Plan、ask_user、Follow-up、ContextLedger | T201/T203 | `pnpm test:unit -- agent-core` |
| T205 | 实现 Git 状态、Diff、Review、Stage、Commit、Push | T201 | `pnpm test:integration -- git` |
| T206 | 实现受控终端、文件树、附件和 Preview 服务 | T201 | `pnpm test:integration -- runtime` |
| T207 | 实现 Skills、Hooks 和只读计划任务 | T201/T206 | `pnpm test:unit -- extensions` |
| T208 | 重构 Renderer 和全部 `data-action` 按钮 | T201 | `pnpm test:e2e -- buttons` |
| T209 | 接入真实 IPC、通知、设置和多任务路由 | T202/T204/T208 | `pnpm test:e2e` |
| T210 | 完成演示项目、视觉验收和发布检查 | T201-T209 | 全部 CI 命令 |
