import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, getSetting } from "../src/db/index.ts";
import { isEnabled } from "../src/config.ts";
import { createWebRoutes, maskHandle, reportReference, resolvePhoto } from "../src/web/api.ts";
import type { MessagingAdapter } from "../src/types.ts";
import { createTopic, listTopics, saveTopicRequest } from "../src/topics.ts";
import { notifyStaffOfReport, staffLogFor } from "../src/staff.ts";

type Json = Record<string, any>;

function setup() {
  const db = openDb(":memory:");
  const sent: { userId: number; bubbles: string[] }[] = [];
  const app = createWebRoutes({
    db,
    getAdapter: () => {
      throw new Error("no adapter in tests");
    },
    notify: async (userId, bubbles) => void sent.push({ userId, bubbles }),
  } as { db: typeof db; getAdapter: () => MessagingAdapter; notify: (userId: number, bubbles: string[]) => Promise<void> });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Json };
  };
  const user = (handle: string, name: string) =>
    Number(db.prepare("INSERT INTO users (handle, chatId, name, createdAt) VALUES (?, ?, ?, ?)").run(handle, `chat;${handle}`, name, Date.now()).lastInsertRowid);
  return { db, sent, app, call, user };
}

// Example data for tests only.
const HIDDEN_DETAIL = "sticker of a corgi on the back";
const HIDDEN_NAME = "Example Student";
const OWNER_ANSWER = "it has a corgi sticker";

function seedLostFound(t: ReturnType<typeof setup>, opts: { heldBy?: "dps" | "finder"; createdAt?: number } = {}) {
  const finder = t.user("+12135550101", "Fiona Finder");
  const owner = t.user("+12135550102", "Omar Owner");
  const profile = {
    category: "earbuds",
    title: "black airpods case",
    brand: "apple",
    color: "black",
    publicSummary: "black airpods case",
    distinguishing: [HIDDEN_DETAIL],
    nameOnItem: HIDDEN_NAME,
    isValuable: true,
    isDangerous: false,
  };
  const createdAt = opts.createdAt ?? Date.now();
  const foundId = Number(
    t.db
      .prepare("INSERT INTO listings (userId, type, category, title, details, locationText, status, heldBy, createdAt) VALUES (?, 'found', 'earbuds', ?, ?, 'leavey library', 'verified', ?, ?)")
      .run(finder, profile.title, JSON.stringify(profile), opts.heldBy ?? "dps", createdAt).lastInsertRowid,
  );
  const lostId = Number(
    t.db
      .prepare("INSERT INTO listings (userId, type, category, title, details, status, createdAt) VALUES (?, 'lost', 'earbuds', 'lost airpods', ?, 'verified', ?)")
      .run(owner, JSON.stringify({ category: "earbuds", description: "my airpods with a corgi sticker", color: "black", brand: null, locationText: null, happenedAt: null }), createdAt).lastInsertRowid,
  );
  const matchId = Number(
    t.db
      .prepare("INSERT INTO matches (foundListingId, lostListingId, confidence, reasons, source, status, createdAt) VALUES (?, ?, 88, ?, 'fallback', 'verified', ?)")
      .run(foundId, lostId, JSON.stringify(["same category", "same color"]), createdAt).lastInsertRowid,
  );
  t.db.prepare("INSERT INTO verifications (matchId, method, ownerAnswer, score, result, attempts, createdAt) VALUES (?, 'blind_description', ?, 90, 'pass', 1, ?)").run(matchId, OWNER_ANSWER, createdAt);
  const handoffId = Number(t.db.prepare("INSERT INTO handoffs (matchId, method, pickupCode, createdAt) VALUES (?, 'dps_code', 'K7M4XQ', ?)").run(matchId, createdAt).lastInsertRowid);
  return { finder, owner, foundId, lostId, matchId, handoffId };
}

test("every list endpoint answers on an empty database", async () => {
  const t = setup();
  for (const path of ["/api/panel", "/api/panel?staff=1", "/api/dps", "/api/reports?kind=repair", "/api/reports?kind=usg_concern", "/api/moderation", "/api/settings", "/api/settings/allow-list", "/api/directory", "/api/eval", "/api/staff"]) {
    const res = await t.call("GET", path);
    assert.equal(res.status, 200, path);
    assert.equal(res.json.ok, true, path);
  }
  const panel = (await t.call("GET", "/api/panel")).json;
  assert.deepEqual(panel.listings, []);
  assert.deepEqual(panel.matches, []);
  assert.deepEqual(panel.foodDrops, []);
  assert.equal((await t.call("GET", "/api/reports?kind=nope")).status, 400);
});

test("hidden fields are absent outside the staff key", async () => {
  const t = setup();
  seedLostFound(t);

  const pub = await t.call("GET", "/api/panel");
  assert.equal(pub.json.staff, undefined);
  const text = JSON.stringify(pub.json);
  for (const secret of [HIDDEN_DETAIL, HIDDEN_NAME, OWNER_ANSWER, "K7M4XQ", "my airpods with a corgi sticker", "+12135550101", "distinguishing", "nameOnItem"]) {
    assert.equal(text.includes(secret), false, `public panel leaked: ${secret}`);
  }
  assert.equal(pub.json.listings.length, 2);
  assert.equal(pub.json.listings.find((l: Json) => l.type === "found").publicSummary, "black airpods case");
  assert.equal(pub.json.matches[0].confidence, 88);
  assert.deepEqual(pub.json.matches[0].reasons, ["same category", "same color"]);
  assert.equal(pub.json.matches[0].source, "fallback");
  assert.equal(pub.json.verifications[0].score, 90);
  assert.equal(pub.json.verifications[0].result, "pass");
  assert.equal(pub.json.handoffs[0].hasPickupCode, true);

  const staff = await t.call("GET", "/api/panel?staff=1");
  const { staff: staffKey, ...rest } = staff.json;
  const restText = JSON.stringify(rest);
  for (const secret of [HIDDEN_DETAIL, HIDDEN_NAME, OWNER_ANSWER, "K7M4XQ"]) assert.equal(restText.includes(secret), false, `leaked outside staff key: ${secret}`);
  const found = staff.json.listings.find((l: Json) => l.type === "found");
  assert.deepEqual(staffKey.listings[found.id], { distinguishing: [HIDDEN_DETAIL], nameOnItem: HIDDEN_NAME });
  assert.equal(staffKey.verifications[staff.json.verifications[0].id].ownerAnswer, OWNER_ANSWER);
  assert.equal(staffKey.handoffs[staff.json.handoffs[0].id].pickupCode, "K7M4XQ");

  // The DPS and code-check endpoints carry no hidden details either.
  const dps = JSON.stringify((await t.call("GET", "/api/dps")).json);
  const check = JSON.stringify((await t.call("POST", "/api/dps/check-code", { code: "K7M4XQ" })).json);
  for (const secret of [HIDDEN_DETAIL, HIDDEN_NAME, OWNER_ANSWER]) {
    assert.equal(dps.includes(secret), false);
    assert.equal(check.includes(secret), false);
  }
});

test("panel shows food drop counts and claims", async () => {
  const t = setup();
  const poster = t.user("+12135550103", "Pat Poster");
  const dropId = Number(t.db.prepare("INSERT INTO food_drops (posterUserId, clubName, description, servingsTotal, servingsLeft, createdAt) VALUES (?, 'example club', 'pizza', 10, 7, ?)").run(poster, Date.now()).lastInsertRowid);
  const now = Date.now();
  t.db.prepare("INSERT INTO claims (foodDropId, userId, status, heldUntil, createdAt) VALUES (?, ?, 'held', ?, ?)").run(dropId, poster, now, now);
  t.db.prepare("INSERT INTO claims (foodDropId, userId, status, heldUntil, createdAt) VALUES (?, ?, 'held', ?, ?)").run(dropId, poster, now, now);
  t.db.prepare("INSERT INTO claims (foodDropId, userId, status, heldUntil, createdAt) VALUES (?, ?, 'picked_up', ?, ?)").run(dropId, poster, now, now);
  const drop = (await t.call("GET", "/api/panel")).json.foodDrops[0];
  assert.equal(drop.servingsLeft, 7);
  assert.equal(drop.servingsTotal, 10);
  assert.deepEqual(drop.claims, { held: 2, picked_up: 1, released: 0 });
});

test("DPS: custody list ages items against the 90-day hold", async () => {
  const t = setup();
  const day = 24 * 60 * 60 * 1000;
  seedLostFound(t, { createdAt: Date.now() - 30 * day - 1000 });
  const res = await t.call("GET", "/api/dps");
  assert.equal(res.json.holdDays, 90);
  assert.equal(res.json.items.length, 1);
  assert.equal(res.json.items[0].daysHeld, 30);
  assert.equal(res.json.items[0].daysLeft, 60);
  assert.equal(res.json.items[0].holdExpired, false);

  const finderHeld = setup();
  seedLostFound(finderHeld, { heldBy: "finder" });
  assert.equal((await finderHeld.call("GET", "/api/dps")).json.items.length, 0);
});

test("DPS: code check finds the handoff, and complete marks it picked up", async () => {
  const t = setup();
  const s = seedLostFound(t);

  const miss = await t.call("POST", "/api/dps/check-code", { code: "ZZZZZZ" });
  assert.equal(miss.status, 200);
  assert.equal(miss.json.found, false);
  assert.equal((await t.call("POST", "/api/dps/check-code", {})).status, 400);

  const hit = await t.call("POST", "/api/dps/check-code", { code: " k7m4-xq " });
  assert.equal(hit.json.found, true);
  assert.equal(hit.json.alreadyCompleted, false);
  assert.equal(hit.json.handoff.id, s.handoffId);
  assert.equal(hit.json.handoff.item.publicSummary, "black airpods case");
  assert.equal(hit.json.handoff.ownerFirstName, "Omar");

  const done = await t.call("POST", "/api/dps/complete", { handoffId: s.handoffId });
  assert.equal(done.json.ok, true);
  assert.equal(done.json.alreadyCompleted, false);
  assert.ok(done.json.handoff.completedAt);
  const statuses = t.db.prepare("SELECT status FROM listings ORDER BY id").all().map((r) => r.status);
  assert.deepEqual(statuses, ["returned", "returned"]);

  const again = await t.call("POST", "/api/dps/complete", { handoffId: s.handoffId });
  assert.equal(again.json.alreadyCompleted, true);
  assert.equal(again.json.handoff.completedAt, done.json.handoff.completedAt);
  assert.equal((await t.call("POST", "/api/dps/check-code", { code: "K7M4XQ" })).json.alreadyCompleted, true);
  assert.equal((await t.call("POST", "/api/dps/complete", { handoffId: 999 })).status, 404);
});

test("report status: validated per kind, saved, and texted to the reporter and every follower", async () => {
  const t = setup();
  const reporter = t.user("+12135550101", "Rae Reporter");
  const f1 = t.user("+12135550102", "Fay Follower");
  const f2 = t.user("+12135550103", "Finn Follower");
  const repairId = Number(
    t.db
      .prepare("INSERT INTO reports (userId, kind, category, description, locationText, routedTo, followers, createdAt) VALUES (?, 'repair', 'elevator', 'Elevator stuck on 2', 'Leavey Library', 'FMS', ?, ?)")
      .run(reporter, JSON.stringify([f1, f2, reporter]), Date.now()).lastInsertRowid,
  );
  const usgId = Number(
    t.db
      .prepare("INSERT INTO reports (userId, kind, anonymous, description, routedTo, createdAt) VALUES (?, 'usg_concern', 1, 'why does village dining close so early', 'Example dining committee', ?)")
      .run(reporter, Date.now()).lastInsertRowid,
  );

  // wrong status for the kind, unknown status, unknown report
  for (const bad of ["on_agenda", "acted_on", "nonsense", ""]) {
    const res = await t.call("POST", `/api/reports/${repairId}/status`, { status: bad });
    assert.equal(res.status, 400, bad);
    assert.equal(res.json.error, "bad_status");
  }
  assert.equal((await t.call("POST", `/api/reports/${usgId}/status`, { status: "fixed" })).status, 400);
  assert.equal((await t.call("POST", "/api/reports/999/status", { status: "fixed" })).status, 404);
  assert.equal(t.sent.length, 0);
  assert.equal(t.db.prepare("SELECT status FROM reports WHERE id = ?").get(repairId)!.status, "received");

  const res = await t.call("POST", `/api/reports/${repairId}/status`, { status: "in_progress" });
  assert.equal(res.json.changed, true);
  assert.equal(res.json.notified, 3);
  assert.equal(t.db.prepare("SELECT status FROM reports WHERE id = ?").get(repairId)!.status, "in_progress");
  assert.deepEqual(t.sent.map((s) => s.userId).sort(), [reporter, f1, f2].sort());
  for (const s of t.sent) assert.deepEqual(s.bubbles, ['update on "elevator stuck on 2" at leavey library: in progress 🔧']);

  // same status again: nothing new is sent
  t.sent.length = 0;
  const same = await t.call("POST", `/api/reports/${repairId}/status`, { status: "in_progress" });
  assert.equal(same.json.changed, false);
  assert.equal(t.sent.length, 0);

  await t.call("POST", `/api/reports/${repairId}/status`, { status: "fixed" });
  assert.equal(t.sent.length, 3);
  assert.ok(t.sent[0].bubbles[0].endsWith(": fixed ✅"));

  t.sent.length = 0;
  await t.call("POST", `/api/reports/${usgId}/status`, { status: "on_agenda" });
  assert.deepEqual(t.sent, [{ userId: reporter, bubbles: ['update on the usg concern "why does village dining close so early": on the agenda'] }]);
  t.sent.length = 0;
  await t.call("POST", `/api/reports/${usgId}/status`, { status: "acted_on" });
  assert.ok(t.sent[0].bubbles[0].endsWith(": acted on ✅"));

  // grouped by routedTo; an anonymous concern never names the reporter
  const repairs = (await t.call("GET", "/api/reports?kind=repair")).json;
  assert.deepEqual(repairs.groups.map((g: Json) => g.routedTo), ["FMS"]);
  assert.equal(repairs.groups[0].reports[0].status, "fixed");
  assert.equal(repairs.groups[0].reports[0].followerCount, 3);
  assert.equal(repairs.groups[0].reports[0].reporterFirstName, "Rae");
  const usg = (await t.call("GET", "/api/reports?kind=usg_concern")).json;
  assert.equal(usg.groups[0].routedTo, "Example dining committee");
  assert.equal(usg.groups[0].reports[0].reporterFirstName, null);
  assert.equal(JSON.stringify(usg).includes("Rae"), false);
});

test("a failed text does not block the status change or the other followers", async () => {
  const db = openDb(":memory:");
  const got: number[] = [];
  const app = createWebRoutes({
    db,
    getAdapter: () => {
      throw new Error("unused");
    },
    notify: async (userId) => {
      if (userId === 1) throw new Error("send failed");
      got.push(userId);
    },
  });
  db.prepare("INSERT INTO users (handle, chatId, createdAt) VALUES ('+12135550101', 'a', 1), ('+12135550102', 'b', 1)").run();
  db.prepare("INSERT INTO reports (userId, kind, description, followers, createdAt) VALUES (1, 'repair', 'broken light', '[2]', 1)").run();
  const res = await app.request("/api/reports/1/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "fixed" }) });
  const json = (await res.json()) as Json;
  assert.equal(json.ok, true);
  assert.equal(json.notified, 1);
  assert.equal(json.failed, 1);
  assert.deepEqual(got, [2]);
});

test("status copy has no em dashes and reads in lowercase", () => {
  const ref = reportReference({ kind: "repair", category: "Door", description: "Door won't lock — 3rd floor", locationText: "Fertitta Hall" });
  assert.equal(ref, 'update on "door won\'t lock - 3rd floor" at fertitta hall');
  assert.equal(reportReference({ kind: "repair", category: null, description: null, locationText: null }), "update on the repair report");
  assert.equal(reportReference({ kind: "usg_concern", category: null, description: null, locationText: null }), "update on the usg concern");
});

test("dashboard writes from another site are refused; same-origin and no-Origin requests work", async () => {
  const t = setup();
  const post = (path: string, body: unknown, headers: Record<string, string>) =>
    t.app.request(`http://localhost:3417${path}`, { method: "POST", headers: { host: "localhost:3417", ...headers }, body: JSON.stringify(body) });
  const cap = async () => (await t.call("GET", "/api/settings")).json.signups.max;
  const start = await cap();
  // What a web page on another site can send without a preflight.
  for (const origin of ["https://evil.example", "http://localhost:9999", "null"]) {
    for (const [path, body] of [["/api/settings/cap", { max: 7 }], ["/api/settings/signups", { open: false }], ["/api/settings/enabled", { enabled: false }]] as const) {
      const res = await post(path, body, { origin, "content-type": "text/plain" });
      assert.equal(res.status, 403, `${origin} ${path}`);
    }
  }
  const del = await t.app.request("http://localhost:3417/api/settings/allow-list", { method: "DELETE", headers: { host: "localhost:3417", origin: "https://evil.example" } });
  assert.equal(del.status, 403);
  const now = (await t.call("GET", "/api/settings")).json;
  assert.equal(now.signups.max, start);
  assert.equal(now.signups.open, true);
  assert.equal(now.settingOn, true);
  // The dashboard itself (same origin) and tools with no Origin still work. Reads are never blocked.
  assert.equal((await post("/api/settings/cap", { max: 7 }, { origin: "http://localhost:3417", "content-type": "application/json" })).status, 200);
  assert.equal(await cap(), 7);
  assert.equal((await post("/api/settings/cap", { max: 8 }, { "content-type": "application/json" })).status, 200);
  assert.equal((await t.app.request("http://localhost:3417/api/settings", { headers: { host: "localhost:3417", origin: "https://evil.example" } })).status, 200);
});

test("sign-up switch and cap: defaults, round trip, clamping, bad bodies, live count", async () => {
  const t = setup();
  const before = { s: process.env.TROY_SIGNUPS, m: process.env.TROY_MAX_USERS };
  delete process.env.TROY_SIGNUPS;
  delete process.env.TROY_MAX_USERS;
  try {
    assert.deepEqual((await t.call("GET", "/api/settings")).json.signups, { open: true, max: 40, count: 0, judges: { max: 20, count: 0 } });

    const closed = await t.call("POST", "/api/settings/signups", { open: false });
    assert.equal(closed.status, 200);
    assert.deepEqual(closed.json.signups, { open: false, max: 40, count: 0, judges: { max: 20, count: 0 } });
    assert.equal((await t.call("GET", "/api/settings")).json.signups.open, false);
    assert.equal((await t.call("POST", "/api/settings/signups", { open: true })).json.signups.open, true);
    for (const bad of [{}, { open: "false" }, { open: 0 }, { open: null }]) assert.equal((await t.call("POST", "/api/settings/signups", bad)).status, 400);
    assert.equal((await t.call("GET", "/api/settings")).json.signups.open, true);

    const cap = await t.call("POST", "/api/settings/cap", { max: 30 });
    assert.equal(cap.json.max, 30);
    assert.equal(cap.json.signups.max, 30);
    assert.equal((await t.call("GET", "/api/settings")).json.signups.max, 30);
    assert.equal((await t.call("POST", "/api/settings/cap", { max: 9999 })).json.signups.max, 500);
    assert.equal((await t.call("POST", "/api/settings/cap", { max: -10 })).json.signups.max, 0);
    assert.equal((await t.call("POST", "/api/settings/cap", { max: 12.6 })).json.signups.max, 13);
    for (const bad of [{}, { max: "30" }, { max: null }, { cap: 30 }]) assert.equal((await t.call("POST", "/api/settings/cap", bad)).status, 400);
    assert.equal((await t.call("GET", "/api/settings")).json.signups.max, 13);

    // count: only chats let in by the opt-in phrase. Manual entries and Troy's groups never count.
    const add = t.db.prepare("INSERT INTO allow_list (handle, chatId, reason, addedAt) VALUES (?, ?, ?, ?)");
    add.run("+12135550111", "any;-;+12135550111", "opt_in_phrase", Date.now());
    add.run("+12135550112", "any;-;+12135550112", "opt_in_phrase", Date.now());
    add.run("+12135550113", null, "manual", Date.now());
    add.run(null, "any;+;chat5", "troy_group", Date.now());
    assert.deepEqual((await t.call("GET", "/api/settings")).json.signups, { open: true, max: 13, count: 2, judges: { max: 20, count: 0 } });
    // Put on the manual list from the dashboard after opting in by phrase: no longer takes a seat.
    assert.equal((await t.call("POST", "/api/settings/allow-list", { handle: "+12135550111" })).status, 200);
    assert.equal((await t.call("GET", "/api/settings")).json.signups.count, 1);
  } finally {
    if (before.s === undefined) delete process.env.TROY_SIGNUPS;
    else process.env.TROY_SIGNUPS = before.s;
    if (before.m === undefined) delete process.env.TROY_MAX_USERS;
    else process.env.TROY_MAX_USERS = before.m;
  }
});

test("kill switch toggle", async () => {
  const t = setup();
  const before = process.env.TROY_ENABLED;
  delete process.env.TROY_ENABLED;
  try {
    assert.equal((await t.call("GET", "/api/settings")).json.enabled, true);

    const off = await t.call("POST", "/api/settings/enabled", { enabled: false });
    assert.equal(off.json.enabled, false);
    assert.equal(off.json.settingOn, false);
    assert.equal(getSetting(t.db, "troy_enabled"), "false");
    assert.equal(isEnabled(t.db), false);
    assert.equal((await t.call("GET", "/api/panel")).json.enabled, false);

    const on = await t.call("POST", "/api/settings/enabled", { enabled: true });
    assert.equal(on.json.enabled, true);
    assert.equal(isEnabled(t.db), true);

    // anything that is not a boolean is refused and changes nothing
    assert.equal((await t.call("POST", "/api/settings/enabled", { enabled: "false" })).status, 400);
    assert.equal((await t.call("POST", "/api/settings/enabled", {})).status, 400);
    assert.equal(isEnabled(t.db), true);

    // the environment override wins and is reported
    process.env.TROY_ENABLED = "false";
    const env = (await t.call("GET", "/api/settings")).json;
    assert.equal(env.enabled, false);
    assert.equal(env.settingOn, true);
    assert.equal(env.envOff, true);
  } finally {
    if (before === undefined) delete process.env.TROY_ENABLED;
    else process.env.TROY_ENABLED = before;
  }
});

test("allow-list: add with normalization, reject bad handles, remove", async () => {
  const t = setup();
  const add = await t.call("POST", "/api/settings/allow-list", { handle: "(213) 555-0199" });
  assert.equal(add.json.added, true);
  const rows = t.db.prepare("SELECT handle, chatId, reason FROM allow_list").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ handle: "+12135550199", chatId: null, reason: "manual" }]);
  // full handles never come back from the API
  assert.equal(JSON.stringify(add.json).includes("+12135550199"), false);
  assert.equal(add.json.entries[0].handle, "•••• 0199");
  assert.equal(add.json.entries[0].removable, true);

  // the same number in another format is not added twice
  const dup = await t.call("POST", "/api/settings/allow-list", { handle: "+1 213 555 0199" });
  assert.equal(dup.json.added, false);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM allow_list").get()!.n, 1);

  await t.call("POST", "/api/settings/allow-list", { handle: "Judge@Example.com" });
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM allow_list WHERE handle = 'judge@example.com'").get()!.n, 1);

  for (const bad of ["12345", "not a handle", "", null, 42]) {
    const res = await t.call("POST", "/api/settings/allow-list", { handle: bad });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "bad_handle");
  }
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM allow_list").get()!.n, 2);

  // rows Troy made himself (opt-in phrase, his own group chats) cannot be removed from here
  t.db.prepare("INSERT INTO allow_list (handle, chatId, reason, addedAt) VALUES ('+12135550150', NULL, 'opt_in_phrase', 1)").run();
  const optIn = t.db.prepare("SELECT id FROM allow_list WHERE reason = 'opt_in_phrase'").get()!.id;
  assert.equal((await t.call("DELETE", `/api/settings/allow-list/${optIn}`)).json.removed, 0);

  const byHandle = await t.call("DELETE", "/api/settings/allow-list", { handle: "213-555-0199" });
  assert.equal(byHandle.json.removed, 1);
  const emailId = t.db.prepare("SELECT id FROM allow_list WHERE handle = 'judge@example.com'").get()!.id;
  assert.equal((await t.call("DELETE", `/api/settings/allow-list/${emailId}`)).json.removed, 1);
  assert.deepEqual(t.db.prepare("SELECT reason FROM allow_list").all().map((r) => r.reason), ["opt_in_phrase"]);
  assert.equal((await t.call("DELETE", "/api/settings/allow-list", { handle: "nope" })).status, 400);
});

test("moderation: reported drops with posters, ban and unban", async () => {
  const t = setup();
  const poster = t.user("+12135550101", "Pat Poster");
  t.db.prepare("INSERT INTO food_drops (posterUserId, description, servingsTotal, servingsLeft, reports, createdAt) VALUES (?, 'example pizza', 10, 4, 2, 1)").run(poster);
  t.db.prepare("INSERT INTO food_drops (posterUserId, description, servingsTotal, servingsLeft, reports, createdAt) VALUES (?, 'fine drop', 5, 5, 0, 2)").run(poster);
  const list = (await t.call("GET", "/api/moderation")).json;
  assert.equal(list.drops.length, 1);
  assert.equal(list.drops[0].reports, 2);
  assert.deepEqual(list.drops[0].poster, { id: poster, firstName: "Pat", bannedFromPosting: false, isExample: false });

  assert.equal((await t.call("POST", "/api/moderation/ban", { userId: poster, banned: true })).json.banned, true);
  assert.equal(t.db.prepare("SELECT bannedFromPosting FROM users WHERE id = ?").get(poster)!.bannedFromPosting, 1);
  assert.equal((await t.call("GET", "/api/moderation")).json.drops[0].poster.bannedFromPosting, true);
  await t.call("POST", "/api/moderation/ban", { userId: poster, banned: false });
  assert.equal(t.db.prepare("SELECT bannedFromPosting FROM users WHERE id = ?").get(poster)!.bannedFromPosting, 0);
  assert.equal((await t.call("POST", "/api/moderation/ban", { userId: 999, banned: true })).status, 404);
  assert.equal((await t.call("POST", "/api/moderation/ban", { userId: poster, banned: "yes" })).status, 400);
});

test("directory lists entries with parsed topics", async () => {
  const t = setup();
  t.db.prepare("INSERT INTO directory (kind, name, topics, isExample) VALUES ('usg_program', 'Example program', '[\"funding\",\"budget\"]', 1)").run();
  const res = (await t.call("GET", "/api/directory")).json;
  assert.deepEqual(res.entries.map((e: Json) => [e.name, e.topics, e.isExample, e.url]), [["Example program", ["funding", "budget"], true, null]]);
});

test("photos: only files inside the allowed folders, and sensitive ones are staff only", async () => {
  const t = setup();
  assert.equal(resolvePhoto("/etc/hosts"), null);
  assert.equal(resolvePhoto("../../../etc/hosts"), null);
  assert.equal(resolvePhoto("package.json"), null);
  assert.equal(resolvePhoto("https://example.com/a.jpg"), null);
  assert.equal(resolvePhoto(null), null);
  // a real file in public/ that is not an image is refused too
  assert.equal(resolvePhoto("public/webchat.html"), null);

  const u = t.user("+12135550101", "Fiona Finder");
  t.db.prepare("INSERT INTO listings (userId, type, category, title, photoUrl, createdAt) VALUES (?, 'found', 'wallet', 'brown wallet', '/etc/hosts', 1)").run(u);
  t.db.prepare("INSERT INTO listings (userId, type, category, title, photoUrl, createdAt) VALUES (?, 'found', 'keys', 'keys', '/etc/hosts', 1)").run(u);
  assert.equal((await t.app.request("/api/photo/1")).status, 403);
  assert.equal((await t.app.request("/api/photo/1?staff=1")).status, 404);
  assert.equal((await t.app.request("/api/photo/2")).status, 404);
  assert.equal((await t.app.request("/api/photo/999")).status, 404);
  const panel = (await t.call("GET", "/api/panel")).json;
  assert.equal(panel.listings.find((l: Json) => l.category === "wallet").photoSensitive, true);
  assert.equal(panel.listings.find((l: Json) => l.category === "keys").photoSensitive, false);
  assert.equal(panel.listings[0].hasPhoto, false);
});

test("handles are masked", () => {
  assert.equal(maskHandle("+12135550101"), "•••• 0101");
  assert.equal(maskHandle("someone@usc.edu"), "s•••@usc.edu");
  assert.equal(maskHandle(null), null);
});

// ---------- people (example staff), staff logs, topics ----------

const COMMITTEE = "USG Committee on Example Affairs";

function seedCommittee(t: ReturnType<typeof setup>) {
  t.db.prepare("INSERT INTO directory (kind, name, topics, isExample) VALUES ('usg_committee', ?, '[\"dining\"]', 1)").run(COMMITTEE);
}

test("people: assign with normalization, masked handles, bad input rejected, remove", async () => {
  const t = setup();
  seedCommittee(t);
  const empty = (await t.call("GET", "/api/staff")).json;
  assert.deepEqual(empty.contacts, []);
  assert.deepEqual(empty.roles.map((r: Json) => r.role), ["fms", "housing", `usg:${COMMITTEE}`]);

  const res = await t.call("POST", "/api/staff", { role: "fms", handle: "(213) 555-0142", label: "Sam" });
  assert.equal(res.status, 200);
  assert.equal(res.json.assigned.handle, "•••• 0142");
  assert.equal(res.json.assigned.isExample, true);
  assert.equal(res.json.assigned.label, "sam");
  assert.equal(res.json.addedToAllowList, true);
  assert.ok(!JSON.stringify(res.json).includes("2135550142"), "the full number never comes back");
  assert.equal(t.db.prepare("SELECT handle FROM staff_contacts WHERE role = 'fms'").get()!.handle, "+12135550142");
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM allow_list WHERE handle = '+12135550142' AND reason = 'manual'").get()!.n, 1);
  // No chat with this phone yet, so the page says so.
  assert.equal(res.json.contacts[0].reachable, false);

  // Already allowed: assigned without a second allow-list row.
  await t.call("POST", "/api/settings/allow-list", { handle: "213-555-0143" });
  const usg = await t.call("POST", "/api/staff", { role: `usg:${COMMITTEE.toLowerCase()}`, handle: "2135550143" });
  assert.equal(usg.json.addedToAllowList, false);
  assert.equal(usg.json.assigned.role, `usg:${COMMITTEE}`);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM allow_list WHERE handle = '+12135550143'").get()!.n, 1);

  for (const [bad, error] of [[{ role: "fms", handle: "nope" }, "bad_handle"], [{ role: "dps", handle: "2135550144" }, "bad_role"], [{ role: "usg:made up committee", handle: "2135550144" }, "bad_role"], [{}, "bad_handle"]] as const) {
    const r = await t.call("POST", "/api/staff", bad);
    assert.equal(r.status, 400);
    assert.equal(r.json.error, error);
  }

  // Once the phone has texted troy there is a user row, and the contact is reachable.
  t.user("+12135550142", "Sam Tech");
  const list = (await t.call("GET", "/api/staff")).json;
  assert.equal(list.contacts.length, 2);
  const fms = list.contacts.find((s: Json) => s.role === "fms");
  assert.equal(fms.reachable, true);
  assert.equal(fms.roleLabel, "FMS");
  assert.equal(fms.kind, "repair");
  assert.ok(list.contacts.every((s: Json) => s.isExample === true));

  const gone = await t.call("DELETE", `/api/staff/${fms.id}`);
  assert.equal(gone.json.removed, true);
  assert.equal(gone.json.contacts.length, 1);
  assert.equal((await t.call("DELETE", "/api/staff/999")).json.removed, false);
});

test("reports carry the staff log: the example text when nobody is assigned, what was texted when someone is", async () => {
  const t = setup();
  const reporter = t.user("+12135550101", "Rae Reporter");
  const repairId = Number(
    t.db.prepare("INSERT INTO reports (userId, kind, category, description, locationText, routedTo, createdAt) VALUES (?, 'repair', 'broken light', 'the light is out', 'Taper Hall, 2nd floor', 'FMS', ?)").run(reporter, Date.now()).lastInsertRowid,
  );
  const view = async () => (await t.call("GET", "/api/reports?kind=repair")).json.groups[0].reports[0].staff as Json;

  let staff = await view();
  assert.equal(staff.assigned, null);
  assert.deepEqual(staff.log, []);
  assert.equal(staff.exampleText, 'someone reported a broken light at taper hall, 2nd floor. can u take it?\ntext "on it" if u got it, or "can\'t" and i\'ll hand it back');
  assert.equal(staff.exampleNote, "example: no one is assigned yet");
  assert.equal(staff.roleLabel, "FMS");
  // Reading it sends nothing.
  assert.equal(t.sent.length, 0);

  const tech = t.user("+12135550142", "Sam Tech");
  await t.call("POST", "/api/staff", { role: "fms", handle: "2135550142", label: "sam" });
  const out = await notifyStaffOfReport({ db: t.db, notify: async (userId, bubbles) => void t.sent.push({ userId, bubbles }) }, repairId);
  assert.equal(out.sentTo, tech);

  staff = await view();
  assert.equal(staff.assigned.label, "sam");
  assert.equal(staff.assigned.handle, "•••• 0142");
  assert.equal(staff.assigned.isExample, true);
  assert.equal(staff.exampleText, null);
  assert.equal(staff.log.length, 1);
  assert.equal(staff.log[0].kind, "ask");
  assert.equal(staff.log[0].text, t.sent[0].bubbles.join("\n"));
  assert.ok(typeof staff.log[0].createdAt === "number");

  const one = (await t.call("GET", `/api/reports/${repairId}/staff`)).json;
  assert.equal(one.log.length, 1);
  assert.equal((await t.call("GET", "/api/reports/999/staff")).status, 404);

  // The status buttons keep working, and closing it from the dashboard takes the job off the technician.
  const res = await t.call("POST", `/api/reports/${repairId}/status`, { status: "fixed" });
  assert.equal(res.json.changed, true);
  assert.equal(t.db.prepare("SELECT state FROM staff_jobs WHERE reportId = ?").get(repairId)!.state, "done");
  assert.equal(staffLogFor(t.db, repairId).length, 1);
});

test("a usg report's example text has counts and never the reporter's name", async () => {
  const t = setup();
  const reporter = t.user("+12135550101", "Rae Reporter");
  const follower = t.user("+12135550102", "Fay Follower");
  t.db
    .prepare("INSERT INTO reports (userId, kind, anonymous, description, routedTo, followers, createdAt) VALUES (?, 'usg_concern', 0, 'the village shuttle is always late', ?, ?, ?)")
    .run(reporter, COMMITTEE, JSON.stringify([follower]), Date.now());
  const body = (await t.call("GET", "/api/reports?kind=usg_concern")).json;
  const staff = body.groups[0].reports[0].staff as Json;
  assert.match(staff.exampleText, /^2 trojans raised "the village shuttle is always late" this week\. 1 wants to talk\. want a group chat with them\?/);
  assert.ok(!/rae|fay|reporter|follower/i.test(staff.exampleText));
  assert.equal(staff.roleLabel, COMMITTEE);
});

test("moderation: student-created topics can be removed, and topic requests approved or dismissed", async () => {
  const t = setup();
  const asker = t.user("+12135550101", "Rae Reporter");
  const maker = t.user("+12135550102", "Tia Topic");
  const made = createTopic(t.db, "language tutors", maker);
  saveTopicRequest(t.db, "late night study buddies", asker);
  saveTopicRequest(t.db, "something unclear", asker);

  let mod = (await t.call("GET", "/api/moderation")).json;
  // Only topics students created are listed; the built-in poll options are not.
  assert.deepEqual(mod.topics.map((x: Json) => x.id), [made.id]);
  assert.equal(mod.topics[0].suggestedByFirstName, "Tia");
  assert.equal(mod.topicRequests.length, 2);
  assert.equal(mod.topicRequests[0].text, "late night study buddies");
  assert.equal(mod.topicRequests[0].requesterFirstName, "Rae");
  assert.ok(!JSON.stringify(mod).includes("2135550101"));

  const approve = await t.call("POST", `/api/moderation/topic-requests/${mod.topicRequests[0].id}/approve`, {});
  assert.equal(approve.json.changed, true);
  assert.equal(approve.json.status, "created");
  assert.equal(approve.json.notified, true);
  const created = listTopics(t.db).find((x) => x.id === approve.json.topic.id)!;
  assert.equal(created.builtIn, false);
  // The student who asked follows it, and is told.
  assert.ok((JSON.parse(t.db.prepare("SELECT subscriptions FROM users WHERE id = ?").get(asker)!.subscriptions as string) as string[]).includes(created.key));
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].userId, asker);
  assert.ok(t.sent[0].bubbles[0].includes(`"${created.label}"`));
  assert.equal(t.sent[0].bubbles[0], t.sent[0].bubbles[0].toLowerCase());
  // A second click changes nothing and texts nobody.
  assert.equal((await t.call("POST", `/api/moderation/topic-requests/${mod.topicRequests[0].id}/approve`, {})).json.changed, false);
  assert.equal(t.sent.length, 1);

  const dismiss = await t.call("POST", `/api/moderation/topic-requests/${mod.topicRequests[1].id}/dismiss`, {});
  assert.equal(dismiss.json.status, "declined");
  assert.equal(t.sent.length, 1);

  const removed = await t.call("POST", `/api/moderation/topics/${made.id}/remove`, {});
  assert.equal(removed.json.removed, true);
  const builtIn = listTopics(t.db).find((x) => x.builtIn)!;
  assert.equal((await t.call("POST", `/api/moderation/topics/${builtIn.id}/remove`, {})).status, 400);
  assert.equal((await t.call("POST", "/api/moderation/topics/9999/remove", {})).status, 404);
  assert.equal((await t.call("POST", "/api/moderation/topic-requests/9999/approve", {})).status, 404);

  mod = (await t.call("GET", "/api/moderation")).json;
  assert.deepEqual(mod.topicRequests, []);
  assert.deepEqual(mod.topics.map((x: Json) => x.id), [created.id]);
  assert.ok(listTopics(t.db).some((x) => x.id === builtIn.id), "built-in topics stay");
});

test("the panel payload carries the chat health number, or null until the brain has one", async () => {
  const t = setup();
  const panel = (await t.call("GET", "/api/panel")).json;
  assert.ok("chatHealth" in panel);
  assert.ok(panel.chatHealth === null || ["number", "object"].includes(typeof panel.chatHealth));
});

// ---------- saved locations never leave through the web API ----------

test("no endpoint returns a student's saved location, with or without staff view", async () => {
  const t = setup();
  const ids = seedLostFound(t);
  // Distinctive example coordinates so any leak is easy to spot in the JSON.
  const LAT = 34.0271828;
  const LNG = -118.2831415;
  const AT = 1794000123456;
  for (const id of [ids.finder, ids.owner]) {
    t.db.prepare("UPDATE users SET lastLat = ?, lastLng = ?, lastLocationAt = ?, lastLocationSource = 'find_my', usualSpots = ?, verifiedAt = ? WHERE id = ?").run(LAT, LNG, AT, JSON.stringify(["zzyzx hall"]), Date.now(), id);
  }
  // The finder also has a food drop with reports, a repair report and a USG concern, so every list has their rows in it.
  const dropId = Number(
    t.db
      .prepare("INSERT INTO food_drops (posterUserId, clubName, description, locationText, lat, lng, servingsTotal, servingsLeft, reports, createdAt) VALUES (?, 'acm', 'pizza', 'tcc', 34.0203, -118.2863, 5, 5, 2, ?)")
      .run(ids.finder, Date.now()).lastInsertRowid,
  );
  const reportIds: number[] = [];
  for (const kind of ["repair", "usg_concern"]) {
    reportIds.push(
      Number(
        t.db
          .prepare("INSERT INTO reports (userId, kind, category, description, locationText, routedTo, followers, createdAt) VALUES (?, ?, 'elevator', 'stuck', 'Leavey Library', 'FMS', ?, ?)")
          .run(ids.finder, kind, JSON.stringify([ids.owner]), Date.now()).lastInsertRowid,
      ),
    );
  }

  const leaks = ["lastLat", "lastLng", "lastLocationAt", "lastLocationSource", "usualSpots", "34.0271828", "118.2831415", String(AT), "find_my", "zzyzx"];
  const check = (path: string, json: unknown) => {
    const text = JSON.stringify(json);
    for (const leak of leaks) assert.equal(text.includes(leak), false, `${path} leaked ${leak}`);
  };

  const gets = ["/api/panel", "/api/panel?staff=1", "/api/dps", "/api/reports?kind=repair", "/api/reports?kind=usg_concern", "/api/moderation", "/api/settings", "/api/settings/allow-list", "/api/directory", "/api/eval", "/api/staff"];
  for (const path of gets) {
    const res = await t.call("GET", path);
    assert.equal(res.status, 200, path);
    check(path, res.json);
  }
  // Endpoints that change something answer with rows too.
  check("check-code", (await t.call("POST", "/api/dps/check-code", { code: "K7M4XQ" })).json);
  check("report status", (await t.call("POST", `/api/reports/${reportIds[0]}/status`, { status: "in_progress" })).json);
  check("ban", (await t.call("POST", "/api/moderation/ban", { userId: ids.finder, banned: true })).json);
  check("complete", (await t.call("POST", "/api/dps/complete", { handoffId: ids.handoffId })).json);
  // Nothing staff did sent a location to a student either.
  check("notify", t.sent);
  assert.ok(dropId > 0);

  // The data is still there for Troy's own use; it just never leaves through the web.
  const row = t.db.prepare("SELECT lastLat, lastLng FROM users WHERE id = ?").get(ids.finder) as { lastLat: number; lastLng: number };
  assert.equal(row.lastLat, LAT);
  assert.equal(row.lastLng, LNG);
});

test("the web API source never selects whole user rows or names the location columns in a query", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(import.meta.dirname, "../src/web/api.ts"), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.equal(/SELECT\s+\*\s+FROM\s+users\b/i.test(code), false, "SELECT * FROM users would carry lastLat/lastLng");
  assert.equal(/\busers\.\*/i.test(code), false);
  for (const col of ["lastLat", "lastLng", "lastLocationAt", "lastLocationSource", "getUserById", "getUserByHandle", "rowToUser", "getUserLocation"]) assert.equal(code.includes(col), false, `api.ts mentions ${col}`);
});
