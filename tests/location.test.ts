import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, getOrCreateUser, getUserById, updateUser } from "../src/db/index.ts";
import {
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
