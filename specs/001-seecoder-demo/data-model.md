# Data Model

Thread、Turn、Item、ToolCall、ToolResult、Approval、ChangeSet、SubagentState、PlanStep、AgentEvent 的 TypeScript 定义位于 `packages/protocol/src/index.ts`。持久化为 `meta.json` 和追加式 `events.jsonl`，快照按 ChangeSet 分目录保存。

