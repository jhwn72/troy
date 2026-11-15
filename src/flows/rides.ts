// Rides: "find me people going to lax". Troy asks what he needs (where, which day, roughly when), one question
// at a time, saves the trip as a listing of type "ride", and looks for other students' open trips to the same
// place on the same day within about an hour.
//
// Real matches: he offers a group chat with the contact-sharing warning, asks every matched rider the same way,
// and starts the chat only with the people who said yes (relay mode when a group chat can't be made).
// No real matches (the hackathon case): he answers the way the real thing would, with example riders whose
// number and time come from what the student asked, and RIGHT AFTER says plainly that those riders are examples.
// In example mode a yes never creates a group chat: he says what would happen and keeps the trip saved.
//
// Code decides: who matches, how many, the day and time said back, the contact rules, the warning line, and
// everything read from the directory (the USG LAX shuttle row is quoted as stored). Wording comes from the chat
// brain through inHisWords, with rotated fallback lines.
//
// Open steps (flow "rides"):
//   ask        waiting for the destination, the day or the time     data: { need, waiting, tries }
//   offer      "want a group chat to split a ride?"                 data: { listingId, mode, riders, offerId }
//   gc_ask     a matched rider is asked the same question            data: { listingId, askId }
//   sub_offer  "want a text when someone's headed ur way?"          data: { askId }

import type { DatabaseSync } from "node:sqlite";
import type { FlowContext, FlowHandler, FlowState, MessagingAdapter } from "../types.ts";
import { getFlowState, getSetting, getUserById, setFlowState, setSetting } from "../db/index.ts";
import { QUIET_TIME_ZONE } from "../quiet.ts";
import { RELAY_COPY, startRelay as realStartRelay } from "../relay.ts";
import { isBusy, onSweep, onUserGone, parkAsk, registerPendingHooks } from "../pending.ts";
import { unvoiced } from "./reports-shared.ts";
import { keepVerbatim } from "../voice.ts";
import type { Brief } from "./topics.ts";
import { inHisWords, readsYesNo, rotate } from "./topics.ts";
import { isSubscribed, subscribe, topicByKey } from "../topics.ts";
import { DECISION, aside, simulateIfAlone, simulationTurn } from "../staff.ts";

/** The contact-sharing warning. Fixed wording: a yes here is what lets a group chat show people each other's numbers. */
export const RIDE_WARNING = "heads up, that shares ur contact info. ok?";
// On the safety list: word for word in every tone, plain english included.
keepVerbatim(RIDE_WARNING);
/** Trips leaving within this many minutes of each other count as the same ride. */
export const MATCH_WINDOW_MIN = 60;
/** Riders who haven't answered the group chat question after this long count as a no. */
export const GROUP_WAIT_MS = 30 * 60 * 1000;
const STEP_STALE_MS = 30 * 60 * 1000;
const LISTING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RIDERS = 3;
/** Every step this flow opens. Any other open step under this flow is a simulation's. */
const OWN_STEPS: ReadonlySet<string> = new Set(["ask", "offer", "gc_ask", "sub_offer"]);

type StartRelay = (db: DatabaseSync, a: number, b: number, context: string, labels?: { a?: string; b?: string }) => number;
export type RidesDeps = { startRelay: StartRelay; now: () => number };
const defaults: RidesDeps = { startRelay: realStartRelay, now: () => Date.now() };
let deps: RidesDeps = { ...defaults };

/** Tests only: replace the relay opener or the clock. Null restores the real ones. (Wording is swapped through setTopicsDeps.) */
export function setRidesDeps(over: Partial<RidesDeps> | null): void {
  deps = over ? { ...deps, ...over } : { ...defaults };
}

// ---------- reading a trip ----------

export interface Need {
  /** Normalized destination ("lax", "burbank", "san diego"). */
  dest: string | null;
  /** The same day for everyone who said it any way: "2026-11-19", or the phrase when it can't be dated ("first day of break"). */
  dayKey: string | null;
  /** How Troy says the day back in a sentence: "on the 19th", "tomorrow", "on friday". */
  dayText: string | null;
  /** Minutes after midnight, or null when they only know the day. */
  minutes: number | null;
  /** "around noon", "around 2pm", "in the morning". */
  timeText: string | null;
}

const emptyNeed = (): Need => ({ dest: null, dayKey: null, dayText: null, minutes: null, timeText: null });

function flat(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[‘’'`]/g, "")
    .replace(/[^a-z0-9:/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const AIRPORTS: [RegExp, string][] = [
  [/\blax\b|\blos angeles (?:international|airport)\b/, "lax"],
  [/\bburbank\b|\bbur\b|\bbob hope\b/, "burbank"],
  [/\bjohn wayne\b|\bsna\b|\borange county airport\b/, "john wayne"],
  [/\blong beach(?: airport)?\b|\blgb\b/, "long beach"],
  [/\bontario(?: airport)?\b|\bont\b/, "ontario"],
  [/\bunion station\b/, "union station"],
];
const NOT_A_PLACE = /^(?:home|there|here|school|break|go|leave|get|split|share|find|ride|the airport|airport|a ride|somewhere|anywhere|class|work|u|me|it|be|do|see)\b/;
const WHEN_WORD = "on|at|around|by|this|next|tomorrow|tmrw|today|tonight|sunday|monday|tuesday|wednesday|thursday|friday|saturday|the \\d|in the|early|late|before|after|for|first|last|w|with|and|if|pls|please|rn";

export function destIn(text: string): string | null {
  const t = flat(text);
  for (const [re, name] of AIRPORTS) if (re.test(t)) return name;
  const m = t.match(new RegExp(`\\b(?:to|towards|for|into) (?:the )?([a-z][a-z ]{1,28}?)(?= (?:${WHEN_WORD})\\b|$)`));
  const place = m?.[1]?.trim() ?? "";
  if (!place || NOT_A_PLACE.test(place) || place.split(" ").length > 4) return null;
  return place;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const LA_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: QUIET_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const LA_DAY = new Intl.DateTimeFormat("en-US", { timeZone: QUIET_TIME_ZONE, weekday: "long" });

/** Today's date in Los Angeles as numbers. */
function laToday(now: number): { y: number; m: number; d: number; weekday: number } {
  const [y, m, d] = LA_DATE.format(new Date(now)).split("-").map(Number);
  return { y: y!, m: m!, d: d!, weekday: DAYS.indexOf(LA_DAY.format(new Date(now)).toLowerCase()) };
}

const key = (y: number, m: number, d: number): string => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;

/** The day a text names. A date gets a real key; a phrase Troy can't date ("first day of break") is kept as said. */
export function dayIn(text: string, now: number): { dayKey: string; dayText: string } | null {
  const t = flat(text);
  const today = laToday(now);

  if (/\b(?:today|tonight|rn|right now|asap)\b/.test(t)) return { dayKey: key(today.y, today.m, today.d), dayText: /\btonight\b/.test(t) ? "tonight" : "today" };
  if (/\b(?:tomorrow|tmrw|tmr)\b/.test(t)) return { dayKey: key(today.y, today.m, today.d + 1), dayText: "tomorrow" };

  const named = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* (\d{1,2})(?:st|nd|rd|th)?\b/);
  const slash = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (named || slash) {
    const month = named ? MONTHS.indexOf(named[1]!) + 1 : Number(slash![1]);
    const day = Number(named ? named[2] : slash![2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const year = month < today.m || (month === today.m && day < today.d) ? today.y + 1 : today.y;
      return { dayKey: key(year, month, day), dayText: `on ${MONTHS[month - 1]} ${day}` };
    }
  }
  const nth = t.match(/\b(?:the )?(\d{1,2})(?:st|nd|rd|th)\b/);
  if (nth) {
    const day = Number(nth[1]);
    if (day >= 1 && day <= 31) return { dayKey: key(today.y, day < today.d ? today.m + 1 : today.m, day), dayText: `on the ${ordinal(day)}` };
  }
  const weekday = t.match(/\b(next )?(sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?\b/);
  if (weekday && today.weekday !== -1) {
    const name = DAYS.find((d) => d.startsWith(weekday[2]!.slice(0, 3)))!;
    const ahead = ((DAYS.indexOf(name) - today.weekday + 7) % 7) + (weekday[1] ? 7 : 0);
    return { dayKey: key(today.y, today.m, today.d + ahead), dayText: `on ${name}` };
  }
  const phrase = t.match(/\b(?:the )?((?:first|last) day of (?:break|finals|classes|school)|(?:after|before) (?:my last final|finals|thanksgiving|graduation|commencement)|(?:thanksgiving|winter|spring|fall|summer) break|thanksgiving|this weekend|next weekend|next week)\b/);
  if (phrase) {
    const said = phrase[1]!;
    const lead = /^(?:first|last)/.test(said) ? "the " : /break$|^thanksgiving$/.test(said) ? "for " : "";
    return { dayKey: said, dayText: `${lead}${said}` };
  }
  return null;
}

/** A rough time of day. Only a time that is clearly a time counts: "2pm", "at 2", "14:30", "noon", "in the morning". */
export function timeIn(text: string): { minutes: number; timeText: string } | null {
  const t = flat(text);
  if (/\bnoon\b|\bmidday\b|\blunch ?time\b/.test(t)) return { minutes: 720, timeText: "around noon" };
  if (/\bmidnight\b/.test(t)) return { minutes: 0, timeText: "around midnight" };
  // Tried in this order so "at 2:30pm" is read whole, not as "at 2".
  const m =
    t.match(/\b(\d{1,2})(?::(\d\d))? ?(am|pm)\b/) ??
    t.match(/\b()()()(\d{1,2}):(\d\d)\b/) ??
    t.match(/\b()()()(?:at|around|by|like|about|leaving) (\d{1,2})(?![\d:/]| ?(?:st|nd|rd|th)\b)/);
  if (m) {
    const h = Number(m[1] || m[4]);
    const min = Number(m[2] || m[5] || 0);
    const half = m[3] || null;
    if (h <= 23 && min <= 59) {
      // No am or pm: hours people fly at. 7 to 11 is the morning, 12 to 6 the afternoon.
      const pm = half ? half === "pm" : h >= 12 || h <= 6;
      const hour24 = h > 12 ? h : (h % 12) + (pm ? 12 : 0);
      const shownH = hour24 % 12 === 0 ? 12 : hour24 % 12;
      const shown = hour24 === 12 && !min ? "noon" : `${shownH}${min ? `:${String(min).padStart(2, "0")}` : ""}${hour24 >= 12 ? "pm" : "am"}`;
      return { minutes: hour24 * 60 + min, timeText: `around ${shown}` };
    }
  }
  if (/\bearly (?:morning|am)\b|\bcrack of dawn\b|\bred ?eye\b/.test(t)) return { minutes: 360, timeText: "early in the morning" };
  if (/\bmorning\b/.test(t)) return { minutes: 540, timeText: "in the morning" };
  if (/\bafternoon\b/.test(t)) return { minutes: 840, timeText: "in the afternoon" };
  if (/\bevening\b/.test(t)) return { minutes: 1080, timeText: "in the evening" };
  if (/\b(?:late )?(?:night|tonight)\b/.test(t)) return { minutes: 1260, timeText: "at night" };
  return null;
}

/** Everything a text (and the details the router pulled out) says about a trip, laid over what is already known. */
function readNeed(ctx: FlowContext, base: Need, now: number): Need {
  const text = ctx.event.text ?? "";
  const d = ctx.intent.details ?? {};
  const also = [d.destination, d.place, d.day, d.date, d.time, d.window].filter((v): v is string => typeof v === "string").join(" ");
  const need = { ...base };
  need.dest = need.dest ?? destIn(text) ?? (also ? destIn(`to ${also}`) : null);
  const day = need.dayKey ? null : (dayIn(text, now) ?? (also ? dayIn(also, now) : null));
  if (day) Object.assign(need, day);
  const time = need.minutes !== null ? null : (timeIn(text) ?? (also ? timeIn(also) : null));
  if (time) Object.assign(need, time);
  return need;
}

// ---------- listings ----------

type Row = Record<string, unknown>;

interface Group {
  asked: number[];
  yes: number[];
  no: number[];
  askedAt: number;
}

interface Trip {
  id: number;
  userId: number;
  need: Need;
  group: Group | null;
  status: string;
  createdAt: number;
}

function toTrip(r: Row): Trip {
  let details: Record<string, unknown> = {};
  try {
    const v = JSON.parse((r.details as string) || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) details = v as Record<string, unknown>;
  } catch {
    // An unreadable row matches nothing.
  }
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  const g = details.group as Partial<Group> | undefined;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);
  return {
    id: r.id as number,
    userId: r.userId as number,
    need: { dest: s(details.dest), dayKey: s(details.dayKey), dayText: s(details.dayText), minutes: typeof details.minutes === "number" ? details.minutes : null, timeText: s(details.timeText) },
    group: g && typeof g === "object" ? { asked: ids(g.asked), yes: ids(g.yes), no: ids(g.no), askedAt: typeof g.askedAt === "number" ? g.askedAt : 0 } : null,
    status: r.status as string,
    createdAt: r.createdAt as number,
  };
}

function getTrip(db: DatabaseSync, id: number): Trip | null {
  const r = db.prepare("SELECT * FROM listings WHERE id = ? AND type = 'ride'").get(id) as Row | undefined;
  return r ? toTrip(r) : null;
}

function saveTrip(db: DatabaseSync, trip: Trip): void {
  db.prepare("UPDATE listings SET details = ?, status = ? WHERE id = ?").run(JSON.stringify({ ...trip.need, ...(trip.group ? { group: trip.group } : {}) }), trip.status, trip.id);
}

/** Save the trip as a listing of type "ride". Asking again for the same place and day updates the one they have. */
function saveListing(db: DatabaseSync, userId: number, need: Need, now: number): number {
  const mine = (db.prepare("SELECT * FROM listings WHERE userId = ? AND type = 'ride' AND status = 'open' AND isExample = 0 ORDER BY id DESC").all(userId) as Row[]).map(toTrip);
  const same = mine.find((t) => t.need.dest === need.dest && t.need.dayKey === need.dayKey);
  if (same) {
    saveTrip(db, { ...same, need, group: null });
    return same.id;
  }
  const res = db
    .prepare("INSERT INTO listings (userId, type, category, title, details, locationText, status, createdAt) VALUES (?, 'ride', 'ride', ?, ?, ?, 'open', ?)")
    .run(userId, `ride to ${need.dest}`, JSON.stringify(need), need.dest, now);
  return Number(res.lastInsertRowid);
}

/** Other students' open trips to the same place on the same day, leaving within about an hour. Real people only. */
export function findRideMatches(db: DatabaseSync, userId: number, need: Need, now: number): { listingId: number; userId: number }[] {
  if (!need.dest || !need.dayKey) return [];
  const rows = db
    .prepare(
      "SELECT l.* FROM listings l JOIN users u ON u.id = l.userId WHERE l.type = 'ride' AND l.status = 'open' AND l.isExample = 0 AND l.userId != ? AND l.createdAt > ? AND u.stopped = 0 AND u.isExample = 0 AND u.verifiedAt IS NOT NULL AND u.contactMode != 'no_contact' ORDER BY l.id",
    )
    .all(userId, now - LISTING_MAX_AGE_MS) as Row[];
  const out: { listingId: number; userId: number }[] = [];
  for (const t of rows.map(toTrip)) {
    if (t.need.dest !== need.dest || t.need.dayKey !== need.dayKey) continue;
    // Someone who only knows the day matches anyone that day; two known times must be within the window.
    if (need.minutes !== null && t.need.minutes !== null && Math.abs(need.minutes - t.need.minutes) > MATCH_WINDOW_MIN) continue;
    if (!out.some((o) => o.userId === t.userId)) out.push({ listingId: t.id, userId: t.userId });
  }
  return out.slice(0, MAX_RIDERS);
}

/** How many example riders to show: two to four, always the same for the same trip. */
export function exampleRiderCount(need: Need): number {
  const seed = `${need.dest}|${need.dayKey}|${need.minutes ?? ""}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return 2 + (h % 3);
}

// ---------- wording ----------

const trojans = (n: number) => `${n} ${n === 1 ? "trojan" : "trojans"}`;
const tripWords = (need: Need): string => [need.dest, need.dayText, need.timeText].filter(Boolean).join(" ");

const BRIEFS = {
  askDest: (): Brief => ({
    goal: "they want to find people to share a ride with but didn't say where to. ask where they're headed, one short question",
    mustCover: ["where they're headed"],
    fallback: [[`i got u. where are u headed?`], [`on it 👀 where to?`], [`for sure. where u trying to go?`], [`bet. what's the destination?`]],
  }),
  askDay: (dest: string): Brief => ({
    goal: `they want to share a ride to ${dest}. ask which day they're leaving, one short question`,
    mustCover: ["which day they're leaving"],
    fallback: [[`which day are u leaving?`], [`what day are u heading out?`], [`nice. what day?`], [`got it. which day u leaving?`]],
  }),
  askTime: (): Brief => ({
    goal: "they want to share a ride and gave the day. ask roughly what time they're leaving, one short question. rough is fine",
    mustCover: ["roughly what time they're leaving"],
    fallback: [[`around what time? rough is fine`], [`what time are u thinking, roughly?`], [`morning, afternoon, night? a rough time works`], [`roughly when are u heading out?`]],
  }),
  whyAsk: (waiting: string): Brief => ({
    goal: `they asked something instead of answering. troy needs ${waiting} to match them with people leaving around the same time. answer briefly, then ask for it again`,
    mustCover: ["he matches people going to the same place around the same time", waiting],
    fallback: [
      [`i match u with people headed the same way around the same time, so i need ${waiting}`],
      [`so i can find trojans leaving when u are. what's ${waiting}?`],
      [`just to line u up with people on the same trip. ${waiting}?`],
    ],
  }),
  found: (f: { count: number; need: Need }): Brief => {
    const where = tripWords(f.need);
    const facts: Record<string, string> = { count: trojans(f.count) };
    if (f.need.dest) facts.dest = f.need.dest;
    if (f.need.dayText) facts.day = f.need.dayText;
    if (f.need.timeText) facts.time = f.need.timeText;
    return {
      goal: "code found people leaving for the same place on the same day around the same time. tell them and ask if they want a group chat to split a ride",
      mustCover: [`how many: ${trojans(f.count)}`, `the trip: leaving for ${where}`, "the question: do they want a group chat to split a ride"],
      facts,
      fallback: [
        [`found ${trojans(f.count)} leaving for ${where}. want a group chat to split a ride?`],
        [`i've got ${trojans(f.count)} headed to ${where}. want me to start a group chat so u can split a ride?`],
        [`${trojans(f.count)} ${f.count === 1 ? "is" : "are"} leaving for ${where} too. should i set up a group chat to split a ride?`],
      ],
    };
  },
  exampleNote: (): Brief => ({
    goal: "the riders troy just mentioned are not real people: this is a hackathon build and there aren't enough students on it yet. say that plainly, right away, in one bubble",
    mustCover: ["those riders are examples for the hackathon, not real people", "with more trojans on here it's a real match"],
    facts: { examples: "examples", hackathon: "hackathon" },
    fallback: [
      [`(heads up: those riders are examples for the hackathon. with more trojans on here this is a real match)`],
      [`(real talk: those riders are examples, this is a hackathon build. once more trojans are on here that's a real match)`],
      [`(being straight with u: those are examples for the hackathon, not real riders yet. more trojans on here makes it real)`],
    ],
  }),
  exampleYes: (need: Need): Brief => ({
    goal: "they said yes to a group chat, but the riders were examples, so no group chat is being created. say what would happen in the real thing, and that their trip is saved",
    mustCover: [
      "no group chat is being made, because those riders were examples",
      "in the real thing he asks each rider first, since a group chat shares contact info, and starts the chat once everyone says yes",
      "their trip is saved, and he'll text them if a real trojan posts the same trip",
    ],
    facts: need.dest ? { dest: need.dest } : {},
    fallback: [
      [`since those were examples, there's no chat to start yet`, `in the real thing i ask each rider first (a group chat shares contact info), then start it once everyone says yes`, `ur ${need.dest} trip is saved tho. if a real trojan posts the same one i'll text u`],
      [`no group chat this time, those riders were examples`, `for real ones i'd check with each of them first since it shares contact info, then make the chat when everyone's in`, `i saved ur ${need.dest} trip, so i'll hit u up if a real match comes in`],
      [`can't start one with example riders`, `how it really goes: i ask everyone first because a group chat shares numbers, then i start it when they all say yes`, `ur ${need.dest} trip stays saved and i'll text u when a real trojan is headed the same way`],
    ],
  }),
  exampleNo: (need: Need): Brief => ({
    goal: "they said no to a group chat. acknowledge, and say their trip is saved in case a real match comes in",
    mustCover: ["no problem", "their trip is saved and he'll text them if a real trojan posts the same trip"],
    facts: need.dest ? { dest: need.dest } : {},
    fallback: [[`no worries. ur ${need.dest} trip is saved, i'll text u if a real one comes up`], [`all good. i'll keep ur ${need.dest} trip and lmk if someone real matches`], [`ok. ur ${need.dest} trip stays on file, i'll hit u up if a real trojan is headed that way`]],
  }),
  askingRiders: (count: number): Brief => ({
    goal: "they said yes to a group chat with real matched riders. code is now asking each of those riders the same question",
    mustCover: [`he's asking the ${count === 1 ? "other rider" : "other riders"} now`, "the group chat starts once they say yes"],
    fallback: [
      [`bet, asking ${count === 1 ? "them" : "the others"} now`, `once ${count === 1 ? "they say" : "everyone says"} yes i'll start the chat`],
      [`on it 👀 checking with ${count === 1 ? "them" : "the others"}`, `i'll start the group chat as soon as ${count === 1 ? "they're" : "they're all"} in`],
      [`nice, lemme ask ${count === 1 ? "them" : "the others"}`, `the chat goes up when ${count === 1 ? "they say" : "everyone says"} yes`],
    ],
  }),
  declinedOffer: (need: Need): Brief => ({
    goal: "they said no to a group chat with the matched riders. acknowledge; their trip stays saved",
    mustCover: ["no problem", "their trip stays saved"],
    facts: need.dest ? { dest: need.dest } : {},
    fallback: [[`no worries, ur ${need.dest} trip stays saved`], [`all good. i'll keep ur ${need.dest} trip on file`], [`ok, leaving ur ${need.dest} trip up in case u change ur mind`]],
  }),
  riderYesWaiting: (): Brief => ({
    goal: "they said yes to a group chat for a shared ride. others still have to answer",
    mustCover: ["they're in", "he's waiting on the others and starts the chat when everyone has answered"],
    fallback: [[`bet, ur in. waiting on the others, then i'll start the chat`], [`got u down. i'll start the chat once everyone's answered`], [`nice. just waiting on the rest, then the chat goes up`]],
  }),
  riderNo: (): Brief => ({
    goal: "they said no to a group chat for a shared ride. acknowledge; their own trip stays saved",
    mustCover: ["no problem", "their own trip stays saved"],
    fallback: [[`no worries, i'll leave u out of this one. ur trip stays saved`], [`all good, skipping u on this one. ur trip's still up`], [`ok, not adding u. i'll keep ur trip on file`]],
  }),
  subOffer: (): Brief => ({
    goal: "they just looked for a ride. offer, once, to text them when someone's headed the same way as them. one short question",
    mustCover: ["does he want a text when someone's headed the same way as them"],
    fallback: [[`want me to text u when someone's headed the same way as u?`], [`should i hit u up whenever someone's going the same way as u?`], [`want a heads up when another trojan is headed ur way?`]],
  }),
  subYes: (): Brief => ({
    goal: "they said yes to ride texts and code signed them up. confirm in one short bubble",
    mustCover: ["he'll text them when someone's headed the same way as them"],
    fallback: [[`bet, i'll text u when someone's headed the same way as u`], [`done. i'll hit u up when someone's going ur way`], [`got u, i'll lmk when another trojan is headed ur direction`]],
  }),
  subNo: (): Brief => ({
    goal: "they said no to ride texts. acknowledge, short",
    mustCover: ["no problem"],
    fallback: [[`no worries`], [`all good`], [`ok, i'll leave it`]],
  }),
  dropped: (): Brief => ({
    goal: "they backed out of looking for a ride. acknowledge, short",
    mustCover: ["nothing was saved"],
    fallback: [[`no worries, dropped it`], [`all good, i'll leave it`], [`ok, nvm on the ride`]],
  }),
  cancelled: (need: Need): Brief => ({
    goal: "they don't need the ride anymore and code closed their saved trip. confirm, short",
    mustCover: ["their saved trip is closed, nobody will be matched with it"],
    facts: need.dest ? { dest: need.dest } : {},
    fallback: [[`done, closed ur ${need.dest} trip`], [`got it, ur ${need.dest} trip is off the list`], [`ok, took ur ${need.dest} trip down`]],
  }),
  nothingSaved: (): Brief => ({
    goal: "they asked to cancel a ride but have no trip saved. say so, short",
    mustCover: ["they don't have a trip saved right now"],
    fallback: [[`u don't have a trip saved rn`], [`nothing saved for u rn, ur good`], [`there's no trip of urs on file rn`]],
  }),
};

/** Lines for people other than the one texting. Code only, rotated per person. */
const OTHER = {
  riderAsk: (need: Need) => [
    [`found another trojan leaving for ${tripWords(need)}. want a group chat to split a ride?`],
    [`someone else is headed to ${tripWords(need)} too. want me to put u in a group chat to split a ride?`],
    [`got a match for ur ${need.dest} trip, leaving ${[need.dayText, need.timeText].filter(Boolean).join(" ")}. want a group chat to split a ride?`],
  ],
  groupStarted: [[`everyone's in, so i started the group chat. i'm stepping back, safe travels`], [`ur group chat is up, everyone said yes. i'll step back now. safe travels`], [`started the chat with everyone who's in. it's all urs from here, safe travels`]],
  nobody: (dest: string) => [[`nobody's in on a group chat this time. ur ${dest} trip stays saved`], [`no takers on the group chat rn. i'm keeping ur ${dest} trip up`], [`they passed this time. ur ${dest} trip is still on file`]],
  relayed: [[`couldn't make a group chat, so i'll connect u two through me instead`], [`a group chat didn't work out, so u two can talk through me`], [`no group chat on my end rn. connecting u two right here instead`]],
  leftOut: [[`couldn't get a group chat going with everyone rn, sorry. ur trip stays saved`], [`the group chat didn't come together this time, sorry. ur trip's still up`], [`i couldn't set up the chat for everyone rn, sorry. keeping ur trip on file`]],
};

async function say(ctx: FlowContext, k: string, brief: Brief): Promise<(string | null)[]> {
  return ctx.say(...(await inHisWords(ctx, `rides.${k}`, brief)));
}

/** The USG LAX shuttle, quoted from the directory exactly as stored. Nothing when the row isn't there. */
function shuttleLine(db: DatabaseSync): string | null {
  const row = db
    .prepare("SELECT details FROM directory WHERE kind = 'usg_program' AND (lower(name) LIKE '%lax shuttle%' OR (lower(name) LIKE '%shuttle%' AND lower(topics) LIKE '%lax%')) ORDER BY id LIMIT 1")
    .get() as { details: string | null } | undefined;
  return row?.details?.trim() || null;
}

// ---------- the conversation ----------

async function askNext(ctx: FlowContext, need: Need, tries: number): Promise<void> {
  const waiting = !need.dest ? "dest" : !need.dayKey ? "day" : "time";
  ctx.setState({ flow: "rides", step: "ask", data: { need, waiting, tries } });
  if (waiting === "dest") await say(ctx, "askDest", BRIEFS.askDest());
  else if (waiting === "day") await say(ctx, "askDay", BRIEFS.askDay(need.dest!));
  else await say(ctx, "askTime", BRIEFS.askTime());
}

async function offer(ctx: FlowContext, need: Need): Promise<void> {
  const { db, user } = ctx;
  const now = deps.now();
  const listingId = saveListing(db, user.id, need, now);
  const matches = findRideMatches(db, user.id, need, now);

  // The shuttle USG runs is always worth knowing about for lax, with only what the directory says.
  const shuttle = need.dest === "lax" ? shuttleLine(db) : null;
  if (shuttle) await ctx.say(shuttle);

  if (matches.length) {
    await say(ctx, "found", BRIEFS.found({ count: matches.length, need }));
    const ids = await ctx.say(RIDE_WARNING);
    ctx.setState({ flow: "rides", step: "offer", data: { listingId, mode: "real", riders: matches.map((m) => m.listingId), offerId: ids[0] ?? null } });
    await aside(ctx, {
      step: "rides_match",
      behind: { did: "matched ur trip against other students' open trips, same place and day and leaving within {windowMinutes} minutes, and found {riders}", numbers: { riders: matches.length, windowMinutes: MATCH_WINDOW_MIN } },
      decision: DECISION.oneEngine,
    });
    return;
  }
  // Nobody real yet. A judge, or a student with no other student on here at all, is offered the other riders'
  // side played out by the same engine every flow uses; it says plainly that nobody else is on right now.
  const examples = exampleRiderCount(need);
  // The engine joins day and time with "around", so "around noon" goes in as "noon" and "in the morning" rides with the day.
  const around = need.timeText?.startsWith("around ") ? need.timeText.slice(7) : "";
  const context: Record<string, string> = { dest: need.dest ?? "", day: [need.dayText, around ? "" : need.timeText].filter(Boolean).join(" "), time: around, riders: String(examples), listingId: String(listingId) };
  if (await simulateIfAlone(ctx, "rides", context)) return;
  // Otherwise the answer looks like the real thing, and the very next bubble says those riders are examples.
  const ids = await say(ctx, "found", BRIEFS.found({ count: examples, need }));
  await say(ctx, "exampleNote", BRIEFS.exampleNote());
  ctx.setState({ flow: "rides", step: "offer", data: { listingId, mode: "example", riders: [], offerId: ids[ids.length - 1] ?? null } });
  await aside(ctx, {
    step: "rides_example",
    behind: { did: "saved ur trip and looked for real ones to the same place that day. found {realMatches}, so those {exampleRiders} riders are examples", numbers: { realMatches: 0, exampleRiders: examples } },
    decision: DECISION.oneEngine,
  });
}

/** After the ride question is settled: one offer, ever, to follow the rides topic. */
async function maybeOfferTopic(ctx: FlowContext): Promise<void> {
  const { db, user } = ctx;
  const topic = topicByKey(db, "rides");
  const slot = `rides_topic_offered:${user.id}`;
  if (!topic || isSubscribed(db, user.id, topic) || getSetting(db, slot)) return;
  setSetting(db, slot, "1");
  const ids = await say(ctx, "subOffer", BRIEFS.subOffer());
  ctx.setState({ flow: "rides", step: "sub_offer", data: { askId: ids[ids.length - 1] ?? null } });
}

type Tell = (userId: number, bubbles: string[]) => Promise<unknown>;

/** Ask every matched rider the same question, with the same warning. Their yes is theirs to give. */
async function askRiders(ctx: FlowContext, trip: Trip, riderListings: number[]): Promise<number> {
  const { db } = ctx;
  const now = deps.now();
  const asked: number[] = [];
  for (const id of riderListings) {
    const theirs = getTrip(db, id);
    const rider = theirs ? getUserById(db, theirs.userId) : null;
    if (!theirs || theirs.status !== "open" || !rider || rider.stopped || rider.contactMode === "no_contact") continue;
    const bubbles = [...rotate(db, rider.id, "rides.riderAsk", OTHER.riderAsk(theirs.need)), RIDE_WARNING];
    const step = { flow: "rides" as const, step: "gc_ask", data: { listingId: trip.id } as Record<string, unknown> };
    const open = getFlowState(db, rider.id);
    // An alert pointer ("react if u want one") isn't a conversation; a real open step is, and the question waits behind it.
    if (open && open.step !== "alerted" && isBusy(db, rider.id, now)) {
      parkAsk(db, rider.id, step, bubbles);
    } else {
      // Owed: it answers the trip they asked Troy to match.
      const ids = await ctx.sayToOwed(rider.id, ...bubbles.map((text) => ({ text })));
      if (!ids.some((x) => x !== null)) continue;
      ctx.setStateFor(rider.id, { ...step, data: { ...step.data, askId: ids[ids.length - 1] ?? null } });
    }
    asked.push(rider.id);
  }
  saveTrip(db, { ...trip, status: asked.length ? "matched" : "open", group: asked.length ? { asked, yes: [], no: [], askedAt: now } : null });
  return asked.length;
}

/**
 * Everyone asked has answered (or ran out of time). The people who said yes and the requester get a group chat
 * when every one of them allows it and the provider can make one; two people fall back to relay mode.
 */
async function finishGroup(db: DatabaseSync, adapter: MessagingAdapter, trip: Trip, tell: Tell): Promise<void> {
  const group = trip.group;
  if (!group) return;
  const requester = getUserById(db, trip.userId);
  const yes = group.yes.map((id) => getUserById(db, id)).filter((u): u is NonNullable<typeof u> => !!u && !u.stopped && u.contactMode !== "no_contact");
  const dest = trip.need.dest ?? "ride";
  if (!requester || requester.stopped || requester.contactMode === "no_contact" || !yes.length) {
    saveTrip(db, { ...trip, status: "open", group: null });
    if (requester && !requester.stopped) await tell(requester.id, rotate(db, requester.id, "rides.nobody", OTHER.nobody(dest)));
    return;
  }
  const members = [requester, ...yes];
  const closeListings = () => {
    for (const m of members) db.prepare("UPDATE listings SET status = 'handed_off' WHERE userId = ? AND type = 'ride' AND status IN ('open','matched') AND json_extract(details, '$.dest') = ? AND json_extract(details, '$.dayKey') = ?").run(m.id, trip.need.dest, trip.need.dayKey);
  };

  // Contact rules in code: a group chat only with people who all share contact directly and allow group chats.
  const allAllow = members.every((m) => m.contactMode === "direct" && m.groupChatsAllowed);
  if (allAllow && adapter.capabilities().groupChats) {
    const first = `hey, troy here. ur all leaving for ${tripWords(trip.need)}. i'll step back so u can split a ride`;
    const chatId = await adapter.createGroupChat(members.map((m) => m.handle), first).catch(() => null);
    if (chatId) {
      db.prepare("INSERT OR IGNORE INTO allow_list (handle, chatId, reason, addedAt) VALUES (NULL, ?, 'troy_group', ?)").run(chatId, Date.now());
      closeListings();
      for (const m of members) await tell(m.id, rotate(db, m.id, "rides.groupStarted", OTHER.groupStarted));
      return;
    }
  }
  // No group chat: the requester and the first yes talk through Troy, numbers never shared.
  const other = yes[0]!;
  try {
    for (const id of [requester.id, other.id]) {
      const s = getFlowState(db, id);
      if (s?.flow === "rides") setFlowState(db, id, null);
    }
    deps.startRelay(db, requester.id, other.id, `rides:${trip.id}`, { a: "the other rider", b: "the other rider" });
    closeListings();
    for (const m of [requester, other]) await tell(m.id, [...rotate(db, m.id, "rides.relayed", OTHER.relayed), ...RELAY_COPY.start]);
  } catch {
    saveTrip(db, { ...trip, status: "open", group: null });
    for (const m of [requester, other]) await tell(m.id, rotate(db, m.id, "rides.leftOut", OTHER.leftOut));
  }
  for (const m of yes.slice(1)) await tell(m.id, rotate(db, m.id, "rides.leftOut", OTHER.leftOut));
}

async function answerOffer(ctx: FlowContext, state: FlowState, yes: boolean): Promise<void> {
  const { db } = ctx;
  const trip = getTrip(db, state.data.listingId as number);
  ctx.setState(null);
  if (!trip) return;
  if (state.data.mode !== "real") {
    // Example riders: nothing is created, whatever they answer.
    await say(ctx, yes ? "exampleYes" : "exampleNo", yes ? BRIEFS.exampleYes(trip.need) : BRIEFS.exampleNo(trip.need));
    await maybeOfferTopic(ctx);
    if (yes) await aside(ctx, { step: "rides_example_yes", decision: DECISION.contactAfterBothYes });
    return;
  }
  if (!yes) {
    await say(ctx, "declinedOffer", BRIEFS.declinedOffer(trip.need));
    await maybeOfferTopic(ctx);
    return;
  }
  const riders = Array.isArray(state.data.riders) ? state.data.riders.filter((x): x is number => typeof x === "number") : [];
  const asked = await askRiders(ctx, trip, riders);
  if (!asked) {
    await ctx.say(...rotate(db, ctx.user.id, "rides.nobody", OTHER.nobody(trip.need.dest ?? "ride")));
    return;
  }
  await say(ctx, "askingRiders", BRIEFS.askingRiders(asked));
  await aside(ctx, {
    step: "rides_asking",
    behind: { did: "asked each matched rider, {ridersAsked} in all, the same question with the same warning. nobody's number is shared until they say yes", numbers: { ridersAsked: asked } },
    decision: DECISION.contactAfterBothYes,
  });
}

async function answerGroupAsk(ctx: FlowContext, state: FlowState, yes: boolean): Promise<void> {
  const { db, user } = ctx;
  ctx.setState(null);
  const trip = getTrip(db, state.data.listingId as number);
  const group = trip?.group;
  if (!trip || !group || !group.asked.includes(user.id) || group.yes.includes(user.id) || group.no.includes(user.id)) {
    if (!yes) await say(ctx, "riderNo", BRIEFS.riderNo());
    return;
  }
  (yes ? group.yes : group.no).push(user.id);
  saveTrip(db, trip);
  const done = group.asked.every((id) => group.yes.includes(id) || group.no.includes(id));
  if (!yes) await say(ctx, "riderNo", BRIEFS.riderNo());
  else if (!done) await say(ctx, "riderYesWaiting", BRIEFS.riderYesWaiting());
  if (done) await finishGroup(db, ctx.adapter, trip, (id, bubbles) => (id === user.id ? ctx.say(...bubbles) : ctx.sayToOwed(id, ...bubbles.map((text) => ({ text })))));
}

const CANCEL = /^(?:(?:actually|wait|oh|ah|sorry|lol|nah|no)[ ,]+)*(?:nvm|nevermind|never mind|cancel|cancel it|cancel that|forget it|forget that|scratch that)\b/;
const NO_LONGER = /\b(?:cancel|delete|remove|close|drop) (?:my|the|that) (?:ride|trip|request)\b|\b(?:dont|do not|no longer) need (?:a|the|that) ride\b|\b(?:found|got) (?:a|my) ride\b|\bnvm (?:the|my|on the) ride\b/;
const QUESTION = /\?\s*$|^(?:why|what|how|who|wait what|huh)\b/;

async function passOn(ctx: FlowContext, clear: boolean): Promise<void> {
  if (clear && ctx.state?.flow === "rides") ctx.setState(null);
  const { getFlow } = await import("./index.ts");
  const named = ctx.intent.flow !== "rides" ? getFlow(ctx.intent.flow) : null;
  const target = named ?? getFlow("smalltalk");
  if (!target || target.name === "rides") return;
  const intent = named ? ctx.intent : { flow: "smalltalk" as const, action: "chat", details: ctx.intent.details, source: ctx.intent.source };
  await target.handle({ ...unvoiced(ctx), intent, state: ctx.state && ctx.state.flow !== "rides" ? ctx.state : null });
}

const startsElsewhere = (ctx: FlowContext) => ctx.intent.source === "ai" && ctx.intent.flow !== "rides" && ctx.intent.flow !== "smalltalk" && ctx.intent.flow !== "onboarding";

export const rides: FlowHandler = {
  name: "rides",
  async handle(ctx) {
    const { db, user } = ctx;
    const now = deps.now();
    // An open simulation (the other riders' side, played out) gets the message first, taps included.
    if (await simulationTurn(ctx, OWN_STEPS)) return;
    let state = ctx.state?.flow === "rides" ? ctx.state : null;
    if (state && state.step !== "gc_ask" && now - state.updatedAt > STEP_STALE_MS) {
      ctx.setState(null);
      state = null;
    }
    if (ctx.event.pollVote) return;

    // A thumbs up counts as yes only on the question itself: the contact warning, or the last bubble of an offer.
    if (ctx.event.reaction) {
      const r = ctx.event.reaction;
      if (r.removed || !state) return;
      const yes = r.type === "love" || r.type === "like";
      if (!yes && r.type !== "dislike") return;
      const target = state.data.offerId ?? state.data.askId ?? state.data.qid;
      if (!target || target !== r.targetMessageId) return;
      if (state.step === "offer") await answerOffer(ctx, state, yes);
      else if (state.step === "gc_ask") await answerGroupAsk(ctx, state, yes);
      else if (state.step === "sub_offer") await answerSub(ctx, yes);
      return;
    }

    const text = (ctx.event.text ?? "").trim();
    const w = flat(text);
    const answer = readsYesNo(text);

    if (state?.step === "gc_ask" && answer) {
      await answerGroupAsk(ctx, state, answer === "yes");
      return;
    }
    if (state?.step === "offer" && answer) {
      await answerOffer(ctx, state, answer === "yes");
      return;
    }
    if (state?.step === "sub_offer") {
      if (answer) {
        await answerSub(ctx, answer === "yes");
        return;
      }
      // Anything else isn't an answer to an optional question: it goes on as a normal message.
      ctx.setState(null);
      state = null;
    }
    if (state && CANCEL.test(w)) {
      ctx.setState(null);
      await say(ctx, "dropped", BRIEFS.dropped());
      return;
    }
    if (NO_LONGER.test(w) || (ctx.intent.flow === "rides" && ctx.intent.action === "cancel")) {
      const mine = (db.prepare("SELECT * FROM listings WHERE userId = ? AND type = 'ride' AND status IN ('open','matched') ORDER BY id DESC LIMIT 1").all(user.id) as Row[]).map(toTrip)[0];
      if (state) ctx.setState(null);
      if (!mine) {
        await say(ctx, "nothingSaved", BRIEFS.nothingSaved());
        return;
      }
      db.prepare("UPDATE listings SET status = 'expired' WHERE id = ?").run(mine.id);
      await say(ctx, "cancelled", BRIEFS.cancelled(mine.need));
      return;
    }
    if (startsElsewhere(ctx)) {
      await passOn(ctx, state?.step === "ask");
      return;
    }

    if (state?.step === "ask") {
      const before = state.data.need as Need;
      const waiting = String(state.data.waiting);
      const tries = typeof state.data.tries === "number" ? state.data.tries : 0;
      const need = readNeed(ctx, before, now);
      const got = waiting === "dest" ? !!need.dest : waiting === "day" ? !!need.dayKey : need.minutes !== null;
      if (!got) {
        if (QUESTION.test(text.toLowerCase()) && tries < 2) {
          const what = waiting === "dest" ? "where ur headed" : waiting === "day" ? "the day ur leaving" : "a rough time";
          ctx.setState({ flow: "rides", step: "ask", data: { need, waiting, tries: tries + 1 } });
          await say(ctx, "whyAsk", BRIEFS.whyAsk(what));
          return;
        }
        // Their own words are good enough: a place Troy doesn't know, a day he can't date, or no time at all.
        const said = w.replace(/^(?:to|on|at|around|its|it is|im going to|going to|headed to|idk|not sure|maybe|probably|like)\s+/, "").slice(0, 30).trim();
        const vague = !said || /^(?:idk|not sure|dunno|no idea|whenever|anytime|any time|doesnt matter|flexible)$/.test(said);
        if (waiting === "time") {
          need.minutes = null;
          need.timeText = null;
          await offer(ctx, need);
          return;
        }
        if (vague && tries < 1) {
          ctx.setState({ flow: "rides", step: "ask", data: { need, waiting, tries: tries + 1 } });
          await say(ctx, waiting === "dest" ? "askDest" : "askDay", waiting === "dest" ? BRIEFS.askDest() : BRIEFS.askDay(need.dest ?? "there"));
          return;
        }
        if (vague) {
          ctx.setState(null);
          await say(ctx, "dropped", BRIEFS.dropped());
          return;
        }
        if (waiting === "dest") need.dest = said;
        else Object.assign(need, { dayKey: said, dayText: said });
      }
      if (!need.dest || !need.dayKey || (need.minutes === null && waiting !== "time")) {
        await askNext(ctx, need, 0);
        return;
      }
      await offer(ctx, need);
      return;
    }

    // A new request (or one the router sent here).
    const need = readNeed(ctx, emptyNeed(), now);
    const mine = ctx.intent.flow === "rides";
    if (!mine && !need.dest && !/\b(?:rides?|carpool|uber|lyft)\b/.test(w)) {
      await passOn(ctx, false);
      return;
    }
    if (!need.dest || !need.dayKey || need.minutes === null) {
      await askNext(ctx, need, 0);
      return;
    }
    await offer(ctx, need);
  },
};

async function answerSub(ctx: FlowContext, yes: boolean): Promise<void> {
  ctx.setState(null);
  const topic = topicByKey(ctx.db, "rides");
  if (yes && topic) {
    subscribe(ctx.db, ctx.user.id, topic.id);
    await say(ctx, "subYes", BRIEFS.subYes());
    return;
  }
  await say(ctx, "subNo", BRIEFS.subNo());
}

// ---------- timers, people leaving, questions that wait ----------

/** Group chat questions nobody answered in time count as a no, so the people who did answer aren't left waiting. */
export async function sweepRides(db: DatabaseSync, adapter: MessagingAdapter, now: number, tell: Tell): Promise<number> {
  const waiting = (db.prepare("SELECT * FROM listings WHERE type = 'ride' AND status = 'matched'").all() as Row[]).map(toTrip);
  let closed = 0;
  for (const trip of waiting) {
    const g = trip.group;
    if (!g || now - g.askedAt < GROUP_WAIT_MS) continue;
    for (const id of g.asked) {
      if (g.yes.includes(id) || g.no.includes(id)) continue;
      g.no.push(id);
      const s = getFlowState(db, id);
      if (s?.flow === "rides" && s.step === "gc_ask" && s.data.listingId === trip.id) setFlowState(db, id, null);
    }
    saveTrip(db, trip);
    await finishGroup(db, adapter, trip, tell);
    closed++;
  }
  return closed;
}

onSweep("rides", async (io, now) => {
  await sweepRides(io.db, io.adapter, now, (id, bubbles) => io.sayTo(id, ...bubbles));
});

onUserGone("rides", async (io, userId) => {
  io.db.prepare("UPDATE listings SET status = 'expired' WHERE userId = ? AND type = 'ride' AND status IN ('open','matched')").run(userId);
});

registerPendingHooks("rides", {
  // A rider's yes or no to the contact warning must land on that question.
  protects: (_db, state) => state.step === "gc_ask",
  valid: (db, state) => {
    if (state.step !== "gc_ask") return true;
    const trip = typeof state.data.listingId === "number" ? getTrip(db, state.data.listingId) : null;
    return !!trip && trip.status === "matched";
  },
  reprompt: (db, state) => {
    if (state.step !== "gc_ask") return [];
    const trip = typeof state.data.listingId === "number" ? getTrip(db, state.data.listingId) : null;
    return trip ? [...OTHER.riderAsk(trip.need)[0]!, RIDE_WARNING] : [];
  },
});
