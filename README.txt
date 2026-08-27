SeeCoder 是一个自研的桌面编程智能体 Demo。它通过 OpenAI 兼容 API 读取和搜索本地项目、应用补丁、执行测试，并用事件时间线展示计划、审批、终端、Diff、子 Agent 与验证证据。核心循环、上下文管理、SSE/tool calling 解析、工具执行、权限策略、错误处理和 JSONL 轨迹均由项目自行实现，不使用任何 Agent 框架或服务端文件工具。

运行：安装 Node 24 与 pnpm，复制 .env.example 并设置 SEECODER_API_KEY，然后执行 pnpm install && pnpm dev。选择项目目录后输入任务；Guided 模式会逐次询问写入和命令，Auto 模式仅自动执行工作区内低风险动作。API Key 不会写入仓库或轨迹。

特色：深色紫晶 UI（品牌色 C50 M100 Y0 K40，屏幕近似 #4D0099）、主 Agent 单写者、Explore/Review 只读子 Agent、可回滚 ChangeSet、上下文压缩、可恢复执行轨迹和 Monaco Diff。仓库地址将在公开 Git 仓库创建后补充。

