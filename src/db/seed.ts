// Loads campus places, the directory and the labeled example data from src/db/seed-data/.
// Safe to run twice. Example rows are marked isExample = 1, and rows that aren't examples are never changed.

import type { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findPlace } from "../places.ts";
import { matchListing } from "../flows/lostfound/match.ts";

const DATA_DIR = join(import.meta.dirname, "seed-data");
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const DAY = 24 * HOUR;

type Row = Record<string, unknown>;

interface PlaceSeed { name: string; nicknames: string[]; lat: number; lng: number; kind: "campus" | "dorm" | "other" }
interface DirectorySeed { kind: string; name: string; topics: string[]; contactMethod: string | null; url: string | null; details: string | null; isExample: boolean }
interface UserSeed {
  handle: string;
  name: string;
  uscEmail: string;
  verifiedDaysAgo: number;
  subscriptions: string[];
  usualSpots: string[];
  alertMinutes?: number;
  contactMode?: string;
  groupChatsAllowed?: boolean;
  quietHours?: { start: string; end: string } | null;
}
interface ListingSeed {
  key: string;
  user: string;
  type: "found" | "lost";
  hoursAgo: number;
  locationText: string | null;
  status?: string;
  heldBy?: "finder" | "dps" | null;
  title?: string;
  isValuable?: boolean;
  details: Row;
}
interface FoodDropSeed {
  poster: string;
  clubName: string;
  description: string;
  locationText: string;
  servingsTotal: number;
  servingsLeft: number;
  holdMinutes?: number;
  status?: string;
  minutesAgo: number;
  expiresInMinutes: number;
}
interface ReportSeed {
  user: string;
  kind: "repair" | "usg_concern";
  anonymous?: boolean;
  category: string | null;
  description: string;
  locationText: string | null;
  routedTo: string | null;
  status?: string;
  hoursAgo: number;
  followers?: string[];
}

/** Reads one seed file. A missing file is fine (another builder may not have written it yet) and gives no rows. */
function load<T>(file: string): T[] {
  const path = join(DATA_DIR, file);
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Removes every example row (and the rows that hang off them), leaving real rows alone. Used by `scripts/seed.ts --reset`. */
export function clearExamples(db: DatabaseSync): void {
  const exListings = "SELECT id FROM listings WHERE isExample = 1";
  const exMatches = `SELECT id FROM matches WHERE foundListingId IN (${exListings}) OR lostListingId IN (${exListings})`;
  const exUsers = "SELECT id FROM users WHERE isExample = 1";
  db.exec(`
    DELETE FROM verifications WHERE matchId IN (${exMatches});
    DELETE FROM handoffs WHERE matchId IN (${exMatches});
    DELETE FROM matches WHERE foundListingId IN (${exListings}) OR lostListingId IN (${exListings});
    DELETE FROM listings WHERE isExample = 1;
    DELETE FROM claims WHERE foodDropId IN (SELECT id FROM food_drops WHERE isExample = 1);
    DELETE FROM food_drops WHERE isExample = 1;
    UPDATE reports SET duplicateOf = NULL WHERE duplicateOf IN (SELECT id FROM reports WHERE isExample = 1);
    DELETE FROM reports WHERE isExample = 1;
    DELETE FROM flow_state WHERE userId IN (${exUsers});
    DELETE FROM user_notes WHERE userId IN (${exUsers});
    DELETE FROM verification_codes WHERE userId IN (${exUsers});
    DELETE FROM users WHERE isExample = 1
      AND id NOT IN (SELECT userId FROM listings)
      AND id NOT IN (SELECT posterUserId FROM food_drops)
      AND id NOT IN (SELECT userId FROM claims)
      AND id NOT IN (SELECT userId FROM reports)
      AND id NOT IN (SELECT userId FROM messages WHERE userId IS NOT NULL);
  `);
}

function seedPlaces(db: DatabaseSync): void {
  const upsert = db.prepare(
    "INSERT INTO campus_places (name, nicknames, lat, lng, kind) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET nicknames = excluded.nicknames, lat = excluded.lat, lng = excluded.lng, kind = excluded.kind",
  );
  for (const p of load<PlaceSeed>("campus_places.json")) upsert.run(p.name, JSON.stringify(p.nicknames ?? []), p.lat, p.lng, p.kind ?? null);
}

function seedDirectory(db: DatabaseSync): void {
  const upsert = db.prepare(
    "INSERT INTO directory (kind, name, topics, contactMethod, url, details, isExample) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, topics = excluded.topics, contactMethod = excluded.contactMethod, url = excluded.url, details = excluded.details, isExample = excluded.isExample",
  );
  // offices.json is ours; directory.json (USG programs and committees) belongs to another builder and may not exist yet.
  for (const file of ["offices.json", "directory.json"]) {
    for (const d of load<DirectorySeed>(file)) {
      if (!d || typeof d.name !== "string" || !d.name || !["office", "usg_committee", "usg_program"].includes(d.kind)) continue;
      upsert.run(d.kind, d.name, JSON.stringify(d.topics ?? []), d.contactMethod ?? null, d.url ?? null, d.details ?? null, d.isExample ? 1 : 0);
    }
  }
}

/** Returns handle -> user id for the example users. A handle that already belongs to a real (non-example) user is skipped. */
function seedUsers(db: DatabaseSync, now: number): Map<string, number> {
  const ids = new Map<string, number>();
  const find = db.prepare("SELECT id, isExample FROM users WHERE handle = ?");
  const insert = db.prepare(
    "INSERT INTO users (handle, chatId, name, uscEmail, verifiedAt, verifiedVia, contactMode, groupChatsAllowed, subscriptions, usualSpots, alertMinutes, quietHours, isExample, createdAt) VALUES (?, ?, ?, ?, ?, 'usc_email', ?, ?, ?, ?, ?, ?, 1, ?)",
  );
  for (const u of load<UserSeed>("users.json")) {
    const existing = find.get(u.handle) as { id: number; isExample: number } | undefined;
    if (existing) {
      if (existing.isExample) ids.set(u.handle, existing.id);
      continue;
    }
    const verifiedAt = now - (u.verifiedDaysAgo ?? 7) * DAY;
    // Example users only ever exist in the web chat. They are never on the allow-list, so no adapter will send to them.
    const r = insert.run(
      u.handle,
      `webchat;-;${u.handle}`,
      u.name,
      u.uscEmail,
      verifiedAt,
      u.contactMode ?? "direct",
      u.groupChatsAllowed === false ? 0 : 1,
      JSON.stringify(u.subscriptions ?? []),
      JSON.stringify(u.usualSpots ?? []),
      u.alertMinutes ?? 15,
      u.quietHours ? JSON.stringify(u.quietHours) : null,
      verifiedAt - 5 * MINUTE,
    );
    ids.set(u.handle, Number(r.lastInsertRowid));
  }
  return ids;
}

function seedListings(db: DatabaseSync, users: Map<string, number>, now: number): void {
  const exists = db.prepare("SELECT 1 FROM listings WHERE isExample = 1 AND userId = ? AND type = ? AND title = ?");
  const insert = db.prepare(
    "INSERT INTO listings (userId, type, category, title, details, locationText, lat, lng, happenedAt, status, isValuable, isDangerous, heldBy, isExample, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
  );
  for (const l of load<ListingSeed>("listings.json")) {
    const userId = users.get(l.user);
    if (userId === undefined) continue;
    const d = l.details ?? {};
    const title = l.title ?? (typeof d.title === "string" ? d.title : null);
    if (!title || exists.get(userId, l.type, title)) continue;
    const happenedAt = now - l.hoursAgo * HOUR;
    // Finders usually text within minutes; owners notice later.
    const createdAt = Math.min(now, happenedAt + (l.type === "found" ? 10 * MINUTE : 90 * MINUTE));
    const place = l.locationText ? findPlace(db, l.locationText) : null;
    const details = l.type === "lost" ? { ...d, locationText: d.locationText ?? l.locationText ?? null, happenedAt } : d;
    insert.run(
      userId,
      l.type,
      typeof d.category === "string" ? d.category : null,
      title,
      JSON.stringify(details),
      l.locationText ?? null,
      place?.lat ?? null,
      place?.lng ?? null,
      happenedAt,
      l.status ?? "open",
      (l.isValuable ?? d.isValuable === true) ? 1 : 0,
      d.isDangerous === true ? 1 : 0,
      l.type === "found" ? (l.heldBy ?? "finder") : null,
      createdAt,
    );
  }
}

function seedFoodDrops(db: DatabaseSync, users: Map<string, number>, now: number): void {
  const exists = db.prepare("SELECT 1 FROM food_drops WHERE isExample = 1 AND posterUserId = ? AND description = ?");
  const insert = db.prepare(
    "INSERT INTO food_drops (posterUserId, clubName, description, locationText, lat, lng, servingsTotal, servingsLeft, holdMinutes, status, isExample, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
  );
  for (const f of load<FoodDropSeed>("food_drops.json")) {
    const userId = users.get(f.poster);
    if (userId === undefined || exists.get(userId, f.description)) continue;
    const place = findPlace(db, f.locationText);
    insert.run(
      userId,
      f.clubName,
      f.description,
      f.locationText,
      place?.lat ?? null,
      place?.lng ?? null,
      f.servingsTotal,
      Math.min(f.servingsLeft, f.servingsTotal),
      f.holdMinutes ?? 15,
      f.status ?? "live",
      now + f.expiresInMinutes * MINUTE,
      now - f.minutesAgo * MINUTE,
    );
  }
}

function seedReports(db: DatabaseSync, users: Map<string, number>, now: number): void {
  const exists = db.prepare("SELECT 1 FROM reports WHERE isExample = 1 AND userId = ? AND kind = ? AND description = ?");
  const insert = db.prepare(
    "INSERT INTO reports (userId, kind, anonymous, category, description, locationText, routedTo, status, followers, isExample, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
  );
  for (const r of load<ReportSeed>("reports.json")) {
    const userId = users.get(r.user);
    if (userId === undefined || exists.get(userId, r.kind, r.description)) continue;
    const followers = (r.followers ?? []).map((h) => users.get(h)).filter((id): id is number => id !== undefined);
    insert.run(userId, r.kind, r.anonymous ? 1 : 0, r.category ?? null, r.description, r.locationText ?? null, r.routedTo ?? null, r.status ?? "received", JSON.stringify(followers), now - r.hoursAgo * HOUR);
  }
}

/**
 * Seeds campus places, the directory and the example data. Idempotent: a second run adds nothing.
 * Returns how many rows each seeded table holds afterwards.
 * opts.now pins "seed time" (listing times are stored as offsets from it); opts.reset clears old example rows first so their times are fresh.
 */
export function seed(db: DatabaseSync, opts: { now?: number; reset?: boolean } = {}): { [table: string]: number } {
  const now = opts.now ?? Date.now();
  db.exec("BEGIN");
  try {
    if (opts.reset) clearExamples(db);
    seedPlaces(db);
    seedDirectory(db);
    const users = seedUsers(db, now);
    seedListings(db, users, now);
    seedFoodDrops(db, users, now);
    seedReports(db, users, now);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  const counts: { [table: string]: number } = {};
  for (const table of ["campus_places", "directory", "users", "listings", "food_drops", "reports"]) counts[table] = count(db, table);
  return counts;
}

/**
 * Runs the matcher over the open example found items (rule scores only, no AI call) so the demo panel shows
 * candidate matches with confidence and reasons right away. Idempotent: one row per pair, and a row that
 * already exists keeps its status. Sends nothing and changes no listing. Returns how many pairs were scored.
 */
export async function seedMatches(db: DatabaseSync): Promise<number> {
  const found = db.prepare("SELECT id FROM listings WHERE isExample = 1 AND type = 'found' AND status IN ('open','matched') ORDER BY id").all() as { id: number }[];
  let pairs = 0;
  for (const f of found) pairs += (await matchListing(db, f.id, { useAi: false })).length;
  return pairs;
}
