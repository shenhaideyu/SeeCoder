# Agent Core 详细设计

## 状态机

`queued -> running -> waitingApproval -> running -> completed`；异常转 `failed`，用户取消转 `cancelled`，迭代耗尽转 `limitReached`。

## 一轮循环

组装上下文 → 流式请求 → 重组 tool-call → schema 校验 → 权限决策 → 工具执行 → 事件持久化 → tool result 回填 → 下一轮。无工具调用或 `finish` 成功即终止。

## 限制

主 Agent 24 轮，子 Agent 6 轮；子 Agent 最多 2 个并发；命令 60 秒、输出 1 MiB；相同失败调用连续三次判定无进展。

## 工具

`list_files`、`read_file`、`read_files`、`search_text`、`write_file`、`apply_patch`、`run_command`、`git_diff`、`set_plan`、`delegate`、`ask_user`、`checkpoint`、`review_changes`、`compact_context`、`finish`。副作用工具带唯一 `callId`，结果已存在时不重复执行；每次写入前创建 Checkpoint，恢复时校验 afterHash，发现外部修改立即拒绝。

Turn 可在启动时绑定模式，计划任务固定绑定 `plan`。Follow-up 进入下一轮模型上下文，Review 通过只读子 Agent 生成 Finding 事件，模型请求事件记录耗时、结束原因、token 与重试次数。
