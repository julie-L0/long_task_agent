# 长任务推进秘书（小柳 Agent）

## 项目概述

AI 行动调度系统，基于时间流的主动任务秘书。核心不是静态 Todo，而是让长期任务不断裂。

## 技术栈

- Node.js >= 22, ESM
- LLM: OpenAI compatible API (function calling)
- 存储: 本地 JSON（local）/ 飞书多维表格（bitable，已接入，6 张表）
- 消息: CLI（默认）/ 微信 iLink Bot（已接入，`CHANNEL=weixin`）

## 目录约定

```
src/core/       — 配置、调度器、Agent 主循环
src/llm/        — LLM 客户端
src/tools/      — Agent 可调用的工具
src/storage/    — 数据存储层
src/channel/    — 消息通道（CLI、微信）
data/           — 本地 JSON 数据文件（gitignore）
templates/      — 系统 prompt 模板（system-prompt.md, onboarding.md）
scripts/        — 独立脚本（setup-bitable.js, weixin-login.js, analyze.js）
```

## 开发规范

- 所有文件使用 ESM (import/export)
- 时间一律用 ISO8601 + 时区存储
- 配置通过 .env 加载，不硬编码
- LLM 调用统一走 src/llm/provider.js
- 数据操作统一走 src/storage/，不直接读写文件

## 团队

- lijue: 产品 + 数据 + 开发
