# 小柳 Agent — 技术方案总结

> 最后更新：2026-05-29

---

## 一、项目背景与核心问题

小柳是一个**时间流驱动的 AI 行动调度秘书**，解决的核心问题：

**长期任务容易断裂。** 普通 Todo 只能存放任务，无法判断现在是否适合推进、当前是否有可利用时间、是否应该主动提醒、长期任务是否已经断裂太久。

系统不是聊天机器人，是 Active Scheduler——主动感知时间流、判断用户状态、在合适时机插入任务推进。

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────┐
│                     消息通道层                        │
│   CLI（调试）  /  微信 iLink Bot（生产）               │
└────────────────────┬────────────────────────────────┘
                     │ 用户消息 / 系统触发
                     ▼
┌─────────────────────────────────────────────────────┐
│                    Agent 主循环                       │
│  loadActiveContext() → LLM（function calling）→      │
│  executeTool() → 回复 / 写存储                        │
└────────────────────┬────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
┌──────────┐  ┌──────────┐  ┌──────────────┐
│ 存储层    │  │ 调度层    │  │ 状态模块      │
│local/    │  │scheduler │  │interruptibility│
│bitable   │  │(cron)    │  │(singleton)   │
└──────────┘  └──────────┘  └──────────────┘
```

---

## 三、模块详解

### 3.1 消息通道（Channel）

**设计原则：** 通道与 Agent 解耦，统一接口 `{ display(text, userId), [stop()] }`。

#### CLI 通道（`src/channel/cli.js`）
- Node.js `readline` 实现，用于本地开发调试
- `CHANNEL=cli`（默认）

#### 微信通道（`src/channel/weixin.js`）
- 基于**微信 iLink Bot API**（官方 Tencent 接口）
- **接收消息：** HTTP 长轮询 `POST ilink/bot/getupdates`，35s 超时，维护 `sync_buffer` 断点续传
- **发送消息：** `POST ilink/bot/sendmessage`，文本按 3800 字符分块，句段边界切割；`\n` 在单条消息内渲染为换行
- **认证：** Bearer token，Header 携带 `AuthorizationType: ilink_bot_token`
- **context_token：** 每条回复必须回传来自用户消息的 context_token，否则无法投递
- **用户过滤：** `WEIXIN_ALLOWED_USER_IDS` 白名单，仅接受指定用户消息
- `CHANNEL=weixin`

**登录方式（`npm run weixin-login`）：**
1. `POST ilink/bot/get_bot_qrcode`（bot_type=3）获取二维码 URL
2. 展示给用户，用微信扫码
3. 长轮询 `GET ilink/bot/get_qrcode_status`，处理 `need_verifycode`（手机显示数字，终端输入）
4. 凭证（bot_token / bot_id / base_url / ilink_user_id）写入 `.env`，`WEIXIN_ALLOWED_USER_IDS` 自动填入登录者 ID
5. 最长 8 分钟超时，支持二维码刷新（最多 3 次）

---

### 3.2 Agent 主循环（`src/core/agent.js`）

每轮对话流程：
1. `loadActiveContext()` 并行拉取 6 张表（`Promise.all`），注入 system prompt
2. 构建 messages：`[system, ...history, user]`
3. LLM（OpenAI 兼容 API，当前接 MiniMax-M2.7）调用，携带全部 tool definitions
4. 循环执行 tool calls（最多 12 轮），每轮结果写回存储
5. 返回最终回复 + `shouldResetContext` 标志（切线时触发）

**活跃上下文注入内容：**
- 当前时间 + interruptibility 状态
- 活跃任务（含 `estimated_duration_min`、`execution_mode`）
- 活跃项目（含进度、最近 3 条 progress_log、每日配额 `今日 X/Y`）
- 今日到期提醒
- 活跃用户规则
- 未关闭的 timeline 事件（含 `expected_next_action`）
- 新用户检测：tasks + projects + rules 全空时注入 `templates/onboarding.md`

**当前模型：** MiniMax-M2.7，base_url `https://api.minimax.chat/v1`，可通过 `.env` 切换任意 OpenAI 兼容 API。

---

### 3.3 存储层（`src/storage/`）

**双后端设计，统一异步接口：**

```
listItems / getItem / createItem / updateItem / deleteItem
```

#### Local（`src/storage/local.js`）
- 本地 JSON 文件，`data/{collection}.json`
- 同步读写，轻量，适合开发和个人使用

#### Bitable（`src/storage/bitable.js`）
- 飞书多维表格，通过 `lark-cli` 调用飞书 API
- 支持在手机飞书端查看/编辑数据
- 每次读写约 200-400ms（个人使用可接受）
- 路由：`STORAGE_BACKEND=bitable`

**6 张表：**

| 表名 | 用途 | 关键字段 |
|------|------|---------|
| tasks | 任务（所有类型） | execution_mode, urgency, hard_deadline, flexible_deadline, recurrence_rule, estimated_duration_min |
| projects | 长期项目 + 进度 | progress_type, progress_value, daily_quota, daily_done, streak_current |
| reminders | 定时提醒 | trigger_at, type, repeat_until_confirmed |
| timeline | 时间线事件 | activity_type, start_time, end_time, checkin_status, expected_next_action |
| progress_logs | 项目进度日志 | project_id, delta, logged_at |
| user_rules | 用户自定义规则 | trigger_condition, persistence, stop_condition |

**例外：** `data/interruptibility.json` 始终本地存储（运行时状态，不需要云同步）。

---

### 3.4 调度层（`src/core/scheduler.js`）

| 任务 | 频率 | 职责 |
|------|------|------|
| `checkReminders` | 每分钟 | 扫描到期提醒，调用 `autoExpire()` |
| `checkUserRules` | 每分钟 | 评估用户自定义规则触发条件 |
| `checkDeferrableOpportunity` | 每 5 分钟 | interruptible 时推送今日 deferrable 待办（90min 冷却） |
| `checkDailyQuota` | 每 5 分钟 | 每日配额未完成时提醒（90min 冷却） |
| `checkStaleProjects` | 每小时整点 | 检测 24h 未推进项目，8-23 时段 + interruptible 双重过滤 |
| `checkExpectedNextAction` | 每小时整点 | 检测有 expected_next_action 且超时的 timeline 事件 |
| `checkStreakBreaks` | 每天 00:01 | 重置昨日未完成配额的 daily_done，streak 断裂处理 |

**见缝插针逻辑（`checkDeferrableOpportunity`）：**
1. 读取 `interruptibility` 状态，若非 `open` 则跳过
2. 找出今日 deferrable 且 pending 的任务
3. 按 urgency 排序，推送优先级最高的一个
4. 90 分钟内不重复推送（`lastDeferrableNudge` 冷却）

**提醒路由（`src/index.js`）：**
- `user_rule`：入口代码直接展示规则原文；持续规则只登记等待确认，不经过 LLM 改写
- `task_checkin` / `project_nudge` / `silence_check`：路由给 Agent 处理
- 其他类型：直接展示文本

---

### 3.5 Interruptibility 状态机（`src/core/interruptibility.js`）

**三种状态：**

| 状态 | 含义 | 调度器行为 |
|------|------|-----------|
| `open` | 可打扰 | 正常推送 stale 提醒 |
| `dnd_until_time` | 到指定时间恢复 | 跳过，`autoExpire()` 到期自动重置 |
| `dnd_until_user_confirms` | 等用户主动说恢复 | 跳过，直到用户调用 `set_interruptibility(open)` |

**状态来源：** 完全由用户明确声明（`set_interruptibility` 工具），不再硬编码 activity_type 映射。

**活动类型规则（用户自定义）：**
- 只有用户明确要求长期偏好时，才存为 `trigger_condition="activity:[类型]"` 的 user_rule
- 不因首次遇到某类活动自动追问是否设 dnd
- 后续同类活动可按规则执行，但普通状态汇报不触发追问
- "工作/上班"等泛化状态不触发 dnd（工作是容器状态，不是具体专注事件）

**持久化：** `data/interruptibility.json`（本地 JSON，进程间共享状态）

---

### 3.6 工具集（`src/tools/index.js`）

**任务管理：**
- `create_task` / `update_task` / `list_tasks` / `delete_task`
- `update_task` 完成时若有 `recurrence_rule`，自动创建下一周期实例

**项目管理：**
- `create_project` / `match_existing_project` / `update_project_progress` / `list_projects` / `archive_confirmed`
- `update_project_progress` 支持 `streak_action`：`checkin`（连续打卡）、`daily_checkin`（每日配额）、`stage_advance`（阶段推进）

**提醒：**
- `create_reminder` / `cancel_reminder`

**时间线：**
- `log_timeline`（含 `expected_next_action` 字段）/ `update_timeline` / `get_open_timeline`

**打扰控制：**
- `set_interruptibility` / `get_interruptibility`

**用户规则：**
- `create_user_rule` / `list_user_rules` / `update_user_rule` / `confirm_user_rule`

**工具：**
- `get_current_time` / `read_file` / `write_file`

---

### 3.7 用户自定义规则（User Rule）

解决"持续性条件触发提醒"的场景（静态 reminder 无法表达的逻辑）。

**触发条件格式：**
- `daily:HH:mm` — 每天指定时间
- `weekly:mon,wed,fri:HH:mm` — 每周指定日期
- `activity:[类型]` — 用户明确要求的长期活动偏好（Agent 手动查询，非调度器触发）

**触发逻辑（每分钟评估）：**
- 今天未触发 + 时间已过 → 触发
- 持续模式 + 今天已触发 + 未确认 + 间隔已到 → 再次触发
- 今天已确认（`confirmed_at` 在今天）→ 跳过

---

### 3.8 进度追踪类型

| progress_type | 适用场景 | 关键字段 |
|--------------|---------|---------|
| `percentage` | 论文字数、项目完成度 | `progress_value`（0-100） |
| `streak` | 每日打卡（跑步、冥想） | `streak_current`, `streak_best` |
| `stage` | 多阶段项目（初稿→修改→定稿） | `stage_current`, `stage_total`, `stage_names` |
| `checklist` | 清单式任务 | `checklist_items`（JSON 数组） |
| `daily_quota` | 每日配额（喝水 3 杯） | `daily_quota`, `daily_done`, `daily_reset_date` |

---

### 3.9 Fixed Duration Check-in 闭环

用户说"学习一小时"时的完整流程：

```
用户："学习一小时"
  ↓
create_task (fixed_duration, 60min)
log_timeline (study, current_active_task="学习英语", expected_next_action="...")
create_reminder (trigger_at=now+60min, task_checkin, repeat_until_confirmed=true)
set_interruptibility (dnd_until_time, until=now+60min)  ← 仅专注类活动
  ↓
[60分钟后，调度器触发 check-in]
  ↓
Agent 向用户询问："学习英语做完了吗？"
  ↓
用户："完了"
  ↓
get_open_timeline → update_timeline (end_time, confirmed)
update_task (completed)
set_interruptibility (open)
→ 推荐今日 deferrable 待办（如有）
```

---

### 3.10 新用户引导（`templates/onboarding.md`）

触发条件：tasks + projects + user_rules 全部为空（`isNewUser=true`）。

引导流程（响应式，不主动发起）：
1. 自我介绍 + 询问用户名字和当前主要项目
2. 帮用户创建第一个长期任务
3. 展示一个使用示例
4. 可选：询问是否设置每日提醒规则

---

## 四、系统 Prompt 核心指令

`templates/system-prompt.md` 中定义的关键行为：

1. **不自行遗忘**：工作记忆完全依赖每轮注入的"活跃状态"，不依赖对话记忆
2. **即时写入**：用户提到任务/进度/时间 → 立刻调用工具写入存储
3. **先查后建**：创建项目/任务前必须先检索，防止重复
4. **fixed_duration 闭环**：严格按四步流程执行
5. **打扰控制**：用户说"别打扰"必须追问恢复方式，不假设
6. **用户规则**：用户说"每天 X 提醒"时调用 create_user_rule
7. **面板（Dashboard）**：用户说"面板/状态/今天怎么样"时输出完整面板（今日待办 + 本周待办 + 今日打卡 + 长期项目 + 需要处理）
8. **切线（归档）**：逐项确认后调用 archive_confirmed，支持 task_ids / project_ids / reminder_ids / rule_ids
9. **消息格式**：禁止 Markdown，用换行和空行分隔，列表用 · 或数字+点，强调用【】或「」

---

## 五、飞书数据价值（柳比歇夫时间法）

「小柳」的名字来自苏联昆虫学家亚历山大·柳比歇夫（Alexander Lyubishchev）。他坚持了56年的时间统计法：每天记录自己把时间花在了哪里，精确到分钟。小柳做的事和他一样——持续记录时间流，积累的数据随时可以复盘。

小柳记录的数据天然符合柳比歇夫时间统计法的数据结构：

**可分析维度：**

| 分析 | 数据来源 | 价值 |
|------|---------|------|
| 每日活动时长分布 | timeline | 了解时间实际去向 |
| 深度工作趋势 | timeline（study/work，未打断） | 追踪专注力变化 |
| 任务拖延分析 | tasks（completed + hard_deadline） | 识别拖延模式 |
| 项目进度速率 | progress_logs | 预测完成时间 |
| 最高效时段 | timeline × activity_type | 优化日程安排 |
| 打断模式 | timeline（interrupted） | 减少干扰源 |

**导出方式：**
```bash
npm run analyze           # 终端报告
npm run analyze:export    # 同时导出 CSV 到 data/export/
```

---

## 六、部署与运行

```bash
npm install
cp .env.example .env      # 填写 LLM_API_KEY 等必填项
npm run setup             # 可选：初始化飞书多维表格
npm run weixin-login      # 可选：微信 iLink Bot 登录
npm start
```

**后台运行：**
```bash
npm run start:bg          # nohup 后台，日志写入 /tmp/xiaoliu.log
tail -f /tmp/xiaoliu.log  # 查看日志
```

---

## 七、当前限制与后续方向

**当前限制：**
- 微信 iLink Bot 需要向腾讯申请，非公开 API
- bitable 每次读写约 200-400ms，高频场景下响应稍慢
- 对话历史最多保留 20 轮（`MAX_HISTORY=20`）

**后续方向：**
- 行为模式分析增强（周报自动生成）
- 主动打断策略增强（更细粒度的 interruptibility）
- 外接硬件 Todo
- 长期行为趋势分析与可视化
