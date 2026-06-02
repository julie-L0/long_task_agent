import dayjs from "dayjs";

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LABELS = {
  sun: "周日",
  mon: "周一",
  tue: "周二",
  wed: "周三",
  thu: "周四",
  fri: "周五",
  sat: "周六",
};

export function parseRuleTrigger(triggerCondition) {
  if (!triggerCondition || triggerCondition === "persona") return null;

  const parts = String(triggerCondition).split(":");
  const type = parts[0];

  let days = null;
  let triggerTime = null;
  if (type === "daily") {
    triggerTime = parts.slice(1).join(":");
  } else if (type === "weekly") {
    days = (parts[1] || "").split(",").filter(Boolean);
    triggerTime = parts.slice(2).join(":");
    if (!days.length) return null;
  } else {
    return null;
  }

  if (!/^\d{1,2}:\d{2}$/.test(triggerTime)) return null;
  const [hour, minute] = triggerTime.split(":").map(Number);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return { type, days, hour, minute };
}

export function ruleTriggerAt(rule, date) {
  const parsed = parseRuleTrigger(rule.trigger_condition);
  if (!parsed) return null;

  const d = dayjs(date);
  if (!d.isValid()) return null;
  if (parsed.type === "weekly" && !parsed.days.includes(DAY_NAMES[d.day()])) return null;

  return d.startOf("day").hour(parsed.hour).minute(parsed.minute).second(0).millisecond(0);
}

function isConfirmedOn(rule, date) {
  return rule.confirmed_at && dayjs(rule.confirmed_at).isSame(date, "day");
}

export function isRuleOccurrenceDone(rule, triggerAt) {
  const date = dayjs(triggerAt);
  const dateKey = date.format("YYYY-MM-DD");
  if (isConfirmedOn(rule, date)) return true;
  if (rule.last_triggered_date !== dateKey) return false;
  return !(rule.persistence && rule.stop_condition === "user_confirms");
}

export function shouldTriggerUserRule(rule, now = dayjs()) {
  const triggerAt = ruleTriggerAt(rule, now);
  if (!triggerAt) {
    console.warn(`[scheduler] invalid user rule trigger_condition: ${rule.trigger_condition} (${rule.id})`);
    return false;
  }
  if (now.isBefore(triggerAt)) return false;
  if (isConfirmedOn(rule, now)) return false;

  const today = now.format("YYYY-MM-DD");
  if (rule.last_triggered_date !== today) return true;

  if (rule.persistence && rule.stop_condition === "user_confirms") {
    const lastFired = rule.last_fired_at ? dayjs(rule.last_fired_at) : null;
    if (!lastFired) return true;
    return now.diff(lastFired, "minute") >= (rule.repeat_interval_min ?? 15);
  }

  return false;
}

export function ruleOccurrencesInRange(rule, start, end, now = dayjs()) {
  if (rule.status !== "active" || rule.trigger_condition === "persona") return [];

  const rangeStart = dayjs(start).startOf("day");
  const rangeEnd = dayjs(end).endOf("day");
  const occurrences = [];

  for (let d = rangeStart; d.isBefore(rangeEnd) || d.isSame(rangeEnd, "day"); d = d.add(1, "day")) {
    const triggerAt = ruleTriggerAt(rule, d);
    if (!triggerAt || triggerAt.isAfter(rangeEnd)) continue;
    if (triggerAt.isBefore(now) && isRuleOccurrenceDone(rule, triggerAt)) continue;
    occurrences.push({ rule, trigger_at: triggerAt.toISOString() });
  }

  return occurrences;
}

export function formatRuleSchedule(rule) {
  const parsed = parseRuleTrigger(rule.trigger_condition);
  if (!parsed) return null;

  const time = `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
  if (parsed.type === "daily") return `每天 ${time}`;
  return `每周${parsed.days.map((d) => DAY_LABELS[d] || d).join("、")} ${time}`;
}

export function isDailyRule(rule) {
  return parseRuleTrigger(rule.trigger_condition)?.type === "daily";
}
