// Each student's last known location (John's decision, Nov 14 evening: "Location is kept").
//
// This file is the only reader and writer of users.lastLat / lastLng / lastLocationAt / lastLocationSource.
// The columns are deliberately not on the shared User type, so nothing that passes a User around
// (dashboards, prompts, other flows) can carry coordinates by accident.
//
// Hard rules:
// - A saved location is only ever used for the student's own walking times and their own "what do u know about me".
// - It is never put in a text to another student and never returned by the web API.
// - Nothing here is sent to the model.
// - "forget my location" sticks: users.locationOptOut is set, and until the student shares again themselves
//   nothing reads their live location (the background refresh, the food flow) or saves a Find My read.
// - Coordinates and handles are never logged.
//
// The background refresh at the bottom keeps the saved fix current while someone is sharing through Find My
// (a new fix arrives about every 2 to 3 minutes). The server starts and stops it.

import type { DatabaseSync } from "node:sqlite";
import type { MessagingAdapter, User } from "./types.ts";
import { isEnabled } from "./config.ts";
import { isAllowedChat } from "./adapters/gate.ts";
import { findPlace } from "./places.ts";

/** How Troy learned it: a Find My share bubble, a dropped pin, or the student saying where they are. */
export type LocationSource = "find_my" | "pin" | "asked";

/** A saved fix older than this is still used, but worded as "from where u last shared". Exactly 3 hours is not stale yet. */
export const LOCATION_STALE_MS = 3 * 60 * 60 * 1000;
/** A fix this close to a campus place is described by that place's name. */
export const NEAR_PLACE_METERS = 150;

const SOURCES: readonly string[] = ["find_my", "pin", "asked"];

export interface UserLocation {
  lat: number;
  lng: number;
  /** When the fix was taken. Null for a usual spot. */
  at: number | null;
  source: LocationSource | "usual_spot";
  /** True when a saved fix is more than 3 hours old. Always false for a usual spot. */
  stale: boolean;
  /** For a usual spot only: the spot as the student wrote it, lowercased ("tcc"). */
  spot?: string;
}

/** After a student asks Troy to read their location again ("done" after a request), a new fix is waited for this long. */
export const LOCATION_ASK_WINDOW_MS = 30 * 60 * 1000;

const migrated = new WeakSet<DatabaseSync>();

/**
 * Adds the opt-out columns to a database made before they existed, the same way openDb's migrate() adds the
 * other location columns. Runs once per database; every function here that touches the columns calls it first.
 * - locationOptOut: 1 after "forget my location" (also STOP and "delete my data"), until the student shares again.
 * - locationAskedAt: when an opted-out student last asked Troy to read their location again.
 */
export function ensureLocationColumns(db: DatabaseSync): void {
  if (migrated.has(db)) return;
  const cols = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("locationOptOut")) db.exec("ALTER TABLE users ADD COLUMN locationOptOut INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes("locationAskedAt")) db.exec("ALTER TABLE users ADD COLUMN locationAskedAt INTEGER");
  migrated.add(db);
}

const validCoords = (loc: { lat: number; lng: number } | null | undefined): loc is { lat: number; lng: number } =>
  !!loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) && Math.abs(loc.lat) <= 90 && Math.abs(loc.lng) <= 180;

/**
 * Replace the student's saved fix. `at` is when the fix was taken (defaults to now; a time in the future is clamped to now).
 * Bad coordinates are ignored, so a broken payload can never wipe or corrupt a good fix.
 *
 * Two kinds of save:
 * - The student's own act (a share bubble or pin in the chat, telling Troy where they are): saved, and it ends
 *   a "forget my location" opt-out.
 * - A live read (Troy looked their fix up through Find My): never ends an opt-out and is dropped while one is set.
 * A "find_my" save with an explicit `at` is a live read, because only a lookup knows when the fix was taken;
 * everything else is the student's own act. Pass `opts.byUser` to say which it is outright.
 */
export function saveUserLocation(
  db: DatabaseSync,
  userId: number,
  loc: { lat: number; lng: number },
  source: LocationSource,
  at?: number,
  opts: { byUser?: boolean } = {},
): void {
  if (!validCoords(loc) || !SOURCES.includes(source)) return;
  ensureLocationColumns(db);
  const now = Date.now();
  const when = at !== undefined && Number.isFinite(at) ? Math.min(at, now) : now;
  const byUser = opts.byUser ?? !(source === "find_my" && at !== undefined);
  const set = "lastLat = ?, lastLng = ?, lastLocationAt = ?, lastLocationSource = ?";
  if (byUser) db.prepare(`UPDATE users SET ${set}, locationOptOut = 0, locationAskedAt = NULL WHERE id = ?`).run(loc.lat, loc.lng, Math.round(when), source, userId);
  else db.prepare(`UPDATE users SET ${set} WHERE id = ? AND locationOptOut = 0`).run(loc.lat, loc.lng, Math.round(when), source, userId);
}

/**
 * Erase the saved fix ("forget my location", STOP, "delete my data") and stop reading their live location
 * until they share again themselves. Usual spots are a separate setting and stay.
 */
export function forgetUserLocation(db: DatabaseSync, userId: number): void {
  ensureLocationColumns(db);
  db.prepare("UPDATE users SET lastLat = NULL, lastLng = NULL, lastLocationAt = NULL, lastLocationSource = NULL, locationOptOut = 1, locationAskedAt = NULL WHERE id = ?").run(userId);
}

/** True after "forget my location" (or STOP, or "delete my data") until the student shares again themselves. */
export function locationOptedOut(db: DatabaseSync, userId: number): boolean {
  ensureLocationColumns(db);
  const r = db.prepare("SELECT locationOptOut FROM users WHERE id = ?").get(userId) as { locationOptOut: number | null } | undefined;
  return !!r?.locationOptOut;
}

/**
 * May Troy look this student's live location up right now (adapter.getLiveLocation)? False for someone who
 * said "forget my location" and has not shared again, for a stopped user, and for an unknown user.
 * Every caller of adapter.getLiveLocation outside onboarding must check this first.
 */
export function shouldReadLiveLocation(db: DatabaseSync, userId: number): boolean {
  ensureLocationColumns(db);
  const r = db.prepare("SELECT stopped, locationOptOut FROM users WHERE id = ?").get(userId) as { stopped: number; locationOptOut: number | null } | undefined;
  return !!r && !r.stopped && !r.locationOptOut;
}

/**
 * The student asked Troy to read their location again (for example "done" after accepting a location request).
 * Nothing is read on their word alone: for the next 30 minutes the background refresh watches for a fix taken
 * after this moment, and only that fix ends the opt-out. Does nothing for someone who is not opted out.
 */
export function noteLocationRequestedByUser(db: DatabaseSync, userId: number, now: number = Date.now()): void {
  ensureLocationColumns(db);
  db.prepare("UPDATE users SET locationAskedAt = ? WHERE id = ? AND locationOptOut = 1 AND stopped = 0").run(Math.round(now), userId);
}

function savedFix(db: DatabaseSync, userId: number): { lat: number; lng: number; at: number; source: LocationSource } | null {
  const r = db.prepare("SELECT lastLat, lastLng, lastLocationAt, lastLocationSource FROM users WHERE id = ?").get(userId) as
    | { lastLat: number | null; lastLng: number | null; lastLocationAt: number | null; lastLocationSource: string | null }
    | undefined;
  if (!r || r.lastLat === null || r.lastLng === null) return null;
  const loc = { lat: Number(r.lastLat), lng: Number(r.lastLng) };
  if (!validCoords(loc)) return null;
  const source = (SOURCES.includes(r.lastLocationSource ?? "") ? r.lastLocationSource : "asked") as LocationSource;
  // A fix with no time on it can't be shown to be recent, so it counts as old.
  return { ...loc, at: r.lastLocationAt === null ? 0 : Number(r.lastLocationAt), source };
}

/**
 * The best place Troy has for this student, for their own walking times:
 * the saved fix first (stale when older than 3 hours, still returned), else the first usual spot that
 * findPlace resolves, else null. After "forget my location" only a usual spot can come back.
 */
export function getUserLocation(db: DatabaseSync, user: User, now: number = Date.now()): UserLocation | null {
  const fix = locationOptedOut(db, user.id) ? null : savedFix(db, user.id);
  if (fix) return { lat: fix.lat, lng: fix.lng, at: fix.at, source: fix.source, stale: now - fix.at > LOCATION_STALE_MS };
  for (const spot of user.usualSpots ?? []) {
    if (typeof spot !== "string") continue;
    const place = findPlace(db, spot);
    if (place) return { lat: place.lat, lng: place.lng, at: null, source: "usual_spot", stale: false, spot: spot.toLowerCase().replace(/\s+/g, " ").trim() };
  }
  return null;
}

const EARTH_RADIUS_M = 6371000;

/** Straight-line meters between two points. */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Lowercased name of the closest campus place within 150 m, else null. */
export function nearestPlaceName(db: DatabaseSync, loc: { lat: number; lng: number }): string | null {
  const rows = db.prepare("SELECT name, lat, lng FROM campus_places ORDER BY id").all() as { name: string; lat: number; lng: number }[];
  let best: { name: string; meters: number } | null = null;
  for (const r of rows) {
    const meters = distanceMeters(loc, { lat: r.lat, lng: r.lng });
    if (meters <= NEAR_PLACE_METERS && (!best || meters < best.meters)) best = { name: r.name, meters };
  }
  return best ? best.name.toLowerCase() : null;
}

/** "just now", "12 min ago", "3 hr ago", "2 days ago". */
export function ageText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * What the student may be told about their own saved fix: a place name (never coordinates) and its age.
 * Null when nothing is saved. Usual spots are not a saved location and are not described here.
 * Only ever for the student's own chat.
 */
export function describeSavedLocation(db: DatabaseSync, userId: number, now: number = Date.now()): { place: string; age: string; source: LocationSource; stale: boolean } | null {
  const fix = savedFix(db, userId);
  if (!fix) return null;
  const near = nearestPlaceName(db, fix);
  return { place: near ? `near ${near}` : "a spot off campus", age: ageText(now - fix.at), source: fix.source, stale: now - fix.at > LOCATION_STALE_MS };
}

// ---------- background refresh ----------

/** How often the refresh runs. Find My gives a new fix every 2 to 3 minutes, so faster gains nothing. */
export const REFRESH_INTERVAL_MS = 45_000;
/** At most this many students are looked up per run. The rest wait their turn (round robin). */
export const REFRESH_MAX_PER_TICK = 25;
/** Someone who turned out not to be sharing is left alone this long. */
export const REFRESH_NOT_SHARING_BACKOFF_MS = 10 * 60 * 1000;
/** A lookup can take about 10 seconds each on the real provider. A run stops early so runs never pile up. */
const REFRESH_BUDGET_MS = 40_000;
/** Just verified: they are probably answering the location request right now, so no backoff yet. */
const REFRESH_NEW_USER_MS = 15 * 60 * 1000;

export interface RefreshResult {
  /** Students whose live location was looked up in this run. */
  checked: number;
  /** Fixes saved (newer than what was there). */
  saved: number;
  /** Lookups that came back "not sharing". */
  notSharing: number;
}

export interface LocationRefresher {
  /** One run. Never throws. Returns zeros when Troy is off, the provider isn't ready, or a run is still going. */
  tick(): Promise<RefreshResult>;
  start(): void;
  stop(): void;
}

type TimerHandle = unknown;

/**
 * Keeps saved locations current for students who are sharing through Find My.
 * Each run looks at allowed, verified, not stopped students who have not said "forget my location", asks the
 * adapter for their live fix, and saves it only when it was taken after the saved one.
 * A student who opted out and then asked to be read again is watched for 30 minutes; a fix taken after they
 * asked ends the opt-out.
 * `ready` is the server's check that this may run at all (BlueBubbles with the helper connected, or the simulator).
 */
export function createLocationRefresher(opts: {
  db: DatabaseSync;
  getAdapter: () => Pick<MessagingAdapter, "getLiveLocation"> | null;
  ready?: () => boolean;
  now?: () => number;
  intervalMs?: number;
  maxPerTick?: number;
  backoffMs?: number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}): LocationRefresher {
  const { db } = opts;
  const clock = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? REFRESH_INTERVAL_MS;
  const maxPerTick = Math.max(1, opts.maxPerTick ?? REFRESH_MAX_PER_TICK);
  const backoffMs = opts.backoffMs ?? REFRESH_NOT_SHARING_BACKOFF_MS;
  const setTimer =
    opts.setTimer ??
    ((fn, ms) => {
      const t = setInterval(fn, ms);
      t.unref();
      return t;
    });
  const clearTimer = opts.clearTimer ?? ((h) => clearInterval(h as NodeJS.Timeout));

  /** userId -> when they were last found not sharing. Memory only. */
  const notSharingAt = new Map<number, number>();
  /** Round robin: the id of the last student looked up. */
  let cursor = 0;
  let running = false;
  let timer: TimerHandle | null = null;

  type Row = { id: number; handle: string; chatId: string; verifiedAt: number; lastLocationAt: number | null; locationOptOut: number; locationAskedAt: number | null };
  const NONE: RefreshResult = { checked: 0, saved: 0, notSharing: 0 };

  function candidates(now: number): Row[] {
    ensureLocationColumns(db);
    const rows = db
      .prepare(
        "SELECT id, handle, chatId, verifiedAt, lastLocationAt, locationOptOut, locationAskedAt FROM users WHERE verifiedAt IS NOT NULL AND stopped = 0 AND (locationOptOut = 0 OR locationAskedAt > ?) ORDER BY id",
      )
      .all(now - LOCATION_ASK_WINDOW_MS) as Row[];
    const due = rows.filter((r) => {
      if (!isAllowedChat(db, r.chatId, r.handle)) return false;
      const missed = notSharingAt.get(r.id);
      if (missed === undefined || now - missed >= backoffMs) return true;
      // Still worth a look: they just verified, or they asked to be read again after the miss.
      return now - r.verifiedAt < REFRESH_NEW_USER_MS || (r.locationAskedAt !== null && r.locationAskedAt > missed);
    });
    // Round robin: start after the last student looked up, wrap around.
    return [...due.filter((r) => r.id > cursor), ...due.filter((r) => r.id <= cursor)].slice(0, maxPerTick);
  }

  async function run(): Promise<RefreshResult> {
    const result: RefreshResult = { checked: 0, saved: 0, notSharing: 0 };
    const adapter = opts.getAdapter();
    if (!adapter) return result;
    const startedAt = clock();
    for (const who of candidates(startedAt)) {
      // The kill switch, a disconnect, or the time budget ends the run. The rest go first next time.
      if (!isEnabled(db) || (opts.ready && !opts.ready()) || clock() - startedAt > REFRESH_BUDGET_MS) break;
      cursor = who.id;
      let fix: { lat: number; lng: number; at: number } | null;
      try {
        fix = await adapter.getLiveLocation(who.handle);
      } catch {
        continue; // a failed lookup says nothing about whether they are sharing
      }
      result.checked++;
      if (!fix || !validCoords(fix) || !Number.isFinite(fix.at) || fix.at <= 0) {
        notSharingAt.set(who.id, clock());
        result.notSharing++;
        continue;
      }
      notSharingAt.delete(who.id);
      // Read again: they may have shared, forgotten or stopped while the lookup ran.
      const cur = db.prepare("SELECT stopped, lastLocationAt, locationOptOut, locationAskedAt FROM users WHERE id = ?").get(who.id) as
        | { stopped: number; lastLocationAt: number | null; locationOptOut: number; locationAskedAt: number | null }
        | undefined;
      if (!cur || cur.stopped) continue;
      const at = Math.min(fix.at, Date.now());
      if (cur.locationOptOut) {
        // Only a fix taken after they asked counts as them sharing again.
        if (cur.locationAskedAt === null || at <= cur.locationAskedAt) continue;
        saveUserLocation(db, who.id, { lat: fix.lat, lng: fix.lng }, "find_my", at, { byUser: true });
        result.saved++;
      } else if (cur.lastLocationAt === null || at > cur.lastLocationAt) {
        saveUserLocation(db, who.id, { lat: fix.lat, lng: fix.lng }, "find_my", at);
        result.saved++;
      }
    }
    return result;
  }

  async function tick(): Promise<RefreshResult> {
    if (running) return { ...NONE };
    running = true;
    try {
      if (!isEnabled(db) || (opts.ready && !opts.ready())) return { ...NONE };
      return await run();
    } catch {
      console.log("location refresh failed"); // no details: an error could carry a handle
      return { ...NONE };
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer !== null) return;
      timer = setTimer(() => void tick(), intervalMs);
    },
    stop() {
      if (timer === null) return;
      clearTimer(timer);
      timer = null;
    },
  };
}
