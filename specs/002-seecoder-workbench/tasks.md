# SeeCoder 2.0 任务清单

每项任务必须在完成时报告输入、输出、依赖和验证命令。

| ID | 任务 | 依赖 | 验证 |
|---|---|---|---|
| T201 | 冻结 V3 Session Protocol 与 IPC 类型 | 无 | `pnpm typecheck` |
| T202 | 实现 Session JSONL 回放、会话索引和 Checkpoint 恢复 | T201 | `pnpm test:unit -- storage` |
| T203 | 修复 SSE tool-call 与 assistant/tool 消息链 | T201 | `pnpm test:unit -- model` |
| T204 | 实现 Plan、ask_user、Follow-up、ContextLedger | T201/T203 | `pnpm test:unit -- agent-core` |
| T205 | 实现 Git 状态、Diff、Review、Stage、Commit、Push | T201 | `pnpm test:integration -- git` |
| T206 | 实现受控终端、附件和 Preview 服务 | T201 | `pnpm test:integration -- runtime` |
| T207 | 实现 Skills、Hooks 和只读计划任务 | T201/T206 | `pnpm test:unit -- extensions` |
| T208 | 重构 Renderer 和全部 `data-action` 按钮 | T201 | `pnpm test:e2e -- buttons` |
| T209 | 接入真实 IPC、通知、设置和多任务路由 | T202/T204/T208 | `pnpm test:e2e` |
| T210 | 完成演示项目、视觉验收和发布检查 | T201-T209 | 全部 CI 命令 |
| T211 | 实现 Ledger V2、revision 与旧状态迁移 | T201/T204 | `pnpm test:unit -- agent-core storage` |
| T212 | 实现预算器、协议组裁剪与模型摘要回退 | T203/T211 | `pnpm test:unit -- agent-core model` |
| T213 | 实现 Observation Compressor 与 FileEvidence 失效 | T211/T212 | `pnpm test:unit -- agent-core tools` |
| T214 | 实现轻量 MemoryEntry 检索和上下文事件 | T211/T212 | `pnpm test:integration` |
| T215 | 接入验证新鲜度状态和 Sources 指标 | T211-T214 | `pnpm test:e2e` |
| T216 | 执行长上下文、真实 Prompt 与完整质量门禁 | T211-T215 | 全部 CI 与真实会话评测 |
