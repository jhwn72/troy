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

const NUMBER_WORDS: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };

/** Dates and clock times are not phone numbers ("2026-11-13 around 3pm", "11/14", "11 14 2026"). */
const DATE_SHAPES = /\b(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}[-/.]\d{1,2}[-/.](?:19|20)?\d{2}\b|\b\d{1,2} \d{1,2} (?:19|20)\d{2}\b|\b\d{1,2}[/.]\d{1,2}\b|\b\d{1,2}:\d{2}\b/g;

/** Apps that are only ever named to be found on. */
const APPS_ALWAYS = /\b(?:insta|instagram|snapchat|whatsapp|telegram|venmo|zelle|cashapp|linkedin|wechat|kakao)\b/;
/** Apps and short names that are also ordinary words ("they snap shut", "ig" for "i guess", "on facetime when i lost them"). */
const APP = "(?:ig|sc|fb|dm|dms|tt|li|snap|gram|discord|facetime|imessage|twitter|facebook|tiktok)";
/** A token shaped like a handle: letters with a digit, underscore or dot in it ("johnw72", "john_w"). */
const HANDLE = "(?:[a-z]+\\d[a-z0-9_.]*|[a-z0-9]+[_.][a-z0-9_.]+)";

const CONTACT_PATTERNS: RegExp[] = [
  // an email, written out or spelled around the filter
  /[\w.+-]+@[\w-]+\.[a-z]{2,}/,
  /\b(?:gmail|g mail|yahoo|outlook|icloud|hotmail)\b|\busc\.edu\b|\b(?:dot|\(dot\)) ?(?:com|edu|net|org)\b|\b(?:at|\(at\)) (?:gmail|g mail|yahoo|outlook|icloud|hotmail)\b/,
  // a handle or an app to find them on
  /(?:^|[\s(:])@[a-z0-9_.]{2,}/,
  APPS_ALWAYS,
  // "my ig", "ur snap", "whats ur @"
  new RegExp(`\\b(?:my|ur|your|their|his|her)(?: \\w+)? (?:${APP}\\b|@)`),
  // "ig: johnw", "sc johnw72", "johnw72 on ig"
  new RegExp(`\\b${APP}\\s*[:@]|\\b${APP} ${HANDLE}\\b|\\b${HANDLE} on (?:the )?${APP}\\b`),
  // "add me on ig", "follow me on snap"
  new RegExp(`\\b(?:add|find|follow|message|msg|dm|hmu|reach)\\b[^.?!]{0,20}\\bon (?:the )?${APP}\\b`),
  // asking to be reached, or for what to reach them on
  /\b(?:text|dm|message|msg|hmu|hit|add|follow|airdrop|email|facetime|venmo) (?:me|us)\b|\bcall (?:me|us)\b(?! (?:a|an|the|crazy|dumb|stupid|out)\b)|\b(?:look me up|hit my line|hmu|airdrop)\b|\bfind me (?:on|at)\b/,
  /\b(?:my|ur|your|their|his|her) (?:number|#|phone number|phone #|cell|digits|email|handle|username|user|address|socials?)\b/,
  // a name is who they are: it waits for the yes like everything else
  /\b(?:ur|your|their|his|her) (?:full |first |last |real )?name\b|\bmy (?:full |first |last |real )?name(?:'?s| is) (?!on\b|in\b|inside\b|written\b|printed\b|engraved\b)/,
  // a link
  /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|edu|io|me|co|ly|ee|gg|app|link|xyz)\b|\b[a-z0-9-]+\.[a-z]{2,6}\/\S/,
  // a street address
  /\b\d{3,5}\s+(?:[a-z0-9]+\s){0,3}(?:st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|way|ct|court|ln|lane|pkwy|parkway)\b/,
  // where someone lives: an apartment or suite number, or a building and a room said as theirs
  // ("im in birnkrant 412", "knock on 312"). A classroom ("room 204 of taper hall") is just where something was lost.
  /\b(?:apt|apartment|suite|ste)\.?\s*#?\s*\d+[a-z]?\b(?!\s*(?:days?|hours?|hrs?|weeks?|wks?|mins?|minutes?|months?|years?|yrs?)\b)|\bunit\s*#\s*\d+/,
  /\b(?:i'?m|i am|i live|i stay|we'?re|come|knock|stop by|swing by|pull up|meet me|find me)\b[^.?!]{0,30}\b\d{3,4}\b/,
  /\b(?:my|our) (?:room|dorm|suite|apt|apartment|place|door)\b[^.?!]{0,20}\b\d{2,4}\b/,
];

/**
 * True when a message someone wants passed on carries a way to reach them or says who they are: a phone number
 * (digits or spelled out), an email, a handle, a link, a name, or where they live. Used where Troy passes one
 * message across before the two have agreed to share contact info (a finder's question for a claimant, and the
 * answer). Errs toward yes where it can't tell (a bare "uniqlo.com" is a link): a blocked message only costs a
 * retry. Ordinary answers to "where and when did u lose it" pass: a classroom number, a date, a street name with
 * no house number, "at usc". It is pattern based, so a bare first and last name with nothing around it gets through.
 */
export function hasContactInfo(text: string): boolean {
  let t = text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  // "j o h n at u s c dot e d u": letters spelled out one at a time are read as the word.
  t = t.replace(/\b(?:[a-z] ){2,}[a-z]\b/g, (m) => m.replace(/ /g, ""));
  if (CONTACT_PATTERNS.some((re) => re.test(t))) return true;
  // A phone number: seven or more digits however they are spaced or spelled ("two13 five55 0199"), or ten or more
  // spread across the message ("213-555 then 0199"). Dates and times are taken out first.
  const digits = t.replace(DATE_SHAPES, " ").replace(/zero|one|two|three|four|five|six|seven|eight|nine/g, (w) => NUMBER_WORDS[w]!).replace(/(\d)\s*\boh\b\s*(?=\d)/g, "$10");
  if (/(?:\+?\d[\s().-]*){7,}/.test(digits)) return true;
  return (digits.match(/\d/g) ?? []).length >= 10;
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
