import { test } from "node:test";
import assert from "node:assert/strict";
import type { User } from "../src/types.ts";
import { canAlert, inQuietHours, laMinutes, minutesOfDay } from "../src/quiet.ts";

function user(over: Partial<User> = {}): User {
  return {
    id: 1,
    handle: "+12135550100",
    chatId: "chat-1",
    name: null,
    uscEmail: null,
    verifiedAt: 1,
    verifiedVia: "usc_email",
    contactMode: "direct",
    groupChatsAllowed: true,
    subscriptions: [],
    usualSpots: [],
    alertMinutes: 15,
    quietHours: null,
    bannedFromPosting: false,
    paused: false,
    stopped: false,
    createdAt: 1,
    ...over,
  };
}

// November 14, 2026 is Pacific Standard Time (UTC-8). July is Pacific Daylight Time (UTC-7).
const pst = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 14, h + 8, m));
const pdt = (h: number, m = 0) => new Date(Date.UTC(2026, 6, 14, h + 7, m));

test("minutesOfDay reads HH:MM and rejects junk", () => {
  assert.equal(minutesOfDay("00:00"), 0);
  assert.equal(minutesOfDay("23:59"), 1439);
  assert.equal(minutesOfDay("8:05"), 485);
  assert.equal(minutesOfDay("24:00"), null);
  assert.equal(minutesOfDay("11pm"), null);
  assert.equal(minutesOfDay(""), null);
});

test("laMinutes is Los Angeles time in winter and summer", () => {
  assert.equal(laMinutes(pst(23, 30)), 23 * 60 + 30);
  assert.equal(laMinutes(pst(0, 5)), 5);
  assert.equal(laMinutes(pdt(7, 15)), 7 * 60 + 15);
});

test("no quiet hours means never quiet", () => {
  assert.equal(inQuietHours(user(), pst(3)), false);
});

test("a window that crosses midnight", () => {
  const u = user({ quietHours: { start: "23:00", end: "08:00" } });
  assert.equal(inQuietHours(u, pst(22, 59)), false);
  assert.equal(inQuietHours(u, pst(23, 0)), true);
  assert.equal(inQuietHours(u, pst(0, 0)), true);
  assert.equal(inQuietHours(u, pst(3, 30)), true);
  assert.equal(inQuietHours(u, pst(7, 59)), true);
  assert.equal(inQuietHours(u, pst(8, 0)), false);
  assert.equal(inQuietHours(u, pst(14, 0)), false);
  assert.equal(inQuietHours(u, pdt(2, 0)), true);
  assert.equal(inQuietHours(u, pdt(12, 0)), false);
});

test("a window that starts at midnight", () => {
  const u = user({ quietHours: { start: "00:00", end: "08:00" } });
  assert.equal(inQuietHours(u, pst(23, 59)), false);
  assert.equal(inQuietHours(u, pst(0, 0)), true);
  assert.equal(inQuietHours(u, pst(7, 59)), true);
  assert.equal(inQuietHours(u, pst(8, 0)), false);
});

test("a window inside one day", () => {
  const u = user({ quietHours: { start: "13:00", end: "15:30" } });
  assert.equal(inQuietHours(u, pst(12, 59)), false);
  assert.equal(inQuietHours(u, pst(13, 0)), true);
  assert.equal(inQuietHours(u, pst(15, 29)), true);
  assert.equal(inQuietHours(u, pst(15, 30)), false);
});

test("a broken or empty window is treated as off", () => {
  assert.equal(inQuietHours(user({ quietHours: { start: "22:00", end: "22:00" } }), pst(22)), false);
  assert.equal(inQuietHours(user({ quietHours: { start: "late", end: "08:00" } }), pst(2)), false);
});

test("canAlert: not stopped, not paused, not in quiet hours", () => {
  const quiet = { start: "23:00", end: "08:00" };
  assert.equal(canAlert(user(), pst(2)), true);
  assert.equal(canAlert(user({ stopped: true }), pst(14)), false);
  assert.equal(canAlert(user({ paused: true }), pst(14)), false);
  assert.equal(canAlert(user({ quietHours: quiet }), pst(2)), false);
  assert.equal(canAlert(user({ quietHours: quiet }), pst(14)), true);
});

test("both default to the current time", () => {
  assert.equal(typeof inQuietHours(user({ quietHours: { start: "23:00", end: "08:00" } })), "boolean");
  assert.equal(canAlert(user({ stopped: true })), false);
});
