import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DatabaseSync as Db } from "node:sqlite";
import { openDb, getOrCreateUser, getUserById, setSetting, updateUser } from "../src/db/index.ts";
import { allowChat } from "../src/adapters/gate.ts";
import {
  LOCATION_ASK_WINDOW_MS,
  REFRESH_INTERVAL_MS,
  REFRESH_MAX_PER_TICK,
  REFRESH_NOT_SHARING_BACKOFF_MS,
  createLocationRefresher,
  ensureLocationColumns,
  locationOptedOut,
  noteLocationRequestedByUser,
  shouldReadLiveLocation,
  LOCATION_STALE_MS,
  NEAR_PLACE_METERS,
  ageText,
  describeSavedLocation,
  distanceMeters,
  forgetUserLocation,
  getUserLocation,
  nearestPlaceName,
  saveUserLocation,
} from "../src/location.ts";

const PLACES = JSON.parse(readFileSync(join(import.meta.dirname, "../src/db/seed-data/campus_places.json"), "utf8")) as { name: string; nicknames: string[]; lat: number; lng: number; kind: string }[];
const LEAVEY = PLACES.find((p) => p.name === "Leavey Library")!;
const TCC = PLACES.find((p) => p.name === "Ronald Tutor Campus Center")!;
// Example coordinates only.
const DOWNTOWN = { lat: 34.0407, lng: -118.2468 };

function setup() {
  const db = openDb(":memory:");
  const add = db.prepare("INSERT INTO campus_places (name, nicknames, lat, lng, kind) VALUES (?, ?, ?, ?, ?)");
  for (const p of PLACES) add.run(p.name, JSON.stringify(p.nicknames), p.lat, p.lng, p.kind);
  const a = getOrCreateUser(db, "+12135550101", "chat-a");
  const b = getOrCreateUser(db, "+12135550102", "chat-b");
  const user = (id: number) => getUserById(db, id)!;
  const row = (id: number) => ({
    ...(db.prepare("SELECT lastLat, lastLng, lastLocationAt, lastLocationSource FROM users WHERE id = ?").get(id) as Record<string, unknown>),
  });
  return { db, a: a.id, b: b.id, user, row };
}

test("a new database has the four location columns, empty", () => {
  const t = setup();
  assert.deepEqual(t.row(t.a), { lastLat: null, lastLng: null, lastLocationAt: null, lastLocationSource: null });
  assert.equal(getUserLocation(t.db, t.user(t.a)), null);
  assert.equal(describeSavedLocation(t.db, t.a), null);
});

test("the shared User object never carries the saved location", () => {
  const t = setup();
  saveUserLocation(t.db, t.a, LEAVEY, "find_my");
  const u = t.user(t.a) as unknown as Record<string, unknown>;
  for (const key of ["lastLat", "lastLng", "lastLocationAt", "lastLocationSource"]) assert.equal(key in u, false, key);
  assert.equal(JSON.stringify(u).includes(String(LEAVEY.lat)), false);
});

test("save then get: the fix, its time and its source, for that user only", () => {
  const t = setup();
  const now = Date.now();
  saveUserLocation(t.db, t.a, { lat: LEAVEY.lat, lng: LEAVEY.lng }, "find_my", now - 5000);
  assert.deepEqual(getUserLocation(t.db, t.user(t.a), now), { lat: LEAVEY.lat, lng: LEAVEY.lng, at: now - 5000, source: "find_my", stale: false });
  assert.equal(getUserLocation(t.db, t.user(t.b), now), null);

  // Every new share, pin or answer replaces the one before.
  saveUserLocation(t.db, t.a, { lat: TCC.lat, lng: TCC.lng }, "pin", now - 1000);
  assert.deepEqual(getUserLocation(t.db, t.user(t.a), now), { lat: TCC.lat, lng: TCC.lng, at: now - 1000, source: "pin", stale: false });
  saveUserLocation(t.db, t.a, { lat: LEAVEY.lat, lng: LEAVEY.lng }, "asked");
  const got = getUserLocation(t.db, t.user(t.a))!;
  assert.equal(got.source, "asked");
  assert.ok(got.at !== null && Math.abs(got.at - Date.now()) < 5000, "defaults to now");
});

test("stale is strictly older than 3 hours: exactly 3 hours is still fresh", () => {
  const t = setup();
  const now = 1_794_000_000_000;
  assert.equal(LOCATION_STALE_MS, 3 * 60 * 60 * 1000);
  saveUserLocation(t.db, t.a, LEAVEY, "find_my", now - LOCATION_STALE_MS);
  assert.equal(getUserLocation(t.db, t.user(t.a), now)!.stale, false, "exactly 3 hours");
  assert.equal(getUserLocation(t.db, t.user(t.a), now + 1)!.stale, true, "3 hours and 1 ms");
  assert.equal(getUserLocation(t.db, t.user(t.a), now - 1)!.stale, false, "1 ms short of 3 hours");
  // Stale is still returned, with the same coordinates.
  const old = getUserLocation(t.db, t.user(t.a), now + 48 * 60 * 60 * 1000)!;
  assert.deepEqual({ lat: old.lat, lng: old.lng, stale: old.stale, source: old.source }, { lat: LEAVEY.lat, lng: LEAVEY.lng, stale: true, source: "find_my" });
  assert.equal(describeSavedLocation(t.db, t.a, now)!.stale, false);
  assert.equal(describeSavedLocation(t.db, t.a, now + 1)!.stale, true);
});

test("order: saved fix first (even stale), then the first usual spot that resolves, then null", () => {
  const t = setup();
  const now = Date.now();
  updateUser(t.db, t.a, { usualSpots: JSON.stringify(["my apartment off campus", "TCC", "leavey"]) });
  assert.deepEqual(getUserLocation(t.db, t.user(t.a), now), { lat: TCC.lat, lng: TCC.lng, at: null, source: "usual_spot", stale: false, spot: "tcc" });

  saveUserLocation(t.db, t.a, DOWNTOWN, "pin", now - 10 * 60 * 60 * 1000);
  const fix = getUserLocation(t.db, t.user(t.a), now)!;
  assert.deepEqual({ lat: fix.lat, lng: fix.lng, source: fix.source, stale: fix.stale }, { ...DOWNTOWN, source: "pin", stale: true });

  forgetUserLocation(t.db, t.a);
  assert.equal(getUserLocation(t.db, t.user(t.a), now)!.source, "usual_spot");

  updateUser(t.db, t.a, { usualSpots: JSON.stringify(["somewhere nobody knows"]) });
  assert.equal(getUserLocation(t.db, t.user(t.a), now), null);
  updateUser(t.db, t.a, { usualSpots: "[]" });
  assert.equal(getUserLocation(t.db, t.user(t.a), now), null);
});

test("forget erases all four columns for that user only, and is safe to repeat", () => {
  const t = setup();
  saveUserLocation(t.db, t.a, LEAVEY, "find_my");
  saveUserLocation(t.db, t.b, TCC, "pin");
  forgetUserLocation(t.db, t.a);
  forgetUserLocation(t.db, t.a);
  assert.deepEqual(t.row(t.a), { lastLat: null, lastLng: null, lastLocationAt: null, lastLocationSource: null });
  assert.equal(t.row(t.b).lastLat, TCC.lat);
  forgetUserLocation(t.db, 99999);
});

test("bad input never overwrites a good fix", () => {
  const t = setup();
  const now = Date.now();
  saveUserLocation(t.db, t.a, LEAVEY, "find_my", now - 1000);
  for (const bad of [
    { lat: NaN, lng: LEAVEY.lng },
    { lat: LEAVEY.lat, lng: Infinity },
    { lat: 91, lng: 0 },
    { lat: 0, lng: -181 },
    { lat: undefined as unknown as number, lng: 1 },
  ]) saveUserLocation(t.db, t.a, bad, "pin");
  saveUserLocation(t.db, t.a, TCC, "gps" as never);
  assert.deepEqual(t.row(t.a), { lastLat: LEAVEY.lat, lastLng: LEAVEY.lng, lastLocationAt: now - 1000, lastLocationSource: "find_my" });
  // A time in the future is clamped to now.
  saveUserLocation(t.db, t.a, TCC, "pin", now + 60 * 60 * 1000);
  assert.ok((t.row(t.a).lastLocationAt as number) <= Date.now());
});

test("describing a saved fix: nearest campus place within 150 m, else a spot off campus, never coordinates", () => {
  const t = setup();
  const now = Date.now();
  assert.equal(NEAR_PLACE_METERS, 150);
  saveUserLocation(t.db, t.a, LEAVEY, "find_my", now - 20 * 60_000);
  assert.deepEqual(describeSavedLocation(t.db, t.a, now), { place: "near leavey library", age: "20 min ago", source: "find_my", stale: false });
  saveUserLocation(t.db, t.a, DOWNTOWN, "asked", now - 4 * 60 * 60 * 1000);
  assert.deepEqual(describeSavedLocation(t.db, t.a, now), { place: "a spot off campus", age: "4 hr ago", source: "asked", stale: true });
  assert.equal(JSON.stringify(describeSavedLocation(t.db, t.a, now)).includes("34.04"), false);

  // The 150 m edge, with only one place in the table.
  t.db.prepare("DELETE FROM campus_places WHERE name != 'Leavey Library'").run();
  const north = (m: number) => ({ lat: LEAVEY.lat + m / 111_195, lng: LEAVEY.lng });
  assert.ok(Math.abs(distanceMeters(LEAVEY, north(150)) - 150) < 0.5);
  assert.equal(nearestPlaceName(t.db, north(149)), "leavey library");
  assert.equal(nearestPlaceName(t.db, north(151)), null);
  assert.equal(nearestPlaceName(t.db, DOWNTOWN), null);
});

test("age wording", () => {
  assert.equal(ageText(0), "just now");
  assert.equal(ageText(59_000), "just now");
  assert.equal(ageText(60_000), "1 min ago");
  assert.equal(ageText(59 * 60_000), "59 min ago");
  assert.equal(ageText(60 * 60_000), "1 hr ago");
  assert.equal(ageText(23 * 60 * 60_000), "23 hr ago");
  assert.equal(ageText(24 * 60 * 60_000), "1 day ago");
  assert.equal(ageText(3 * 24 * 60 * 60_000), "3 days ago");
  assert.equal(ageText(-5), "just now");
});

test("migration: a database made with the old schema gains the columns and keeps its rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "troy-loc-"));
  const path = join(dir, "old.db");
  try {
    // The users table exactly as it was before location was kept.
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        handle TEXT NOT NULL UNIQUE,
        chatId TEXT NOT NULL,
        name TEXT,
        uscEmail TEXT,
        verifiedAt INTEGER,
        verifiedVia TEXT CHECK (verifiedVia IN ('usc_email','judge_skip')),
        contactMode TEXT NOT NULL DEFAULT 'direct' CHECK (contactMode IN ('direct','relay_only','no_contact')),
        groupChatsAllowed INTEGER NOT NULL DEFAULT 1,
        subscriptions TEXT NOT NULL DEFAULT '[]',
        usualSpots TEXT NOT NULL DEFAULT '[]',
        alertMinutes INTEGER NOT NULL DEFAULT 15,
        quietHours TEXT,
        bannedFromPosting INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0,
        stopped INTEGER NOT NULL DEFAULT 0,
        isExample INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL
      );
      INSERT INTO users (handle, chatId, name, usualSpots, alertMinutes, createdAt) VALUES ('+12135550101', 'chat-a', 'Example Student', '["leavey"]', 7, 1794000000000);
    `);
    const before = (old.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
    assert.equal(before.includes("lastLat"), false);
    old.close();

    const db = openDb(path);
    const cols = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
    for (const c of ["lastLat", "lastLng", "lastLocationAt", "lastLocationSource"]) assert.ok(cols.includes(c), `missing ${c}`);

    const u = getUserById(db, 1)!;
    assert.equal(u.name, "Example Student");
    assert.equal(u.alertMinutes, 7);
    assert.deepEqual(u.usualSpots, ["leavey"]);
    assert.equal(getUserLocation(db, u), null, "no campus places yet, and nothing saved");

    saveUserLocation(db, 1, LEAVEY, "pin", 1794000001000);
    const got = getUserLocation(db, u, 1794000002000)!;
    assert.deepEqual(got, { lat: LEAVEY.lat, lng: LEAVEY.lng, at: 1794000001000, source: "pin", stale: false });
    forgetUserLocation(db, 1);
    assert.equal(getUserLocation(db, u), null);
    db.close();

    // Opening it again is a no-op: the columns are added only once.
    const again = openDb(path);
    const count = (again.prepare("PRAGMA table_info(users)").all() as { name: string }[]).filter((c) => c.name.startsWith("last")).length;
    assert.equal(count, 4);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- "forget my location" sticks ----------

test("forget sets the opt-out: no live reads, no saved fix, and a Find My read can't bring it back", () => {
  const t = setup();
  const now = Date.now();
  updateUser(t.db, t.a, { usualSpots: JSON.stringify(["tcc"]) });
  saveUserLocation(t.db, t.a, LEAVEY, "find_my");
  assert.equal(locationOptedOut(t.db, t.a), false);
  assert.equal(shouldReadLiveLocation(t.db, t.a), true);

  forgetUserLocation(t.db, t.a);
  assert.equal(locationOptedOut(t.db, t.a), true);
  assert.equal(shouldReadLiveLocation(t.db, t.a), false);
  assert.equal(shouldReadLiveLocation(t.db, t.b), true, "only that student");
  // a live read (a lookup with the fix's own time, as the food flow and the refresh do) is dropped
  saveUserLocation(t.db, t.a, LEAVEY, "find_my", now - 1000);
  saveUserLocation(t.db, t.a, LEAVEY, "find_my", now, { byUser: false });
  assert.deepEqual(t.row(t.a), { lastLat: null, lastLng: null, lastLocationAt: null, lastLocationSource: null });
  assert.equal(locationOptedOut(t.db, t.a), true);
  // only a usual spot can come back
  assert.equal(getUserLocation(t.db, t.user(t.a), now)?.source, "usual_spot");
  assert.equal(describeSavedLocation(t.db, t.a), null);
});

test("getUserLocation never returns a saved fix for an opted-out student, even if a row has one", () => {
  const t = setup();
  saveUserLocation(t.db, t.a, LEAVEY, "pin");
  t.db.prepare("UPDATE users SET locationOptOut = 1 WHERE id = ?").run(t.a); // a fix left behind by older code
  assert.equal(getUserLocation(t.db, t.user(t.a)), null);
  updateUser(t.db, t.a, { usualSpots: JSON.stringify(["leavey"]) });
  assert.equal(getUserLocation(t.db, t.user(t.a))?.source, "usual_spot");
});

test("forget then share again clears the opt-out: a share bubble, a pin, or saying where they are", () => {
  const cases: [string, (db: Db, id: number) => void][] = [
    ["share bubble", (db, id) => saveUserLocation(db, id, LEAVEY, "find_my")], // how the pipeline saves a share in the chat
    ["pin", (db, id) => saveUserLocation(db, id, LEAVEY, "pin")],
    ["told troy", (db, id) => saveUserLocation(db, id, LEAVEY, "asked", Date.now())], // how the notes flow saves "i'm at leavey rn"
    ["said outright", (db, id) => saveUserLocation(db, id, LEAVEY, "find_my", Date.now(), { byUser: true })],
  ];
  for (const [name, share] of cases) {
    const t = setup();
    saveUserLocation(t.db, t.a, TCC, "pin");
    forgetUserLocation(t.db, t.a);
    share(t.db, t.a);
    assert.equal(locationOptedOut(t.db, t.a), false, name);
    assert.equal(shouldReadLiveLocation(t.db, t.a), true, name);
    assert.equal(t.row(t.a).lastLat, LEAVEY.lat, name);
    // and live reads work again
    saveUserLocation(t.db, t.a, TCC, "find_my", Date.now());
    assert.equal(t.row(t.a).lastLat, TCC.lat, name);
  }
});

test("a stopped or unknown user is never read", () => {
  const t = setup();
  updateUser(t.db, t.a, { stopped: 1 });
  assert.equal(shouldReadLiveLocation(t.db, t.a), false);
  assert.equal(shouldReadLiveLocation(t.db, 9999), false);
});

test("migration: a database from before the opt-out gets the columns, with nobody opted out", () => {
  const dir = mkdtempSync(join(tmpdir(), "troy-optout-"));
  try {
    const path = join(dir, "old.db");
    // A users table as it was before locationOptOut existed.
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, handle TEXT NOT NULL UNIQUE, chatId TEXT NOT NULL, name TEXT, uscEmail TEXT, verifiedAt INTEGER, verifiedVia TEXT, contactMode TEXT NOT NULL DEFAULT 'direct', groupChatsAllowed INTEGER NOT NULL DEFAULT 1, subscriptions TEXT NOT NULL DEFAULT '[]', usualSpots TEXT NOT NULL DEFAULT '[]', alertMinutes INTEGER NOT NULL DEFAULT 15, quietHours TEXT, bannedFromPosting INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0, stopped INTEGER NOT NULL DEFAULT 0, isExample INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, lastLat REAL, lastLng REAL, lastLocationAt INTEGER, lastLocationSource TEXT)",
    );
    old.prepare("INSERT INTO users (handle, chatId, createdAt, lastLat, lastLng, lastLocationAt, lastLocationSource) VALUES (?, ?, ?, ?, ?, ?, ?)").run("+12135550101", "chat-a", 1, LEAVEY.lat, LEAVEY.lng, Date.now(), "pin");
    old.close();

    const db = openDb(path);
    const columns = () => (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
    ensureLocationColumns(db);
    ensureLocationColumns(db); // safe to repeat
    assert.ok(columns().includes("locationOptOut") && columns().includes("locationAskedAt"));
    const u = getUserById(db, 1)!;
    assert.equal(locationOptedOut(db, u.id), false);
    assert.equal(getUserLocation(db, u)?.lat, LEAVEY.lat, "the saved fix survives");
    forgetUserLocation(db, u.id);
    assert.equal(locationOptedOut(db, u.id), true);
    db.close();

    // A second process opening the same file (nothing remembered in memory) still finds it set.
    const again = openDb(path);
    assert.equal(shouldReadLiveLocation(again, 1), false);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh in-memory database works without calling the migration first", () => {
  const db = openDb(":memory:");
  const u = getOrCreateUser(db, "+12135550109", "chat-z");
  forgetUserLocation(db, u.id);
  assert.equal(locationOptedOut(db, u.id), true);
});

// ---------- background refresh ----------

type Fix = { lat: number; lng: number; at: number } | null;

function refreshSetup(count = 2, over: { maxPerTick?: number; ready?: () => boolean } = {}) {
  const db = openDb(":memory:");
  const add = db.prepare("INSERT INTO campus_places (name, nicknames, lat, lng, kind) VALUES (?, ?, ?, ?, ?)");
  for (const p of PLACES) add.run(p.name, JSON.stringify(p.nicknames), p.lat, p.lng, p.kind);
  const clock = { now: Date.now() - 60 * 60 * 1000 };
  const ids: number[] = [];
  const handles: string[] = [];
  for (let i = 0; i < count; i++) {
    const handle = `+1213555${String(1000 + i)}`;
    const chatId = `any;-;${handle}`;
    const u = getOrCreateUser(db, handle, chatId);
    // verified long ago, so the "just verified" exception to the backoff is out of the way
    updateUser(db, u.id, { verifiedAt: clock.now - 24 * 60 * 60 * 1000, verifiedVia: "judge_skip" });
    allowChat(db, { handle, chatId, reason: "opt_in_phrase" });
    ids.push(u.id);
    handles.push(handle);
  }
  const live = new Map<string, Fix | Error>();
  const lookups: string[] = [];
  const adapter = {
    async getLiveLocation(handle: string) {
      lookups.push(handle);
      const f = live.get(handle) ?? null;
      if (f instanceof Error) throw f;
      return f;
    },
  };
  const refresher = createLocationRefresher({ db, getAdapter: () => adapter, now: () => clock.now, ...over });
  const at = (id: number) => ({ ...(db.prepare("SELECT lastLat, lastLocationAt, lastLocationSource FROM users WHERE id = ?").get(id) as { lastLat: number | null; lastLocationAt: number | null; lastLocationSource: string | null }) });
  return { db, clock, ids, handles, live, lookups, refresher, at };
}

test("refresh saves a fix only when it is newer than the saved one", async () => {
  const t = refreshSetup(1);
  const [id] = t.ids;
  const [h] = t.handles;
  const t0 = t.clock.now - 5 * 60_000;

  // nothing saved yet: the first fix is saved as a Find My fix, with the fix's own time
  t.live.set(h, { lat: LEAVEY.lat, lng: LEAVEY.lng, at: t0 });
  assert.deepEqual(await t.refresher.tick(), { checked: 1, saved: 1, notSharing: 0 });
  assert.deepEqual(t.at(id), { lastLat: LEAVEY.lat, lastLocationAt: t0, lastLocationSource: "find_my" });

  // the same fix again (Find My only moves every 2 to 3 minutes): nothing is written
  t.live.set(h, { lat: TCC.lat, lng: TCC.lng, at: t0 });
  assert.deepEqual(await t.refresher.tick(), { checked: 1, saved: 0, notSharing: 0 });
  assert.equal(t.at(id).lastLat, LEAVEY.lat);

  // an older fix never replaces something newer (a pin they dropped a minute ago)
  saveUserLocation(t.db, id, DOWNTOWN, "pin");
  t.db.prepare("UPDATE users SET lastLocationAt = ? WHERE id = ?").run(t0 + 60_000, id);
  t.live.set(h, { lat: TCC.lat, lng: TCC.lng, at: t0 + 30_000 });
  assert.equal((await t.refresher.tick()).saved, 0);
  assert.equal(t.at(id).lastLocationSource, "pin");

  // a newer one does
  t.live.set(h, { lat: TCC.lat, lng: TCC.lng, at: t0 + 180_000 });
  assert.equal((await t.refresher.tick()).saved, 1);
  assert.deepEqual(t.at(id), { lastLat: TCC.lat, lastLocationAt: t0 + 180_000, lastLocationSource: "find_my" });

  // junk from the provider is never saved
  t.live.set(h, { lat: 999, lng: 0, at: t0 + 999_000 });
  assert.equal((await t.refresher.tick()).saved, 0);
  assert.equal(t.at(id).lastLat, TCC.lat);
});

test("refresh only looks up allowed, verified, not stopped students who have not opted out", async () => {
  const t = refreshSetup(5);
  const [ok, unverified, stopped, optedOut, notAllowed] = t.ids;
  for (const h of t.handles) t.live.set(h, { lat: LEAVEY.lat, lng: LEAVEY.lng, at: t.clock.now - 1000 });
  updateUser(t.db, unverified, { verifiedAt: null });
  updateUser(t.db, stopped, { stopped: 1 });
  forgetUserLocation(t.db, optedOut);
  t.db.prepare("DELETE FROM allow_list WHERE handle = ?").run(t.handles[4]);

  assert.deepEqual(await t.refresher.tick(), { checked: 1, saved: 1, notSharing: 0 });
  assert.deepEqual(t.lookups, [t.handles[0]], "nobody else is even looked up");
  assert.equal(t.at(ok).lastLat, LEAVEY.lat);
  for (const id of [unverified, stopped, optedOut, notAllowed]) assert.equal(t.at(id).lastLat, null);

  // the kill switch: no lookups at all
  t.lookups.length = 0;
  setSetting(t.db, "troy_enabled", "false");
  assert.deepEqual(await t.refresher.tick(), { checked: 0, saved: 0, notSharing: 0 });
  assert.equal(t.lookups.length, 0);
});

test("refresh does nothing while the provider isn't ready (helper not connected)", async () => {
  let ready = false;
  const t = refreshSetup(1, { ready: () => ready });
  t.live.set(t.handles[0], { lat: LEAVEY.lat, lng: LEAVEY.lng, at: t.clock.now - 1000 });
  assert.deepEqual(await t.refresher.tick(), { checked: 0, saved: 0, notSharing: 0 });
  assert.equal(t.lookups.length, 0);
  ready = true;
  assert.equal((await t.refresher.tick()).saved, 1);
});

test("forget during a lookup: the fix that comes back is not saved", async () => {
  const t = refreshSetup(1);
  const [id] = t.ids;
  const adapter = {
    async getLiveLocation() {
      forgetUserLocation(t.db, id); // "forget my location" arrives while Find My is answering
      return { lat: LEAVEY.lat, lng: LEAVEY.lng, at: t.clock.now - 1000 };
    },
  };
  const refresher = createLocationRefresher({ db: t.db, getAdapter: () => adapter, now: () => t.clock.now });
  assert.equal((await refresher.tick()).saved, 0);
  assert.equal(t.at(id).lastLat, null);
  assert.equal(locationOptedOut(t.db, id), true);
});

test("opted out, then asks to be read again: only a fix taken after they asked ends the opt-out", async () => {
  const t = refreshSetup(1);
  const [id] = t.ids;
  const [h] = t.handles;
  // not opted out: asking changes nothing
  noteLocationRequestedByUser(t.db, id, t.clock.now);
  assert.equal((t.db.prepare("SELECT locationAskedAt FROM users WHERE id = ?").get(id) as { locationAskedAt: number | null }).locationAskedAt, null);

  forgetUserLocation(t.db, id);
  // still sharing in Find My from before, but Troy doesn't look
  t.live.set(h, { lat: LEAVEY.lat, lng: LEAVEY.lng, at: t.clock.now - 120_000 });
  await t.refresher.tick();
  assert.equal(t.lookups.length, 0);

  // they accept a new request and say so
  noteLocationRequestedByUser(t.db, id, t.clock.now);
  assert.equal(shouldReadLiveLocation(t.db, id), false, "nothing is read on their word alone");
  // the fix on file is from before they asked: not saved, still opted out
  assert.deepEqual(await t.refresher.tick(), { checked: 1, saved: 0, notSharing: 0 });
  assert.equal(locationOptedOut(t.db, id), true);
  assert.equal(t.at(id).lastLat, null);
  // 45 seconds later a fix taken after they asked arrives
  t.clock.now += 45_000;
  t.live.set(h, { lat: TCC.lat, lng: TCC.lng, at: t.clock.now - 5000 });
  assert.equal((await t.refresher.tick()).saved, 1);
  assert.equal(locationOptedOut(t.db, id), false);
  assert.equal(t.at(id).lastLat, TCC.lat);
  assert.equal(shouldReadLiveLocation(t.db, id), true);
});

test("asking to be read again runs out after 30 minutes, and forgetting again cancels it", async () => {
  const t = refreshSetup(1);
  const [id] = t.ids;
  const [h] = t.handles;
  forgetUserLocation(t.db, id);
  noteLocationRequestedByUser(t.db, id, t.clock.now);
  t.clock.now += LOCATION_ASK_WINDOW_MS + 1000;
  t.live.set(h, { lat: LEAVEY.lat, lng: LEAVEY.lng, at: t.clock.now - 1000 });
  await t.refresher.tick();
  assert.equal(t.lookups.length, 0);
  assert.equal(locationOptedOut(t.db, id), true);

  noteLocationRequestedByUser(t.db, id, t.clock.now);
  forgetUserLocation(t.db, id);
  await t.refresher.tick();
  assert.equal(t.lookups.length, 0);
});

test("refresh cap: at most 25 students per run, round robin so everyone gets a turn", async () => {
  assert.equal(REFRESH_MAX_PER_TICK, 25);
  assert.equal(REFRESH_INTERVAL_MS, 45_000);
  const t = refreshSetup(60);
  for (const h of t.handles) t.live.set(h, { lat: LEAVEY.lat, lng: LEAVEY.lng, at: t.clock.now - 1000 });

  assert.equal((await t.refresher.tick()).checked, 25);
  assert.deepEqual(t.lookups, t.handles.slice(0, 25));
  assert.equal((await t.refresher.tick()).checked, 25);
  assert.deepEqual(t.lookups.slice(25), t.handles.slice(25, 50));
  // the third run finishes the list and wraps around to the start
  assert.equal((await t.refresher.tick()).checked, 25);
  assert.deepEqual(t.lookups.slice(50), [...t.handles.slice(50), ...t.handles.slice(0, 15)]);
  assert.equal(new Set(t.lookups).size, 60);
});

test("refresh backoff: someone who isn't sharing is left alone for 10 minutes", async () => {
  assert.equal(REFRESH_NOT_SHARING_BACKOFF_MS, 10 * 60 * 1000);
  const t = refreshSetup(2);
  const [sharing, quiet] = t.handles;
  t.live.set(sharing, { lat: LEAVEY.lat, lng: LEAVEY.lng, at: t.clock.now - 1000 });
  t.live.set(quiet, null);

  assert.deepEqual(await t.refresher.tick(), { checked: 2, saved: 1, notSharing: 1 });
  t.lookups.length = 0;
  t.clock.now += 45_000;
  await t.refresher.tick();
  assert.deepEqual(t.lookups, [sharing], "the one who is sharing is still checked every run");

  // 9 minutes 59 seconds in: still left alone. At 10 minutes: asked again.
  t.lookups.length = 0;
  t.clock.now += REFRESH_NOT_SHARING_BACKOFF_MS - 46_000;
  await t.refresher.tick();
  assert.deepEqual(t.lookups, [sharing]);
  t.lookups.length = 0;
  t.clock.now += 1000;
  await t.refresher.tick();
  assert.deepEqual(t.lookups.sort(), [sharing, quiet].sort());
});

test("refresh backoff: a failed lookup is not 'not sharing', and a new student is not backed off", async () => {
  const t = refreshSetup(2);
  const [broken, fresh] = t.handles;
  t.live.set(broken, new Error(`find my failed for ${broken}`));
  t.live.set(fresh, null);
  updateUser(t.db, t.ids[1], { verifiedAt: t.clock.now - 60_000 }); // verified a minute ago: probably accepting the request now

  const logs: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    assert.deepEqual(await t.refresher.tick(), { checked: 1, saved: 0, notSharing: 1 });
    t.lookups.length = 0;
    t.clock.now += 45_000;
    t.live.set(fresh, { lat: LEAVEY.lat, lng: LEAVEY.lng, at: t.clock.now - 2000 });
    assert.equal((await t.refresher.tick()).saved, 1);
    assert.deepEqual(t.lookups.sort(), [broken, fresh].sort());
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  // Never a handle or a coordinate in the log.
  for (const l of logs) {
    assert.ok(!l.includes("+1213555"), l);
    assert.ok(!l.includes(String(LEAVEY.lat)), l);
  }
});

test("the timer is injectable: start schedules one run every 45 seconds, stop clears it, runs never overlap", async () => {
  const t = refreshSetup(1);
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  let release: () => void = () => {};
  let lookups = 0;
  const adapter = {
    async getLiveLocation() {
      lookups++;
      await new Promise<void>((r) => (release = r));
      return { lat: LEAVEY.lat, lng: LEAVEY.lng, at: t.clock.now - 1000 };
    },
  };
  const refresher = createLocationRefresher({
    db: t.db,
    getAdapter: () => adapter,
    now: () => t.clock.now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (h) => void ((h as { cleared: boolean }).cleared = true),
  });
  refresher.start();
  refresher.start(); // a second start does nothing
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 45_000);

  timers[0].fn(); // the timer fires
  await new Promise((r) => setImmediate(r));
  assert.equal(lookups, 1);
  // it fires again while the first run is still waiting on Find My: skipped
  assert.deepEqual(await refresher.tick(), { checked: 0, saved: 0, notSharing: 0 });
  assert.equal(lookups, 1);
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(t.at(t.ids[0]).lastLat, LEAVEY.lat);

  refresher.stop();
  assert.equal(timers[0].cleared, true);
  refresher.stop();
});
