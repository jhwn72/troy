// Dashboard texts held for quiet hours or pause are delivered later, not dropped.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { MessagingAdapter } from "../src/types.ts";
import { openDb, getOrCreateUser, updateUser } from "../src/db/index.ts";
import { createNotifier } from "../src/outbox.ts";

function setup() {
  const db = openDb(":memory:");
  const sent: { chatId: string; text: string }[] = [];
  let n = 0;
  const adapter = {
    async sendMessage(chatId: string, text: string) {
      sent.push({ chatId, text });
      return { messageId: `out-${++n}` };
    },
  } as unknown as MessagingAdapter;
  const clock = { now: new Date("2026-11-15T10:00:00Z") }; // 02:00 in Los Angeles
  const u = getOrCreateUser(db, "+12135550150", "chat-1");
  updateUser(db, u.id, { verifiedAt: Date.now(), quietHours: JSON.stringify({ start: "23:00", end: "08:00" }) });
  const notifier = createNotifier({ db, getAdapter: () => adapter, enabled: () => true, now: () => clock.now });
  const queued = () => (db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n;
  return { db, sent, clock, id: u.id, queued, ...notifier };
}

test("a status update during quiet hours waits and is sent, in order, when they end", async () => {
  const t = setup();
  assert.equal(await t.notify(t.id, ["facilities picked it up"]), true, "held, not lost");
  assert.equal(await t.notify(t.id, ["it's fixed"]), true);
  assert.equal(t.sent.length, 0);
  assert.equal(t.queued(), 2);
  assert.equal(await t.flush(), 0, "still quiet hours");

  t.clock.now = new Date("2026-11-15T17:00:00Z"); // 09:00 in Los Angeles
  assert.equal(await t.flush(), 2);
  assert.deepEqual(t.sent.map((s) => s.text), ["facilities picked it up", "it's fixed"]);
  assert.equal(t.queued(), 0);
});

test("a paused person gets held texts after resume, and a stopped person never does", async () => {
  const t = setup();
  t.clock.now = new Date("2026-11-15T20:00:00Z");
  updateUser(t.db, t.id, { paused: 1 });
  await t.notify(t.id, ["on the agenda"]);
  assert.equal(t.sent.length, 0);
  updateUser(t.db, t.id, { paused: 0 });
  await t.flush();
  assert.deepEqual(t.sent.map((s) => s.text), ["on the agenda"]);

  updateUser(t.db, t.id, { paused: 1 });
  await t.notify(t.id, ["closed"]);
  updateUser(t.db, t.id, { stopped: 1 });
  assert.equal(await t.notify(t.id, ["anything"]), false);
  await t.flush();
  assert.equal(t.sent.length, 1);
  assert.equal(t.queued(), 0, "nothing waits for someone who opted out");
});

test("a text the person is owed right now is not held by quiet hours", async () => {
  const t = setup();
  assert.equal(await t.notify(t.id, ["love that"], { owed: true }), true);
  assert.deepEqual(t.sent.map((s) => s.text), ["love that"]);
});
