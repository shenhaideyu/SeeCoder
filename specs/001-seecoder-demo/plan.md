# Implementation Plan

采用 pnpm + Electron/React/TypeScript/Vite 的模块化单体；核心包不依赖 UI。模型使用原生 fetch/SSE；存储使用 JSONL；测试使用 Vitest 与 Playwright Electron。先实现 fake provider 和纯 Core，再接入真实 Provider 和 UI。

