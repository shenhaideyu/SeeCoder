# Agent Core 详细设计

## 状态机

`queued -> running -> waitingApproval -> running -> completed`；异常转 `failed`，用户取消转 `cancelled`，迭代耗尽转 `limitReached`。

## 一轮循环

组装上下文 → 流式请求 → 重组 tool-call → schema 校验 → 权限决策 → 工具执行 → 事件持久化 → tool result 回填 → 下一轮。无工具调用或 `finish` 成功即终止。

## 限制

主 Agent 24 轮，子 Agent 6 轮；子 Agent 最多 2 个并发；命令 60 秒、输出 1 MiB；相同失败调用连续三次判定无进展。

## 工具

`list_files`、`read_file`、`search_text`、`write_file`、`apply_patch`、`run_command`、`git_diff`、`set_plan`、`delegate`、`finish`。副作用工具带唯一 `callId`，结果已存在时不重复执行。

