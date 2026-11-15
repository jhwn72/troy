import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FlowState, User } from "../types.ts";

let db: DatabaseSync | null = null;

/** Open (or create) the database and apply the schema. Pass ":memory:" in tests. */
export function openDb(path = process.env.DATABASE_URL || "data/troy.db"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const d = new DatabaseSync(path);
  d.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  d.exec(readFileSync(join(import.meta.dirname, "schema.sql"), "utf8"));
  migrate(d);
  return d;
}

/** Columns added after the first databases were created. CREATE TABLE IF NOT EXISTS never adds them to an old file. */
function migrate(d: DatabaseSync): void {
  const has = (table: string, column: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
  if (!has("matches", "touchedAt")) d.exec("ALTER TABLE matches ADD COLUMN touchedAt INTEGER");
  if (!has("matches", "parked")) d.exec("ALTER TABLE matches ADD COLUMN parked INTEGER NOT NULL DEFAULT 0");
  // Last known location. Read and written only through src/location.ts; deliberately not part of the shared User type.
  if (!has("users", "lastLat")) d.exec("ALTER TABLE users ADD COLUMN lastLat REAL");
  if (!has("users", "lastLng")) d.exec("ALTER TABLE users ADD COLUMN lastLng REAL");
  if (!has("users", "lastLocationAt")) d.exec("ALTER TABLE users ADD COLUMN lastLocationAt INTEGER");
  if (!has("users", "lastLocationSource")) d.exec("ALTER TABLE users ADD COLUMN lastLocationSource TEXT");
  // Outgoing texts sent outside the recipient's own turn (relayed words, alerts). See schema.sql.
  if (!has("messages", "notice")) d.exec("ALTER TABLE messages ADD COLUMN notice INTEGER NOT NULL DEFAULT 0");
}

export function getDb(): DatabaseSync {
  if (!db) db = openDb();
  return db;
}

// ---------- settings ----------

export function getSetting(d: DatabaseSync, key: string): string | null {
  const row = d.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(d: DatabaseSync, key: string, value: string): void {
  d.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// ---------- users ----------

type Row = Record<string, unknown>;

export function rowToUser(r: Row): User {
  return {
    id: r.id as number,
    handle: r.handle as string,
    chatId: r.chatId as string,
    name: (r.name as string) ?? null,
    uscEmail: (r.uscEmail as string) ?? null,
    verifiedAt: (r.verifiedAt as number) ?? null,
    verifiedVia: (r.verifiedVia as User["verifiedVia"]) ?? null,
    contactMode: r.contactMode as User["contactMode"],
    groupChatsAllowed: !!r.groupChatsAllowed,
    subscriptions: JSON.parse((r.subscriptions as string) || "[]"),
    usualSpots: JSON.parse((r.usualSpots as string) || "[]"),
    alertMinutes: r.alertMinutes as number,
    quietHours: r.quietHours ? JSON.parse(r.quietHours as string) : null,
    bannedFromPosting: !!r.bannedFromPosting,
    paused: !!r.paused,
    stopped: !!r.stopped,
    createdAt: r.createdAt as number,
  };
}

export function getUserById(d: DatabaseSync, id: number): User | null {
  const r = d.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToUser(r) : null;
}

export function getUserByHandle(d: DatabaseSync, handle: string): User | null {
  const r = d.prepare("SELECT * FROM users WHERE handle = ?").get(handle) as Row | undefined;
  return r ? rowToUser(r) : null;
}

export function getOrCreateUser(d: DatabaseSync, handle: string, chatId: string): User {
  const existing = getUserByHandle(d, handle);
  if (existing) return existing;
  d.prepare("INSERT INTO users (handle, chatId, createdAt) VALUES (?, ?, ?)").run(handle, chatId, Date.now());
  return getUserByHandle(d, handle)!;
}

/** Update simple user columns. JSON fields must be passed already stringified. */
export function updateUser(d: DatabaseSync, id: number, fields: Record<string, string | number | null>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  for (const k of keys) if (!/^[A-Za-z]+$/.test(k)) throw new Error("bad column");
  d.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}

// ---------- flow state ----------

export function getFlowState(d: DatabaseSync, userId: number): FlowState | null {
  const r = d.prepare("SELECT * FROM flow_state WHERE userId = ?").get(userId) as Row | undefined;
  if (!r) return null;
  return { flow: r.flow as FlowState["flow"], step: r.step as string, data: JSON.parse(r.data as string), updatedAt: r.updatedAt as number };
}

export function setFlowState(d: DatabaseSync, userId: number, state: Omit<FlowState, "updatedAt"> | null): void {
  if (!state) {
    d.prepare("DELETE FROM flow_state WHERE userId = ?").run(userId);
    return;
  }
  d.prepare(
    "INSERT INTO flow_state (userId, flow, step, data, updatedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(userId) DO UPDATE SET flow = excluded.flow, step = excluded.step, data = excluded.data, updatedAt = excluded.updatedAt",
  ).run(userId, state.flow, state.step, JSON.stringify(state.data), Date.now());
}

// ---------- messages ----------

export function saveMessage(
  d: DatabaseSync,
  m: {
    userId: number | null;
    chatId: string;
    direction: "in" | "out";
    providerMessageId: string | null;
    text: string | null;
    media?: unknown[];
    /** Outgoing only: sent outside this person's own turn, so it may carry someone else's words (a relay, an alert). */
    notice?: boolean;
  },
): void {
  d.prepare("INSERT INTO messages (userId, chatId, direction, providerMessageId, text, media, createdAt, notice) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    m.userId,
    m.chatId,
    m.direction,
    m.providerMessageId,
    m.text,
    JSON.stringify(m.media ?? []),
    Date.now(),
    m.direction === "out" && m.notice ? 1 : 0,
  );
}
