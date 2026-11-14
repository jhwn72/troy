// Quiet hours and alert checks. Alerts (texts Troy starts on his own) go through canAlert.
// Replies to a student's own request are never blocked by quiet hours.

import type { User } from "./types.ts";

export const QUIET_TIME_ZONE = "America/Los_Angeles";

const LA_CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: QUIET_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "HH:MM" as minutes after midnight, or null when it isn't a real time. */
export function minutesOfDay(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes after midnight in Los Angeles at the given moment. */
export function laMinutes(now: Date = new Date()): number {
  let h = 0;
  let m = 0;
  for (const part of LA_CLOCK.formatToParts(now)) {
    if (part.type === "hour") h = Number(part.value) % 24;
    if (part.type === "minute") m = Number(part.value);
  }
  return h * 60 + m;
}

/**
 * True when `now` (Los Angeles time) falls inside the user's quiet hours. The start is included and the
 * end is not. Windows that cross midnight ("23:00" to "08:00") work. No window, a broken one, or one
 * whose start equals its end counts as no quiet hours.
 */
export function inQuietHours(user: Pick<User, "quietHours">, now: Date = new Date()): boolean {
  const q = user.quietHours;
  if (!q) return false;
  const start = minutesOfDay(q.start);
  const end = minutesOfDay(q.end);
  if (start === null || end === null || start === end) return false;
  const cur = laMinutes(now);
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** May Troy send this user an alert right now? Not stopped, not paused, not in quiet hours. */
export function canAlert(user: Pick<User, "quietHours" | "stopped" | "paused">, now: Date = new Date()): boolean {
  return !user.stopped && !user.paused && !inQuietHours(user, now);
}
