import dayjs from "dayjs";
import * as storage from "../storage/index.js";

export const OPEN_TIMELINE_MAX_MIN = 4 * 60;

function isOpenEvent(event) {
  return event && event.id && event.start_time && !event.end_time && dayjs(event.start_time).isValid();
}

function eventLabel(event) {
  return event.current_active_task || event.activity_type || "other";
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, "").toLowerCase();
}

function isSameOpenActivity(existing, next) {
  return existing.activity_type === next.activity_type
    && normalizeText(existing.current_active_task) === normalizeText(next.current_active_task);
}

function closePatch(event, endTime, status, reason) {
  const patch = { end_time: endTime };
  if (!event.checkin_status || event.checkin_status === "pending") {
    patch.checkin_status = status;
  }
  if (!event.interruption_reason) {
    patch.interruption_reason = reason;
  }
  return patch;
}

export async function normalizeOpenTimelineEvents(timeline = null) {
  const items = timeline ?? await storage.listItems("timeline");
  const open = items
    .filter(isOpenEvent)
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  const now = dayjs();
  const updates = new Map();

  for (let i = 0; i < open.length; i++) {
    const event = open[i];
    const startedAt = dayjs(event.start_time);
    const next = open[i + 1];

    let patch = null;
    if (next && dayjs(next.start_time).isAfter(startedAt)) {
      patch = closePatch(
        event,
        dayjs(next.start_time).toISOString(),
        "interrupted",
        `switched_to:${eventLabel(next)}`
      );
    } else if (now.diff(startedAt, "minute") > OPEN_TIMELINE_MAX_MIN) {
      patch = closePatch(
        event,
        startedAt.add(OPEN_TIMELINE_MAX_MIN, "minute").toISOString(),
        "abandoned",
        "auto_closed_stale"
      );
    }

    if (patch) {
      updates.set(event.id, patch);
      await storage.updateItem("timeline", event.id, patch, event);
    }
  }

  if (!updates.size) return items;
  return items.map((event) => updates.has(event.id) ? { ...event, ...updates.get(event.id) } : event);
}

export async function closeOpenTimelineBefore(nextEvent) {
  const startAt = dayjs(nextEvent.start_time);
  const closeAt = startAt.isValid() ? startAt : dayjs();
  const items = await normalizeOpenTimelineEvents(await storage.listItems("timeline"));
  const open = items
    .filter(isOpenEvent)
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
  const latest = open[0] || null;

  if (latest) {
    const latestStartedAt = dayjs(latest.start_time);
    const stillFresh = dayjs().diff(latestStartedAt, "minute") <= OPEN_TIMELINE_MAX_MIN;
    if (stillFresh && isSameOpenActivity(latest, nextEvent)) {
      return latest;
    }
  }

  for (const event of open) {
    const startedAt = dayjs(event.start_time);
    const endTime = closeAt.isAfter(startedAt) ? closeAt : dayjs();
    const patch = closePatch(
      event,
      endTime.toISOString(),
      "interrupted",
      `switched_to:${eventLabel(nextEvent)}`
    );
    await storage.updateItem("timeline", event.id, patch, event);
  }

  return null;
}
