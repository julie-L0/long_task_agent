import { randomUUID } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import dayjs from "dayjs";
import { config } from "../core/config.js";
import * as storage from "../storage/index.js";
import { getState, setState } from "../core/interruptibility.js";

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "获取当前系统时间",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description: "创建一个新任务。任务标题不够详细时不要追问，直接用用户原话建任务；只有多个活跃任务/项目都可能匹配、会造成重复或用户要修改既有项但对象不唯一时，才和用户确认。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "任务名称" },
          project: { type: "string", description: "所属项目" },
          category: { type: "string", enum: ["work", "study", "life", "health"] },
          importance: { type: "string", enum: ["high", "medium", "low"] },
          urgency: { type: "string", enum: ["high", "medium", "low"] },
          estimated_duration_min: { type: "number", description: "预计时长（分钟）" },
          hard_deadline: { type: "string", description: "硬截止时间 ISO8601" },
          flexible_deadline: { type: "string", description: "弹性截止时间 ISO8601" },
          start_time: { type: "string", description: "开始时间 ISO8601" },
          execution_mode: { type: "string", enum: ["fixed_duration", "deferrable"] },
          recurrence_rule: { type: "string", description: "周期规则描述" },
          notes: { type: "string" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description: "更新任务字段。状态变更必须用户确认后才能调用。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "任务 ID" },
          status: { type: "string", enum: ["pending", "in_progress", "paused", "completed", "cancelled"] },
          title: { type: "string" },
          notes: { type: "string" },
          hard_deadline: { type: "string" },
          flexible_deadline: { type: "string" },
          start_time: { type: "string" },
          end_time: { type: "string" },
          urgency: { type: "string", enum: ["high", "medium", "low"] },
          importance: { type: "string", enum: ["high", "medium", "low"] },
          execution_mode: { type: "string", enum: ["fixed_duration", "deferrable"] },
          estimated_duration_min: { type: "number" },
          category: { type: "string", enum: ["work", "study", "life", "health"] },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "查询任务列表，可按状态或项目筛选",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "in_progress", "paused", "completed", "cancelled"] },
          project: { type: "string" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "删除任务（慎用，优先用 update_task 改 status）",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_reminder",
      description: "创建定时提醒。不要用它创建用户规则；每天/每周/以后持续生效的规则必须使用 create_user_rule。",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "关联任务 ID（可选）" },
          trigger_at: { type: "string", description: "触发时间 ISO8601" },
          type: { type: "string", enum: ["task_start", "task_checkin", "task_deadline", "project_nudge"] },
          message: { type: "string", description: "提醒内容" },
          repeat_until_confirmed: { type: "boolean" },
        },
        required: ["trigger_at", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_reminders",
      description: "查询提醒列表，可按状态过滤",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "fired", "dismissed"], description: "不传则返回全部" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_reminder",
      description: "取消提醒",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_timeline",
      description: "记录时间线事件。用户只是汇报当前状态时可以用它记录，但不要因此自动创建 check-in 提醒或追问结束时间；只有用户明确要求计时/提醒时才配合 create_reminder。",
      parameters: {
        type: "object",
        properties: {
          start_time: { type: "string", description: "开始时间 ISO8601" },
          end_time: { type: "string", description: "结束时间 ISO8601（可选）" },
          activity_type: { type: "string", enum: ["work", "study", "commute", "rest", "meeting", "entertainment", "other"] },
          related_task_id: { type: "string" },
          current_active_task: { type: "string", description: "当前在做什么（自然语言描述）" },
          expected_next_action: { type: "string", description: "预计完成后下一步做什么（如'休息后继续论文'/'跑步后洗澡'）" },
          source: { type: "string", enum: ["user_input", "ai_inferred", "system"] },
        },
        required: ["start_time", "activity_type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_timeline",
      description: "关闭或更新时间线事件。用户 check-in 完成时调用，填写 end_time 和 checkin_status。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "timeline 事件 ID" },
          end_time: { type: "string", description: "结束时间 ISO8601" },
          checkin_status: { type: "string", enum: ["confirmed", "interrupted", "abandoned"], description: "confirmed=正常完成；interrupted=中途打断；abandoned=放弃" },
          interruption_reason: { type: "string", description: "中断原因（checkin_status=interrupted 时填）" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_open_timeline",
      description: "获取当前未关闭的时间线事件（end_time 为空）。check-in 回应后用于找到要关闭的事件。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "set_interruptibility",
      description: "设置当前可打扰状态。只有用户明确说不要打扰/别烦我，或给出明确勿扰时间窗口时调用；单纯说'我在做X'只是状态汇报，不要因此追问恢复方式。用户说'好了/可以了/回来了'时用 status=open 调用。",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["open", "dnd_until_time", "dnd_until_user_confirms"],
            description: "open=可打扰；dnd_until_time=到指定时间恢复；dnd_until_user_confirms=等用户主动说恢复",
          },
          until: { type: "string", description: "恢复时间 ISO8601，status=dnd_until_time 时必填" },
          reason: { type: "string", description: "用户正在做的事（如'开会'/'专注写作'）" },
        },
        required: ["status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_interruptibility",
      description: "查询当前可打扰状态",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  // --- Project 管理 ---
  {
    type: "function",
    function: {
      name: "create_project",
      description: "创建长期项目。注意：调用前必须先调用 match_existing_project 检查是否已存在同名/相似项目，如果有匹配必须先和用户确认是新建还是更新已有项目。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "项目名" },
          description: { type: "string" },
          progress_type: { type: "string", enum: ["percentage", "streak", "stage", "checklist"], description: "进度跟踪方式" },
          progress_total: { type: "number", description: "目标总量（percentage 模式）" },
          progress_unit: { type: "string", description: "单位（字/天/个/页等）" },
          progress_stages: { type: "string", description: "阶段列表，逗号分隔（stage 模式）" },
          progress_items: { type: "string", description: "清单项，逗号分隔（checklist 模式）" },
          streak_goal: { type: "number", description: "连续目标天数（streak 模式）" },
          daily_quota: { type: "number", description: "每日目标次数（streak 模式，如每天3杯水填3）" },
          confirmed_new: { type: "boolean", description: "是否已和用户确认这是新项目（必须为 true 才能创建）" },
        },
        required: ["name", "progress_type", "confirmed_new"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "match_existing_project",
      description: "根据关键词搜索已有项目，返回匹配列表。创建项目前必须先调用此工具。",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "搜索关键词（如'论文'、'跑步'）" },
        },
        required: ["keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_project_progress",
      description: "更新项目进度。每次用户报告进展时必须调用。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "项目 ID" },
          delta: { type: "number", description: "增量（percentage 模式加多少）" },
          streak_action: { type: "string", enum: ["checkin", "break", "daily_checkin"], description: "打卡或断了（streak 模式）；daily_checkin=今日配额+1（daily_quota 模式）" },
          advance_to_stage: { type: "number", description: "推进到第几阶段（stage 模式，从1开始）" },
          check_item: { type: "string", description: "完成的清单项名称（checklist 模式）" },
          note: { type: "string", description: "本次进展备注" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_projects",
      description: "查看所有项目列表及进度",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "archive_confirmed",
      description: "用户确认后归档项目、任务或独立提醒。调用此工具会触发上下文重置。必须先和用户确认！",
      parameters: {
        type: "object",
        properties: {
          project_ids: { type: "string", description: "要归档的项目 ID，逗号分隔" },
          task_ids: { type: "string", description: "要归档的任务 ID，逗号分隔" },
          reminder_ids: { type: "string", description: "要归档的独立提醒 ID，逗号分隔" },
          rule_ids: { type: "string", description: "要删除的用户规则 ID，逗号分隔" },
        },
        required: [],
      },
    },
  },
  // --- User Rule ---
  {
    type: "function",
    function: {
      name: "create_user_rule",
      description: "创建用户自定义规则。调用前必须先调用 list_user_rules 检查：1) 是否有相同 trigger_condition 的规则（冲突则询问替换还是新建）；2) 活跃规则总数是否已达 10 条（达到则提示用户先整理）。trigger_condition 格式：'daily:HH:mm' 或 'weekly:mon,wed,fri:HH:mm'；只有用户明确要求长期活动偏好时才用 'activity:[类型]'，不要因首次遇到某活动就追问。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "规则名称，如'睡觉提醒'" },
          trigger_condition: { type: "string", description: "触发条件，如 'daily:23:00' 或 'weekly:mon,wed:09:00'" },
          message: { type: "string", description: "提醒内容" },
          persistence: { type: "boolean", description: "是否持续提醒直到用户确认（默认 false）" },
          repeat_interval_min: { type: "number", description: "持续提醒时的间隔分钟数（persistence=true 时有效，默认15分钟）" },
          stop_condition: { type: "string", enum: ["user_confirms", "once"], description: "停止条件：user_confirms=用户确认后停；once=触发一次即停" },
        },
        required: ["name", "trigger_condition", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_user_rules",
      description: "查看所有用户规则",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "update_user_rule",
      description: "修改或暂停/恢复用户规则",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          trigger_condition: { type: "string" },
          message: { type: "string" },
          persistence: { type: "boolean" },
          repeat_interval_min: { type: "number" },
          stop_condition: { type: "string", enum: ["user_confirms", "once"] },
          status: { type: "string", enum: ["active", "paused"] },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_user_rule",
      description: "用户确认已响应某条持续规则，停止今日重复提醒。用户说'好了'/'睡了'/'知道了'等回应持续提醒时调用。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "规则 ID（可从活跃状态中获取）" },
        },
        required: ["id"],
      },
    },
  },
  // --- 文件操作 ---
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取本地文件内容",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "文件路径" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "写入内容到本地文件",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          content: { type: "string", description: "文件内容" },
        },
        required: ["path", "content"],
      },
    },
  },
];

export async function executeTool(name, args) {
  const now = () => dayjs().format("YYYY-MM-DD HH:mm:ss");

  switch (name) {
    case "get_current_time":
      return { current_time: now(), timezone: config.timezone };

    case "create_task": {
      const task = {
        id: randomUUID(),
        title: args.title,
        project: args.project || null,
        category: args.category || null,
        importance: args.importance || "medium",
        urgency: args.urgency || "medium",
        estimated_duration_min: args.estimated_duration_min || null,
        hard_deadline: args.hard_deadline || null,
        flexible_deadline: args.flexible_deadline || null,
        start_time: args.start_time || null,
        end_time: null,
        execution_mode: args.execution_mode || "deferrable",
        status: "pending",
        recurrence_rule: args.recurrence_rule || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_touched_at: new Date().toISOString(),
        notes: args.notes || null,
      };
      return await storage.createItem("tasks", task);
    }

    case "update_task": {
      const { id, ...updates } = args;
      updates.updated_at = new Date().toISOString();
      if (["in_progress", "completed", "paused"].includes(updates.status)) {
        updates.last_touched_at = new Date().toISOString();
      }
      const result = await storage.updateItem("tasks", id, updates);
      if (!result) return { error: `Task ${id} not found` };

      // Auto-rebuild recurring task when completed
      if (updates.status === "completed" && result.recurrence_rule) {
        const rule = result.recurrence_rule; // "daily:HH:mm" or "weekly:mon,wed:HH:mm"
        const parts = rule.split(":");
        let nextStart = null;
        const now = dayjs();

        if (parts[0] === "daily") {
          const timePart = parts.slice(1).join(":");
          const [hh, mm] = timePart.split(":").map(Number);
          let candidate = now.startOf("day").add(hh, "hour").add(mm || 0, "minute");
          if (candidate.isBefore(now)) candidate = candidate.add(1, "day");
          nextStart = candidate.toISOString();
        } else if (parts[0] === "weekly") {
          const days = parts[1].split(",");
          const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
          const timePart = parts.slice(2).join(":");
          const [hh, mm] = timePart.split(":").map(Number);
          let candidate = null;
          for (let i = 1; i <= 7; i++) {
            const d = now.add(i, "day");
            if (days.includes(dayNames[d.day()])) {
              candidate = d.startOf("day").add(hh, "hour").add(mm || 0, "minute");
              break;
            }
          }
          nextStart = candidate ? candidate.toISOString() : null;
        }

        if (nextStart) {
          const newTask = {
            id: randomUUID(),
            title: result.title,
            project: result.project,
            category: result.category,
            importance: result.importance,
            urgency: result.urgency,
            estimated_duration_min: result.estimated_duration_min,
            hard_deadline: null,
            flexible_deadline: null,
            start_time: nextStart,
            end_time: null,
            execution_mode: result.execution_mode,
            status: "pending",
            recurrence_rule: result.recurrence_rule,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_touched_at: new Date().toISOString(),
            notes: result.notes,
          };
          await storage.createItem("tasks", newTask);
          return { ...result, recurrence_rebuilt: true, next_instance_start: nextStart };
        }
      }

      return result;
    }

    case "list_tasks":
      return await storage.listItems("tasks", args);

    case "delete_task":
      return (await storage.deleteItem("tasks", args.id))
        ? { success: true }
        : { error: `Task ${args.id} not found` };

    case "create_reminder": {
      const reminderType = args.type === "user_rule" ? "task_start" : (args.type || "task_start");
      let taskId = args.task_id || null;

      if (!taskId && ["task_start", "task_deadline"].includes(reminderType)) {
        const triggerAt = args.trigger_at;
        const linkedTask = {
          id: randomUUID(),
          title: args.message,
          project: null,
          category: null,
          importance: "medium",
          urgency: "medium",
          estimated_duration_min: null,
          hard_deadline: reminderType === "task_deadline" ? triggerAt : null,
          flexible_deadline: null,
          start_time: reminderType === "task_start" ? triggerAt : null,
          end_time: null,
          execution_mode: "deferrable",
          status: "pending",
          recurrence_rule: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_touched_at: new Date().toISOString(),
          notes: "auto_created_from_reminder",
        };
        await storage.createItem("tasks", linkedTask);
        taskId = linkedTask.id;
      }

      const reminder = {
        id: randomUUID(),
        task_id: taskId,
        trigger_at: args.trigger_at,
        type: reminderType,
        message: args.message,
        status: "pending",
        repeat_until_confirmed: args.repeat_until_confirmed || false,
        created_at: new Date().toISOString(),
      };
      return await storage.createItem("reminders", reminder);
    }

    case "list_reminders": {
      const all = await storage.listItems("reminders");
      return args.status ? all.filter(r => r.status === args.status) : all;
    }

    case "cancel_reminder": {
      const result = await storage.updateItem("reminders", args.id, { status: "dismissed" });
      return result || { error: `Reminder ${args.id} not found` };
    }

    case "log_timeline": {
      const event = {
        id: randomUUID(),
        start_time: args.start_time,
        end_time: args.end_time || null,
        activity_type: args.activity_type,
        related_task_id: args.related_task_id || null,
        current_active_task: args.current_active_task || null,
        expected_next_action: args.expected_next_action || null,
        checkin_status: "pending",
        interruption_reason: null,
        source: args.source || "ai_inferred",
      };
      return await storage.createItem("timeline", event);
    }

    case "update_timeline": {
      const { id, ...updates } = args;
      const result = await storage.updateItem("timeline", id, updates);
      return result || { error: `Timeline event ${id} not found` };
    }

    case "get_open_timeline": {
      const all = await storage.listItems("timeline");
      // most recent event without end_time
      const open = all
        .filter((e) => !e.end_time)
        .sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
      return open[0] || null;
    }

    case "set_interruptibility": {
      if (args.status === "dnd_until_time" && !args.until) {
        return { error: "dnd_until_time 模式必须提供 until 时间" };
      }
      const state = setState(args.status, {
        until: args.until || null,
        reason: args.reason || null,
        set_by: "user",
      });
      return state;
    }

    case "get_interruptibility":
      return getState();

    // --- Project ---
    case "match_existing_project": {
      const keyword = (args.keyword || "").toLowerCase();
      const all = await storage.listItems("projects");
      const matches = all.filter((p) => {
        const name = (p.name || "").toLowerCase();
        const desc = (p.description || "").toLowerCase();
        return name.includes(keyword) || desc.includes(keyword) || keyword.includes(name);
      });
      if (matches.length === 0) {
        return { matches: [], message: "未找到匹配项目，可以新建。" };
      }
      return {
        matches: matches.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          progress_type: p.progress_type,
          progress_percent: p.progress_percent,
          description: p.description,
        })),
        message: `找到 ${matches.length} 个相关项目，请和用户确认是哪一个还是要新建。`,
      };
    }

    case "create_project": {
      if (!args.confirmed_new) {
        return { error: "必须先和用户确认这是新项目（confirmed_new=true），不能直接创建。先调用 match_existing_project 检查。" };
      }
      const project = {
        id: randomUUID(),
        name: args.name,
        description: args.description || null,
        status: "active",
        progress_type: args.progress_type,
        progress_total: args.progress_total || null,
        progress_unit: args.progress_unit || null,
        progress_done: 0,
        progress_percent: 0,
        progress_stages: args.progress_stages || null,
        progress_current_stage: 0,
        progress_items: args.progress_items || null,
        progress_items_done: null,
        streak_goal: args.streak_goal || null,
        daily_quota: args.daily_quota || null,
        daily_done: 0,
        daily_reset_date: null,
        streak_current: 0,
        streak_longest: 0,
        streak_total: 0,
        last_progress_at: null,
        created_at: new Date().toISOString(),
      };
      return await storage.createItem("projects", project);
    }

    case "update_project_progress": {
      const project = await storage.getItem("projects", args.id);
      if (!project) return { error: `Project ${args.id} not found` };

      const updates = { last_progress_at: new Date().toISOString() };

      if (project.progress_type === "percentage" && args.delta) {
        updates.progress_done = (project.progress_done || 0) + args.delta;
        updates.progress_percent = project.progress_total
          ? Math.min(100, Math.round((updates.progress_done / project.progress_total) * 100))
          : 0;
      }

      if (project.progress_type === "streak") {
        if (args.streak_action === "daily_checkin" && project.daily_quota) {
          const today = dayjs().format("YYYY-MM-DD");
          const dailyDone = project.daily_reset_date === today ? (project.daily_done || 0) : 0;
          updates.daily_done = dailyDone + 1;
          updates.daily_reset_date = today;
          if (updates.daily_done >= project.daily_quota) {
            updates.streak_current = (project.streak_current || 0) + 1;
            updates.streak_total = (project.streak_total || 0) + 1;
            if (updates.streak_current > (project.streak_longest || 0)) {
              updates.streak_longest = updates.streak_current;
            }
          }
          updates.progress_percent = project.streak_goal
            ? Math.min(100, Math.round(((updates.streak_current ?? project.streak_current) / project.streak_goal) * 100))
            : Math.min(100, Math.round((updates.daily_done / project.daily_quota) * 100));
          return {
            ...(await storage.updateItem("projects", args.id, updates, project)),
            daily_done: updates.daily_done,
            daily_quota: project.daily_quota,
            quota_met: updates.daily_done >= project.daily_quota,
          };
        } else if (project.daily_quota) {
          return { error: `「${project.name}」是每日配额项目，请使用 streak_action="daily_checkin"，不要用 "${args.streak_action}"` };
        } else if (args.streak_action === "checkin") {
          updates.streak_current = (project.streak_current || 0) + 1;
          updates.streak_total = (project.streak_total || 0) + 1;
          if (updates.streak_current > (project.streak_longest || 0)) {
            updates.streak_longest = updates.streak_current;
          }
          updates.progress_percent = project.streak_goal
            ? Math.min(100, Math.round((updates.streak_current / project.streak_goal) * 100))
            : 0;
        } else if (args.streak_action === "break") {
          updates.streak_current = 0;
        }
      }

      if (project.progress_type === "stage" && args.advance_to_stage) {
        updates.progress_current_stage = args.advance_to_stage;
        const stages = (project.progress_stages || "").split(",").filter(Boolean);
        updates.progress_percent = stages.length
          ? Math.round((args.advance_to_stage / stages.length) * 100)
          : 0;
      }

      if (project.progress_type === "checklist" && args.check_item) {
        const done = project.progress_items_done
          ? project.progress_items_done.split(",").filter(Boolean)
          : [];
        if (!done.includes(args.check_item)) {
          done.push(args.check_item);
        }
        updates.progress_items_done = done.join(",");
        const total = (project.progress_items || "").split(",").filter(Boolean).length;
        updates.progress_percent = total ? Math.round((done.length / total) * 100) : 0;
      }

      // 写 progress log
      const log = {
        id: randomUUID(),
        project_id: args.id,
        project_name: project.name,
        logged_at: new Date().toISOString(),
        delta: args.note || (
          args.streak_action === "checkin" ? `+1${project.progress_unit || "天"}` :
          args.streak_action === "daily_checkin" ? `+1/${project.daily_quota}` :
          `+${args.delta || ""}${project.progress_unit || ""}`
        ),
        progress_after: updates.progress_percent ?? project.progress_percent,
        note: args.note || null,
      };
      await storage.createItem("progress_logs", log);

      const updated = await storage.updateItem("projects", args.id, updates);
      return updated || { error: "Update failed" };
    }

    case "list_projects":
      return (await storage.listItems("projects")).filter((p) => ["active", "paused"].includes(p.status));

    case "archive_confirmed": {
      const results = [];

      if (args.project_ids) {
        for (const pid of args.project_ids.split(",").map((s) => s.trim())) {
          const p = await storage.updateItem("projects", pid, { status: "archived" });
          if (p) {
            // 归档关联任务
            const tasks = await storage.listItems("tasks", { project: p.name });
            for (const t of tasks) {
              if (t.status !== "completed" && t.status !== "cancelled") {
                await storage.updateItem("tasks", t.id, { status: "cancelled" });
              }
            }
            // 归档关联提醒
            const reminders = (await storage.listItems("reminders")).filter(
              (r) => r.status === "pending" && r.task_id && tasks.some((t) => t.id === r.task_id)
            );
            for (const r of reminders) {
              await storage.updateItem("reminders", r.id, { status: "dismissed" });
            }
            results.push(`项目「${p.name}」已归档`);
          }
        }
      }

      if (args.task_ids) {
        for (const tid of args.task_ids.split(",").map((s) => s.trim())) {
          const t = await storage.updateItem("tasks", tid, { status: "completed" });
          if (t) results.push(`任务「${t.title}」已完成归档`);
        }
      }

      if (args.reminder_ids) {
        for (const rid of args.reminder_ids.split(",").map((s) => s.trim())) {
          const r = await storage.updateItem("reminders", rid, { status: "dismissed" });
          if (r) results.push(`提醒「${r.message?.slice(0, 20)}」已归档`);
        }
      }

      if (args.rule_ids) {
        for (const rid of args.rule_ids.split(",").map((s) => s.trim())) {
          const r = await storage.updateItem("user_rules", rid, { status: "paused" });
          if (r) results.push(`规则「${r.name}」已停用`);
        }
      }

      return { archived: results, context_reset: true };
    }

    // --- User Rule ---
    case "create_user_rule": {
      // "每天/每周" only describes schedule recurrence. Persistence means repeating
      // after the scheduled time until the user confirms, and requires explicit intent.
      let persistence = args.persistence ?? false;
      const isRecurring = /^(daily|weekly):/.test(args.trigger_condition);
      const wantsRepeat = /直到|提醒到|一直提醒|反复提醒|持续提醒/.test(args.message || "");
      if (isRecurring && wantsRepeat && !persistence) {
        persistence = true;
      }
      const rule = {
        id: randomUUID(),
        name: args.name,
        trigger_condition: args.trigger_condition,
        message: args.message,
        persistence,
        repeat_interval_min: args.repeat_interval_min ?? 15,
        stop_condition: args.stop_condition ?? (persistence ? "user_confirms" : "once"),
        status: "active",
        last_triggered_date: null,
        last_fired_at: null,
        confirmed_at: null,
        created_at: new Date().toISOString(),
      };
      return await storage.createItem("user_rules", rule);
    }

    case "list_user_rules":
      return await storage.listItems("user_rules");

    case "update_user_rule": {
      const { id, ...updates } = args;
      const result = await storage.updateItem("user_rules", id, updates);
      return result || { error: `Rule ${id} not found` };
    }

    case "confirm_user_rule": {
      const result = await storage.updateItem("user_rules", args.id, {
        confirmed_at: new Date().toISOString(),
      });
      if (!result) return { error: `Rule ${args.id} not found` };
      return {
        ...result,
        confirmed_today: true,
        note: "规则保持 active 是正常的；confirmed_at 用于停止今天的重复提醒，明天仍会按规则再次生效。",
      };
    }

    // --- File ops ---
    case "read_file": {
      try {
        return { content: readFileSync(args.path, "utf8") };
      } catch (e) {
        return { error: e.message };
      }
    }

    case "write_file": {
      try {
        writeFileSync(args.path, args.content, "utf8");
        return { success: true };
      } catch (e) {
        return { error: e.message };
      }
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
