// Relay mode: Troy passes messages between two people without sharing numbers or names.
// Shared by every flow. The pipeline calls relayMessage before intent detection, so while a relay is
// active everything a person texts (except commands like STOP) goes to the other person.
// A person is in at most one relay at a time. Relays end on "done" / "end", or 24 hours after they start
// (one hour for a food pickup, which is over in minutes). A relay also ends the moment either person
// switches to no_contact: nothing is forwarded to or from them after that.

import type { DatabaseSync } from "node:sqlite";
import type { FlowContext } from "./types.ts";
import { getUserById } from "./db/index.ts";

export const RELAY_TTL_MS = 24 * 60 * 60 * 1000;
/** A food relay is only for finding each other at the table. */
export const FOOD_RELAY_TTL_MS = 60 * 60 * 1000;

const ttlFor = (context: string): number => (context.startsWith("food:") ? FOOD_RELAY_TTL_MS : RELAY_TTL_MS);

export interface ActiveRelay {
  id: number;
  otherUserId: number;
  context: string;
}

export interface RelayEnd {
  id: number;
  context: string;
  userA: number;
  userB: number;
  endedBy: number;
}

type RelayRow = { id: number; userA: number; userB: number; context: string; labelA: string | null; labelB: string | null; createdAt: number };

const DEFAULT_LABEL = "the other person";
const END_WORDS = /^(?:done|end|end chat|end relay|end it|stop relay|close chat|were done|all done)$/;

/** Fixed copy. The start lines are for the flow that opens a relay to send to both people. */
export const RELAY_COPY = {
  start: ["i'll pass messages between u two right here. no numbers shared", 'just text me what u want them to know. text "done" when ur finished'],
  ended: "ok, closed that chat. they won't get ur texts anymore",
  endedOther: "the other person closed the chat. i've stopped passing messages",
  undelivered: "couldn't get that to them rn. try again in a bit",
  passed: "passed it along",
  closed: "that chat's closed now. i've stopped passing messages",
};

/** A label is a role ("the finder"), never a name, number or email. Anything that looks like one is replaced. */
function safeLabel(label: string | undefined | null): string {
  const s = (label ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 30);
  if (!s || /[@\d]/.test(s) || !/^[a-z ']+$/.test(s)) return DEFAULT_LABEL;
  return s;
}

/**
 * Open a relay between two users. `context` says what it is for ("lost_found:12"); flows use it to find
 * their relay again. `labels` are how each side is introduced to the other ("from the finder: ...").
 * Any relay either person was already in is closed first.
 */
export function startRelay(db: DatabaseSync, a: number, b: number, context: string, labels?: { a?: string; b?: string }): number {
  const now = Date.now();
  db.prepare("UPDATE relays SET status = 'ended', endedAt = ? WHERE status = 'active' AND (userA IN (?, ?) OR userB IN (?, ?))").run(now, a, b, a, b);
  const res = db
    .prepare("INSERT INTO relays (userA, userB, context, labelA, labelB, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
    .run(a, b, context, safeLabel(labels?.a), safeLabel(labels?.b), now);
  return Number(res.lastInsertRowid);
}

function activeRow(db: DatabaseSync, userId: number, now: number): RelayRow | null {
  const row = db.prepare("SELECT * FROM relays WHERE status = 'active' AND (userA = ? OR userB = ?) ORDER BY id DESC LIMIT 1").get(userId, userId) as RelayRow | undefined;
  if (!row) return null;
  if (row.createdAt + ttlFor(row.context) <= now) {
    endRelay(db, row.id);
    return null;
  }
  return row;
}

/** The relay this user is in right now, or null. An expired relay is closed here and counts as none. */
export function activeRelayFor(db: DatabaseSync, userId: number, now = Date.now()): ActiveRelay | null {
  const row = activeRow(db, userId, now);
  return row ? { id: row.id, otherUserId: row.userA === userId ? row.userB : row.userA, context: row.context } : null;
}

export function endRelay(db: DatabaseSync, id: number): void {
  db.prepare("UPDATE relays SET status = 'ended', endedAt = ? WHERE id = ? AND status = 'active'").run(Date.now(), id);
}

/** Close whatever active relay was opened with this exact context (a flow closing its own handoff). */
export function endRelayByContext(db: DatabaseSync, context: string): void {
  db.prepare("UPDATE relays SET status = 'ended', endedAt = ? WHERE context = ? AND status = 'active'").run(Date.now(), context);
}

type EndListener = (ctx: FlowContext, relay: RelayEnd) => Promise<void>;
const endListeners: { prefix: string; fn: EndListener }[] = [];

/** A flow can follow up when one of its relays is closed by "done" (not on expiry). Matched on the context prefix. */
export function onRelayEnd(prefix: string, fn: EndListener): void {
  if (!endListeners.some((l) => l.prefix === prefix)) endListeners.push({ prefix, fn });
}

function plain(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Forward this message to the other person in the user's active relay. Returns true when the message
 * was consumed (forwarded, or it closed the relay). False means there is no relay, or nothing to pass on.
 */
export async function relayMessage(ctx: FlowContext): Promise<boolean> {
  const { db, user, event } = ctx;
  if (event.reaction || event.pollVote || event.isGroup) return false;
  const row = activeRow(db, user.id, Date.now());
  if (!row) return false;

  const text = (event.text ?? "").trim();
  const images = event.images ?? [];
  if (!text && !images.length) return false;

  const otherId = row.userA === user.id ? row.userB : row.userA;

  // Contact rules are checked on every message: "don't connect me with anyone" set a minute ago still wins.
  const me = getUserById(db, user.id);
  const them = getUserById(db, otherId);
  if (me?.contactMode === "no_contact" || them?.contactMode === "no_contact") {
    endRelay(db, row.id);
    await ctx.say(RELAY_COPY.closed);
    await ctx.sayTo(otherId, RELAY_COPY.closed);
    return true;
  }

  if (!images.length && END_WORDS.test(plain(text))) {
    endRelay(db, row.id);
    await ctx.say(RELAY_COPY.ended);
    await ctx.sayTo(otherId, RELAY_COPY.endedOther);
    const info: RelayEnd = { id: row.id, context: row.context, userA: row.userA, userB: row.userB, endedBy: user.id };
    for (const l of endListeners) {
      if (!row.context.startsWith(l.prefix)) continue;
      try {
        await l.fn(ctx, info);
      } catch {
        // A flow's follow-up is optional. The relay is closed either way.
      }
    }
    return true;
  }

  const label = `from ${safeLabel(row.userA === user.id ? row.labelA : row.labelB)}:`;
  const other = getUserById(db, otherId);
  let delivered = false;
  if (other && !other.stopped) {
    if (text) {
      // Their words go across exactly as typed, whatever tone the person receiving them asked troy for.
      const ids = await ctx.sayTo(otherId, { text: `${label} ${text}`, verbatim: true });
      delivered = ids.some((id) => id !== null);
    }
    // Photos only follow when the text got through (or there was no text), so quiet hours hold for both.
    if (images.length && (delivered || !text)) {
      for (const img of images) {
        const sent = await ctx.adapter.sendImage(other.chatId, img.path, text ? undefined : label).catch(() => null);
        delivered = delivered || !!sent;
      }
    }
  }

  if (!delivered) {
    await ctx.say(RELAY_COPY.undelivered);
    return true;
  }
  // A thumbs up on their own message is the lightest "sent". A short line when tapbacks aren't available.
  let acked = false;
  if (ctx.adapter.capabilities().tapbacks) acked = await ctx.adapter.react(event.chatId, event.messageId, "like").catch(() => false);
  if (!acked) await ctx.say(RELAY_COPY.passed);
  return true;
}
