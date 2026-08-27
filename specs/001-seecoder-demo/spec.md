# SeeCoder Demo Specification

## 用户故事

1. 作为开发者，我可以选择本地项目并提交编程任务。
2. 我可以看到 Agent 的计划、工具调用、终端输出、Diff、审批和测试证据。
3. 我可以拒绝危险操作，Agent 会收到拒绝原因并调整方案。
4. 我可以看到 Explore/Review 子 Agent 的独立调查结果。
5. 应用重启后，我可以恢复任务和完整轨迹。

## 验收条件

- 给定 fake provider 的固定 tool-call 序列，任务最终进入 completed。
- 任意 workspace 外路径均返回 policy_denied。
- 补丁旧内容不匹配时目标文件字节级不变。
- Guided 模式的写入/命令在审批前不产生副作用。
- 两个只读子 Agent 可并发完成，第三个被排队或拒绝。
- UI 能从事件流重建当前任务视图。

