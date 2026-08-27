# SeeCoder 2.0 实施计划

## 模块映射

| 模块 | 对应需求 | 输出 |
|---|---|---|
| protocol/storage | FR-201/205/213 | V2 Envelope、迁移读取、索引、Checkpoint |
| model/agent-core | FR-202/203/204/209/213 | 三档模式、工具循环、提问、Follow-up、子 Agent |
| tools/runtime | FR-206/207/208/214 | Git、终端、文件树、附件、权限、回滚 |
| desktop IPC | FR-211/212/214 | 类型化 IPC、通知、设置、任务管理 |
| renderer | FR-206/208/211/212 | Codex 风格三栏工作台和全部按钮行为 |
| extensions/scheduler | FR-210/211 | 本地 Skills/Hooks、只读计划任务 |

## 固定决策

- 使用 Electron 主进程作为本地可信执行边界。
- 使用原生 fetch/SSE 和自研调度，不使用 Agent SDK。
- 使用 JSONL 轨迹和 JSON 索引，不引入数据库。
- 使用连续外观的受控命令终端，不引入原生 PTY。
- 使用 Mock Provider 让 Electron E2E 可离线重复执行。
