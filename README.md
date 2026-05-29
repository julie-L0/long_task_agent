# 小柳 — 时间流驱动的行动调度秘书

基于时间流的主动任务调度 Agent。核心问题：长期任务容易断裂，小柳负责持续跟进。

**核心能力：** 任务/项目管理、进度追踪（percentage/streak/stage/checklist/每日配额）、提醒、时间线记录、断裂检测、见缝插针推进（感知当前状态，空闲时主动插入长期任务）、用户自定义规则（每天定时提醒直到确认）、固定时长 check-in 闭环（计时结束后自动追问）、每日打卡面板。

---

## 快速开始

### 前置条件

- Node.js >= 22
- 一个兼容 OpenAI 格式的 LLM API（默认配 MiniMax）

### 安装

```bash
git clone <repo>
cd long-task-agent
node scripts/setup.js
```

引导脚本会依次完成：环境检查、LLM API 配置、存储方式选择、消息通道配置。完成后直接 `npm start`。

> 使用 Codex / Claude Code 等 AI 工具安装时，直接让它运行 `node scripts/setup.js`，脚本每步完成后输出 `[STEP n/N: DONE]`，AI 工具可据此判断进度并指导下一步。

### 配置

```bash
cp .env.example .env
```

**必填：**

| 变量 | 说明 |
|------|------|
| `LLM_API_KEY` | LLM API key |
| `LLM_API_BASE_URL` | API 地址（默认 MiniMax） |
| `LLM_MODEL` | 模型名称 |

**可选：**

| 变量 | 说明 | 默认 |
|------|------|------|
| `AGENT_NAME` | Agent 名字 | 小柳 |
| `TIMEZONE` | 时区 | Asia/Shanghai |
| `STORAGE_BACKEND` | 存储方式：`local` 或 `bitable` | local |
| `CHANNEL` | 消息通道：`cli` 或 `weixin` | cli |

### 运行

```bash
npm start          # 前台运行
npm run start:bg   # 后台运行（日志写入 /tmp/xiaoliu.log）
npm run dev        # 开发模式（文件变更自动重启）
```

---

## 存储方式

### local（默认）

数据存在本地 `data/` 目录的 JSON 文件中，无需额外配置。

### bitable（飞书多维表格）

数据同步到飞书，可在手机端飞书查看和手动编辑。

**1. 安装并配置 lark-cli**

```bash
brew install lark-cli
lark-cli config init
```

**2. 开通飞书应用权限**

进入[飞书开发者后台](https://open.feishu.cn/app) → 你的应用 → 权限管理，搜索 `base`，开通以下全部权限：

```
base:app            base:app:create      base:app:readonly
base:field          base:field:create    base:field:read      base:field:update
base:record         base:record:create   base:record:delete   base:record:update
base:table          base:table:create    base:table:delete    base:table:read      base:table:update
```

开通后**发布新版本**使权限生效。

**3. 初始化多维表格**

```bash
npm run setup
```

脚本会自动创建「小柳数据」Base，建好 6 张表，把表 ID 写入 `.env`，设置 `STORAGE_BACKEND=bitable`。

---

## 消息通道

### CLI（默认）

```bash
npm start
```

命令行交互，适合本地调试。

### 微信（iLink Bot）

通过微信 iLink Bot API 接收/发送消息，在手机微信直接与小柳对话，主动提醒也会推送到微信。

**1. 登录获取凭证**

```bash
npm run weixin-login
```

终端会显示二维码链接，用微信扫码。扫码后手机微信会显示一串数字，在终端输入该数字完成验证。凭证自动写入 `.env`，同时设置 `CHANNEL=weixin`。

**2. 启动**

```bash
npm start
```

> `WEIXIN_ALLOWED_USER_IDS` 会自动填入你的微信用户 ID，只有该 ID 的消息才会被小柳响应。

---

## 数据分析

小柳记录的时间线数据可用于柳比歇夫时间法分析：

```bash
npm run analyze           # 终端输出分析报告
npm run analyze:export    # 同时导出 CSV 到 data/export/
```

**分析维度：**
- 每日各类活动时长分布
- 深度工作时长趋势（最近 14 天 + 周汇总）
- 任务拖延分析（已完成任务 vs 截止日）
- 项目进度速率（每天平均推进次数）
- 最高效时段（深度工作累计时长 Top 6）
- 打断模式（打断次数 + 原因分布）

---

## 目录结构

```
src/
  core/       — 配置、调度器、Agent 主循环、interruptibility 状态机
  llm/        — LLM 客户端（OpenAI 兼容）
  tools/      — Agent 可调用的工具
  storage/    — 数据层（local.js / bitable.js / index.js 路由）
  channel/    — 消息通道（cli.js / weixin.js）
templates/
  system-prompt.md   — Agent 人格与行为规则
  onboarding.md      — 新用户引导流程
scripts/
  setup-bitable.js   — 飞书初始化脚本（幂等，可重复运行）
  weixin-login.js    — 微信 iLink Bot 扫码登录
  analyze.js         — 时间数据分析脚本
data/         — 本地 JSON 数据（gitignore）
```

---

## 常见问题

**Q: `npm run setup` 报权限错误**  
A: 检查飞书应用是否已发布新版本，权限需要发版后才生效。

**Q: 想切回本地存储**  
A: 修改 `.env` 中 `STORAGE_BACKEND=local` 即可，数据不会丢失（两套存储独立）。

**Q: 重复执行 `npm run setup` 安全吗**  
A: 安全，脚本是幂等的，已有的表和字段不会重建。

**Q: 微信登录时提示输入数字是什么**  
A: 扫码后手机微信会弹出一串数字用于二次验证，在终端输入即可。
