# SeeCoder 2.0 工作台规格

## 目标

把现有 SeeCoder Demo 升级为可演示的本地编程智能体工作台，完成分析、计划、审批、修改、测试、Review、Git 和恢复闭环。

## 功能需求与验收

| 编号 | 需求 | 可测试验收条件 |
|---|---|---|
| FR-201 | V2 事件路由 | 每条持久化事件包含 version/id/seq/threadId/type/timestamp；V1 可读取 |
| FR-202 | 正确工具上下文 | assistant tool calls 与 tool results 按 API 要求成对进入下一轮请求 |
| FR-203 | 三档权限 | Plan 不得写入；Guided 写入/命令需审批；Auto 只自动放行工作区低风险动作 |
| FR-204 | 计划与提问 | Agent 可更新计划、提问并暂停，用户回答后可继续 |
| FR-205 | Checkpoint | 每次修改前有快照，重启后可恢复并检测哈希冲突 |
| FR-206 | Git Review | 可查看四类 Diff，生成带文件/行号/严重度的只读 Finding |
| FR-207 | 交互终端 | 用户可输入命令、看到分组输出、取消和清屏 |
| FR-208 | 文件与附件 | 文件树可浏览，文本和 PNG/JPEG 可作为上下文，超限被拒绝 |
| FR-209 | 子 Agent | Explore/Review 独立上下文、只读、最多并发 2 个、禁止嵌套 |
| FR-210 | 本地扩展 | 可发现 Skills/Hooks；项目 Hook 启用前必须信任 |
| FR-211 | 任务工作台 | 搜索、置顶、归档、Fork、导出、通知和多任务状态均有效 |
| FR-212 | 页面入口完整 | 截图范围内每个应用按钮均有动作、页面或未配置说明 |
| FR-213 | 恢复与审计 | 重启后恢复消息、计划、审批、Diff、Checkpoint、子 Agent 和错误轨迹 |
| FR-214 | 兼容与安全 | 不使用 Agent 框架；Renderer 无 Node 权限；路径越界和危险命令被拒绝 |

## 非目标

- 不实现云同步、远程执行、远程插件市场和操作系统级沙箱。
- 不实现 Worktree 并行写入；环境入口只展示 Local 与未启用说明。
- Sites 只实现本地 Preview；计划任务只运行只读 Plan。
- Pull Request 读取依赖本机 `gh`，未配置时不得伪造数据。
