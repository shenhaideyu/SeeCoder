# SeeCoder 2.0 数据模型

公共类型位于 `packages/protocol/src/index.ts`，运行时状态通过 V2 Event Envelope 追加写入 JSONL。

核心对象：ThreadSummary、Turn、PlanStep、ToolCall、ToolResult、Approval、ChangeSet、Checkpoint、ReviewFinding、AttachmentRef、SubagentState、ScheduleDefinition。

每个 Thread 保存 `meta.json`、`state.json`、`events.jsonl`；Checkpoint 文件保存变更前内容和哈希。API Key 不出现在任何文件中。
