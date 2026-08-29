# IPC 与事件协议参考

## 1. 两套协议的边界

IPC 是 Renderer 向可信 Main 发出的命令；AgentEvent 是 Main 向 Renderer 发布的事实。命令可以失败，事实只能描述已经发生或正在等待的状态。把二者分开能避免 UI 通过修改本地 store 假装后台状态已经改变。

## 2. Preload 安全模型

窗口配置为 `contextIsolation:true`、`nodeIntegration:false`。Preload 仅通过 `contextBridge` 暴露 `window.seecoder`。当前因 ESM preload 兼容使用 `sandbox:false`，因此不能宣称 Renderer 处于完整 Chromium 沙箱；真正控制面来自最小 IPC 白名单和 Main 端校验。

禁止新增如下接口：

```ts
readAnyFile(path: string)
exec(command: string)
invoke(channel: string, ...args: unknown[])
```

它们会把固定能力退化为任意能力，绕过每个 channel 的参数、风险和语义边界。

## 3. IPC 命令域

| 域 | 代表操作 | Main 端必要检查 |
| --- | --- | --- |
| workspace | select/list/switch/open | 目录存在、规范路径、切换前取消旧 Core |
| thread | create/list/hydrate/history/rename/flag/fork/search/export | threadId、workspace 归属、文本长度、脱敏 |
| turn | start/followUp/cancel | 单 Thread 单活动 Turn、附件、长度 |
| approval/input | resolve | 请求仍 pending、所属 Turn 存在 |
| changes/checkpoint | revert/list/restore | 记录存在、哈希冲突、工作区路径 |
| files | list/read/search | WorkspacePolicy、敏感文件、范围上限 |
| git | status/diff/branches/checkout/stage/commit/push | Git 根必须等于工作区根、引号、风险 |
| terminal | run | cwd、危险命令拒绝、超时 |
| settings | read/update | 数值范围、Key 加密、重建 Provider |
| schedule/extension | 管理计划和本地扩展 | 项目路径、只读模式、信任边界 |

TypeScript 只能约束编译期调用者，恶意或损坏 Renderer 仍可直接发送 IPC。因此 Main 的 `textArg`、路径策略与数值范围才是运行时边界。当前 IPC 尚未全部统一使用 Zod，这是已知工程债务。

## 4. Event V2 Envelope

设计目标是让每条记录能够独立路由和排序：

```ts
interface AgentEventEnvelope<T> {
  version: 2;
  id: string;
  seq: number;
  type: T['type'];
  threadId: string;
  turnId?: string;
  timestamp: string;
  payload: T;
}
```

当前 SessionStore 为兼容既有代码，JSONL 同时保存 `event` 和 `payload`，并在读取 V1 时补齐 threadId。它属于迁移形态，不是长期最简格式；删除冗余字段前必须先迁移所有已有会话。

## 5. 顺序与唯一性

- `id`：事件唯一标识，用于去重与审计。
- `seq`：Thread 内单调递增序号，用于重放顺序。
- `timestamp`：墙钟时间，用于展示，不能替代 seq 排序。
- `threadId`：路由主键，不应从嵌套 payload 猜测。
- `turnId`：可选关联键，Thread 级事件不一定拥有。

当前 seq 在内存中维护，首次 readEvents 后从最高值恢复。单进程桌面应用满足这一假设；若未来允许多个进程同时写同一 Thread，必须引入文件锁或单写服务。

## 6. 生命周期事件契约

```text
thread.created
turn.started
  model.requested
  message.delta*                 非持久化
  model.completed
  message.completed | assistant.tool_calls
  tool.requested*
  approval.requested? → approval.resolved?
  tool.output*                   可实时且可持久化
  tool.completed*
  changes.created? → checkpoint.created?
turn.completed | turn.failed | turn.cancelled
```

星号表示零到多次，问号表示可选。`message.delta` 是传输优化，不是恢复事实；刷新后 UI 应以 `message.completed` 为准。

## 7. 事件的消费者

| 事件 | Renderer | Storage | Logger | Context |
| --- | --- | --- | --- | --- |
| message.delta | 拼接临时文本 | 不保存 | 不记录内容 | 不直接加入 |
| message.completed | 固化消息 | 保存 Item | 元数据 | assistant message |
| tool.output | Terminal 实时流 | 保存事件 | 只记 bytes | 不加入 |
| tool.completed | 工具卡终态 | 保存 Item | code/duration | 裁剪后 tool message |
| changes.created | Changes 面板 | 保存 Item/snapshot | 事件关联 | Ledger 文件列表 |
| model.completed | Trace 指标 | 保存事件 | token/耗时 | 不加入正文 |
| turn.* | 全局状态 | 保存事件 | 生命周期 | 不作为模型消息 |

## 8. UI Reducer 原则

Renderer 必须按 `threadId` 分桶，再按事件更新：

```ts
state.threads[event.threadId] = reduceThread(
  state.threads[event.threadId],
  event,
)
```

不能使用单个全局 `isRunning`、`messages` 或 `terminalOutput` 承载所有任务，否则快速切换任务时会串线。历史 hydrate 与实时 subscribe 也要去重，优先使用事件 id，缺失 id 的旧记录可使用 seq/type 组合。

## 9. 错误返回约定

IPC invoke 的参数或前置条件错误可以 reject，由 Renderer 转成操作级提示；Agent 内部预期失败应形成 ToolResult 或 AgentEvent，不能只 reject IPC。两者区别：

- “传入空 threadId”是调用协议错误。
- “测试命令退出码 1”是 Agent observation。
- “用户拒绝审批”是正常决策结果。
- “Main 崩溃”才是系统错误。

## 10. 版本演进规则

新增字段应可选并有默认解释；新增事件类型应让旧 UI 安全忽略；修改字段含义需要提升协议版本。事件读取器应宽容损坏尾行，但不能悄悄改写合法历史。协议变更必须同步更新：protocol 类型、JSON Schema、Main、Renderer reducer、Storage 兼容逻辑和 E2E fixture。

## 11. 验证清单

- 任意事件能仅凭 envelope 路由到 Thread。
- 同一 Thread 快速切换不会串消息、终端和审批。
- Renderer 刷新后最终消息、计划、ChangeSet、Checkpoint 可恢复。
- 未知事件不会导致页面崩溃。
- IPC 参数异常有用户反馈且不会触发副作用。
- API Key 不出现在 IPC read 返回值、事件或日志中。
