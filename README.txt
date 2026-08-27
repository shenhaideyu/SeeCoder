SeeCoder 是一个自研的 Electron 桌面编程智能体 Demo。公开仓库：https://github.com/shenhaideyu/SeeCoder 。它通过 OpenAI 兼容 API 读取和搜索本地项目、应用补丁、执行测试，并用事件时间线展示计划、审批、终端、Diff、Review、子 Agent 与验证证据。核心循环、上下文管理、SSE/tool calling 解析、工具执行、权限策略、错误处理和 JSONL 轨迹均由项目自行实现，不使用任何 Agent 框架或服务端文件工具。

运行：安装 Node 24 与 pnpm，执行 pnpm install && pnpm dev。可通过 SEECODER_API_KEY 环境变量提供凭据，也可在设置页使用 Windows 系统加密存储。选择项目目录后输入任务；Guided 模式会逐次询问写入和命令，Auto 模式仅自动执行工作区内低风险动作。API Key 不会写入仓库、轨迹或日志。

特色：默认浅色 Codex 风格并保留深色紫晶主题（品牌色 C50 M100 Y0 K40，屏幕近似 #4D0099）、Plan/Guided/Auto、主 Agent 单写者、Explore/Review 只读子 Agent、Checkpoint/ChangeSet 回滚、附件图像输入、Git/Preview/计划任务和可恢复轨迹。
