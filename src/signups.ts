// The demo sign-up switch and cap (CLAUDE.md, "Demo sign-up cap and switch").
// Two settings, a live count, and the one-time "demo's full" line for a brand-new chat that is turned away.
// Used by the gate (src/adapters/gate.ts), the adapters and the dashboard API. Never weaken the privacy rules here:
// the only thing ever kept about a refused chat is a salted hash saying the line was sent (with the salted hash of
// the refused message's id, so the same chat can be recognised when it tries again).

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { config, isEnabled } from "./config.ts";
import { getSetting, setSetting } from "./db/index.ts";

export type SignupNoticeKind = "full" | "closed";

/** The only two texts sendSignupNotice can ever send. Fixed, word for word. */
export const SIGNUP_NOTICE_TEXT: Record<SignupNoticeKind, string> = {
  full: "demo's full rn, try again in a bit",
  closed: "sign-ups are closed rn",
};

export const SIGNUPS_OPEN_KEY = "signups_open";
export const SIGNUPS_MAX_KEY = "signups_max";
export const SIGNUP_SALT_KEY = "signup_notice_salt";
export const DEFAULT_MAX_USERS = 40;
export const MAX_USERS_LIMIT = 500;

const CLOSED_WORDS = ["closed", "close", "off", "false", "0", "no"];

/** Whole number from 0 to 500. Anything that isn't a number gives the fallback. */
export function clampCap(value: unknown, fallback = DEFAULT_MAX_USERS): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(MAX_USERS_LIMIT, Math.round(n)));
}

/** Open unless the dashboard switch (signups_open) or, before it was ever pressed, TROY_SIGNUPS says closed. */
export function signupsOpen(db: DatabaseSync): boolean {
  const stored = getSetting(db, SIGNUPS_OPEN_KEY);
  const raw = stored ?? process.env.TROY_SIGNUPS ?? "open";
  return !CLOSED_WORDS.includes(raw.trim().toLowerCase());
}

export function setSignupsOpen(db: DatabaseSync, open: boolean): void {
  setSetting(db, SIGNUPS_OPEN_KEY, open ? "open" : "closed");
}

/** The cap: the dashboard value (signups_max) once set, else TROY_MAX_USERS, else 40. Always 0 to 500. */
export function signupCap(db: DatabaseSync): number {
  const stored = getSetting(db, SIGNUPS_MAX_KEY);
  if (stored !== null) return clampCap(stored);
  return clampCap(process.env.TROY_MAX_USERS);
}

export function setSignupCap(db: DatabaseSync, max: number): number {
  const clamped = clampCap(max);
  setSetting(db, SIGNUPS_MAX_KEY, String(clamped));
  return clamped;
}

/** Set by "delete my data" (the allow-list row stays so they can come back); cleared by the gate when they text again. */
export const SIGNUP_LEFT_PREFIX = "signup_left:";

/**
 * How many people are in through the opt-in phrase: one per handle with an 'opt_in_phrase' row.
 * Never counted: the manual list (ALLOWED_HANDLES, a dashboard manual entry, even when they first came in by the
 * phrase) and Troy's groups. Someone who texted STOP or "delete my data" gives the seat back until they return.
 */
export function signupCount(db: DatabaseSync): number {
  const rows = db
    .prepare(
      `SELECT DISTINCT a.handle AS handle FROM allow_list a
       WHERE a.reason = 'opt_in_phrase' AND a.handle IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM allow_list m WHERE m.handle = a.handle AND m.reason = 'manual')
         AND NOT EXISTS (SELECT 1 FROM users u WHERE u.handle = a.handle AND u.stopped = 1)
         AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.key = '${SIGNUP_LEFT_PREFIX}' || a.handle)`,
    )
    .all() as { handle: string }[];
  return rows.filter((r) => !config.allowedHandles.includes(r.handle)).length;
}

/** "delete my data": the seat is free until this person texts Troy again. */
export function releaseSeat(db: DatabaseSync, handle: string): void {
  if (handle) setSetting(db, SIGNUP_LEFT_PREFIX + handle, String(Date.now()));
}

/** Called by the gate for every text from an already allowed 1:1 chat: they are back, so the seat is theirs again. */
export function reclaimSeat(db: DatabaseSync, handle: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(SIGNUP_LEFT_PREFIX + handle);
}

export function signupsView(db: DatabaseSync): { open: boolean; max: number; count: number } {
  return { open: signupsOpen(db), max: signupCap(db), count: signupCount(db) };
}

/** Why a new opt-in can't be let in right now, or null when there is room and sign-ups are open. */
export function signupBlock(db: DatabaseSync): SignupNoticeKind | null {
  if (!signupsOpen(db)) return "closed";
  if (signupCount(db) >= signupCap(db)) return "full";
  return null;
}

// ---------- the one-time notice ----------

function salt(db: DatabaseSync): string {
  const saved = getSetting(db, SIGNUP_SALT_KEY);
  if (saved) return saved;
  const made = randomBytes(16).toString("hex");
  setSetting(db, SIGNUP_SALT_KEY, made);
  return made;
}

const hashWith = (saltValue: string, value: string) => createHash("sha256").update(`${saltValue}:${value}`).digest("hex");

/**
 * The salted hash kept for a refused person. It is of the normalized handle, not the raw chat id, so the same
 * number arriving as an iMessage chat and an SMS chat is one record and gets the line once.
 * Known limit: the salt is in the same database file, so someone holding the file could test phone numbers
 * against it. Nothing is in the clear, and that is as far as this goes for the demo.
 */
export function signupNoticeHash(db: DatabaseSync, handle: string): string {
  return hashWith(salt(db), handle);
}

// Grants live in memory only: a notice the gate just issued and the adapter has not sent yet. A crash loses the
// grant (so the line is not sent), never the record (so it is never sent twice).
const GRANT_MS = 2 * 60_000;
type Grant = { chatId: string; kind: SignupNoticeKind; at: number };
const grants = new WeakMap<DatabaseSync, Map<string, Grant>>();

function grantsFor(db: DatabaseSync): Map<string, Grant> {
  let m = grants.get(db);
  if (!m) grants.set(db, (m = new Map()));
  return m;
}

// How many refused first messages one record remembers (one per chat the person tried from: iMessage, SMS...).
const FIRST_MSGS_MAX = 4;

/**
 * Called only by the gate, for a brand-new 1:1 chat that sent the opt-in phrase, passed the history rule and is
 * turned away. Writes the "line was sent" record first; returns true (and leaves a one-time grant for the adapter,
 * for exactly this chat) only when this person has never been given a notice. Stores no handle, no chat id and no
 * text. `firstMessageId` is the id of the refused message when it is its chat's very first one: its salted hash is
 * kept in the same record so the history rule can recognise the chat when the person tries again.
 */
export function issueSignupNotice(db: DatabaseSync, to: { handle: string; chatId: string; kind: SignupNoticeKind; firstMessageId?: string | null }): boolean {
  if (!to.handle || !to.chatId) return false;
  const hash = signupNoticeHash(db, to.handle);
  const res = db.prepare("INSERT OR IGNORE INTO signup_notices (chatHash, kind, sentAt) VALUES (?, ?, ?)").run(hash, to.kind, Date.now());
  const isNew = Number(res.changes) === 1;
  if (to.firstMessageId) {
    const row = db.prepare("SELECT firstMsgs FROM signup_notices WHERE chatHash = ?").get(hash) as { firstMsgs: string } | undefined;
    const have = (row?.firstMsgs ?? "").split(" ").filter(Boolean);
    const msgHash = hashWith(salt(db), `msg:${to.firstMessageId}`);
    if (!have.includes(msgHash) && have.length < FIRST_MSGS_MAX) {
      db.prepare("UPDATE signup_notices SET firstMsgs = ? WHERE chatHash = ?").run([...have, msgHash].join(" "), hash);
    }
  }
  if (!isNew) return false;
  const m = grantsFor(db);
  m.set(hash, { chatId: to.chatId, kind: to.kind, at: Date.now() });
  if (m.size > 1000) m.delete(m.keys().next().value as string);
  return true;
}

/**
 * For the history rule only. True when `messageId` (a chat's earliest message, dated after go-live) is the
 * "hey troy" this person was turned away on: the chat then has no history other than its own refused opt-in, so
 * a later "hey troy" may pass. Compares salted hashes; reads no text and creates nothing.
 */
export function wasRefusedFirstMessage(db: DatabaseSync, handle: string, messageId: string): boolean {
  const saltValue = getSetting(db, SIGNUP_SALT_KEY);
  if (!saltValue || !handle || !messageId) return false;
  const row = db.prepare("SELECT firstMsgs FROM signup_notices WHERE chatHash = ?").get(hashWith(saltValue, handle)) as { firstMsgs: string } | undefined;
  return !!row && row.firstMsgs.split(" ").includes(hashWith(saltValue, `msg:${messageId}`));
}

/**
 * Called only from inside an adapter's sendSignupNotice, as the last thing before the line goes out.
 * True once per grant: Troy is on, and the gate issued exactly this kind of notice for exactly this chat.
 * `handle` is the person the chat is with, worked out by the adapter from the chat id.
 */
export function consumeSignupNotice(db: DatabaseSync, chatId: string, handle: string | null, kind: SignupNoticeKind): boolean {
  if (!isEnabled(db) || typeof chatId !== "string" || !chatId || !handle) return false;
  if (!getSetting(db, SIGNUP_SALT_KEY)) return false; // no notice was ever issued
  const m = grantsFor(db);
  const hash = signupNoticeHash(db, handle);
  const g = m.get(hash);
  if (!g || g.kind !== kind || g.chatId !== chatId) return false;
  m.delete(hash);
  return Date.now() - g.at <= GRANT_MS;
}
